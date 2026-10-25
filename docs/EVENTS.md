# Apex Events — callbacks, webhooks, subscriptions and `tools.run`

> **OpenCode V2 only (≥ 2.1).** apex is built on the V2 plugin runtime; it does not load in
> OpenCode V1.

The events module lets something **outside** a conversation wake an agent up: a cron job
that detects a failure, a CI pipeline that finished, a webhook from GitHub. It also lets
those outside processes **run OpenCode tools** (including MCP tools) without a model.

## Concepts (read this first)

| Term | What it means here |
| --- | --- |
| **OpenCode server** | The process that runs your agents (`opencode serve`, or the background service the desktop app/TUI starts). It exposes an HTTP API on a local URL such as `http://127.0.0.1:49374`, protected with HTTP Basic auth. |
| **Session** | One conversation with an agent. Sessions live in the server, and each one belongs to a project directory. |
| **Event** | A small JSON message you send to apex: `{source, type, payload}`. Example: `{"source":"monitor","type":"server.down","payload":{"host":"example.com"}}`. |
| **Subscription** | A rule stored by apex: "when an event matches these filters, deliver it to this session (optionally switching to this agent), using this prompt". Delivering the event is what wakes the agent up. |
| **RPC** | A way to call a function that a plugin registered inside the OpenCode server, over plain HTTP. For apex it is an authenticated `POST` (details below). |
| **`location[directory]`** | Every RPC call names the **project directory** it is for. OpenCode keeps plugins, tools, MCP servers and stored subscriptions separately per directory, so the same server can host several projects; this parameter decides which one handles the call. |

An RPC call to apex looks like this:

```
POST <baseUrl>/api/rpc/apex/<method>?location[directory]=<project directory>
Authorization: Basic base64("opencode:<server password>")
Content-Type: application/json

{"input": { ...method arguments... }}
```

The answer is `{"output": { ...result... }}`. In `curl`, the brackets must be encoded
(`location%5Bdirectory%5D=`) and the directory URL-encoded. You do not need to build these
URLs by hand: the tool `apex_callback_endpoint` returns them ready to use (see
["Finding the server address"](#finding-the-server-address)).

The overall flow:

```
1. An agent subscribes to an event                → tool apex_subscribe (or static config)
2. An outside process calls apex/events.ingest   → cron script, CI step, webhook relay
3. apex delivers the event to the session        → the agent receives a prompt and acts
```

## Subscriptions

Each subscription filters events (`filters`) and delivers the matching ones to a session,
either as a **prompt** (a normal user message: the agent starts a turn) or as a
**synthetic** message (a system-style message; it only starts a turn with `resume: true`).

Subscriptions come from two places:

- **Dynamic**: created by an agent with the tool `apex_subscribe`. They are bound to the
  session that called the tool and stored in the plugin storage (they survive restarts).
- **Static**: declared in the apex config under `events.subscriptions`. They get the ids
  `static-0`, `static-1`… and are read-only (`apex_unsubscribe` refuses them).

```jsonc
"events": {
  "routing": "all",          // "all" (default: every match) | "first" (only the highest priority match)
  "subscriptions": [
    {
      "sessionID": "",       // empty/null/missing → AUTO (see below); "ses_…" → that session
      "agent": "plan",       // optional: switch the target session to this agent before delivering
      "filters": [{ "field": "type", "operator": "equals", "value": "ci.failed" }],
      "promptTemplateFile": "prompts/ci-failure.md",
      "deliverAs": "prompt", // "prompt" (default) | "synthetic"
      "resume": false,       // synthetic only: true wakes the agent; false leaves it passive
      "delivery": "queue",   // "queue" (default: wait for the current turn) | "steer" (inject into the current turn)
      "priority": 10,        // higher first (default 0)
      "enabled": true        // default true
    }
  ]
}
```

### Fields

| Field | Default | Meaning |
| --- | --- | --- |
| `sessionID` | auto | Target session. Empty/null/missing binds to the **main session** (see below). |
| `agent` | — | If set, the target session is switched to this agent (`session.switchAgent`) before the event is delivered. The switch stays after the delivery. |
| `filters` | `[]` | All conditions must hold. **No filters = the subscription matches every event.** |
| `promptTemplate` | — | Inline prompt text with placeholders (below). |
| `promptTemplateFile` | — | Prompt file; wins over `promptTemplate`. Relative paths only: to the project (`prompts/x.md`) or to your home (`~/x.md`). Absolute paths and `..` escapes are rejected. If the file does not exist it is created with a default template. |
| `deliverAs` | `"prompt"` | `"prompt"` = user message (wakes the agent); `"synthetic"` = synthetic message. |
| `resume` | `false` | Only for `synthetic`: `true` wakes the agent loop, `false` just leaves the message in the session until its next turn. |
| `delivery` | `"queue"` | `"queue"` waits for the current turn to end; `"steer"` injects the message into the turn in progress. |
| `priority` | `0` | Order of delivery; with `routing: "first"` only the highest one is delivered. |
| `enabled` | `true` | Disabled subscriptions never match. |

### Filters

Each filter is `{field, operator, value?, pattern?}`. `field` is a dot path into the event:
`source`, `type`, `eventID`, `timestamp`, `location` (the project directory) or
`payload.<path>` (for example `payload.branch`).

| Operator | True when |
| --- | --- |
| `equals` | the value is strictly equal to `value` |
| `contains` | the string contains `value`, or the array includes `value` |
| `matches` | the string matches the regular expression in **`pattern`** (not `value`) |
| `gt` / `lt` | greater / lower than `value` (numbers) |
| `in` / `notIn` | the value is / is not one of the items of the array `value` (exact comparison, no wildcards) |
| `exists` / `notExists` | the field is present and not null / missing or null |

### Prompt templates

Placeholders: `{{eventID}}`, `{{source}}`, `{{type}}`, `{{payload}}` (the whole payload as
JSON) and `{{payload.<path>}}` (strings are inserted as-is, other values as JSON). Without any
template the agent receives the whole event as JSON (`eventID`, `source`, `type`, `payload`,
`timestamp`).

## Auto-binding to the main session

If `sessionID` is **empty, null or missing**, the subscription is delivered to the
**active main session**: the latest **root** session (no `parentID`) created in this
project directory — normally the one you open when you start working.

It is never bound to:

- **subagent** sessions (they have a `parentID`),
- the **advisor** session (`agent === "apex-advisor"`),
- the **runner** session of `tools.run` (`agent === "apex-runner"`),
- sessions of **another project directory** (OpenCode's event bus is shared by all
  directories; apex ignores events whose `location` is not its own directory).

### How it works

The module watches OpenCode's event stream:

| Event | Condition | Action |
| --- | --- | --- |
| `session.created` | root session, not advisor nor runner, same directory | bind it (and persist the binding) |
| `session.deleted` | it is the bound session | **unbind** (and persist) |
| (plugin load) | a persisted binding exists | restored if the session still exists; otherwise cleared |

When **another** root session is created it becomes the main session (the binding follows
the latest one). After the bound session is deleted, auto subscriptions have no target
until a new root session appears.

If a subscription has no resolvable target (auto and no main session), the event is **not
delivered** to it and a warning is logged; the ingest call itself still succeeds. If you
need delivery to one specific session even after you open new ones, set `sessionID`
explicitly.

## Entry point: the server RPC

Everything enters through OpenCode's RPC, per project directory:

| Method | Input | Output |
| --- | --- | --- |
| `events.ingest` | `{source, type?, payload, eventID?}` | `{accepted, eventID, delivered[]}` |
| `tools.run` | `{tool, input?, agent?, timeoutMs?}` | `{ok, tool, agent?, output?, content?, metadata?, error?, durationMs}` |
| `server.info` | `{}` | address and auth of this server (see below) |
| `status` | `{}` | `{modules, version, uptimeMs, endpoint}` |
| `ping` | `{payload?}` | `{pong, timestamp}` (`pong` echoes `payload`, default `"pong"`) |

`events.ingest` details:

- `source` (string) and `payload` (object) are required. A call without them is rejected by
  OpenCode itself with HTTP 400 and `{"_tag":"RpcError","type":"rpc.invalid_input",…}`.
- `eventID` is optional; one is generated if missing. The same `eventID` received again
  within **5 minutes** is accepted but not delivered again (`delivered: []`), so retries are
  safe. This memory is per directory and is lost if OpenCode unloads the plugin.
- `delivered` lists the ids of the subscriptions that received the event. An empty list
  means no subscription matched, none had a target session, the delivery failed, or the
  `eventID` was a duplicate.
- Any other failure (for example the events module is disabled) comes back as
  `{"output":{"accepted":false, …, "error":"…"}}`.

**Why there is no HTTP listener of its own.** OpenCode unloads the plugins of a directory
after **60 minutes without session activity** (hard-coded in OpenCode, not configurable),
and after a restart it does not load them until something uses that directory. A listener
or a timer inside the plugin would silently die with it. An RPC call, instead, waits until
the plugins of its directory are active and loads the directory on demand (a few seconds
on the first call; longer the very first time, while OpenCode installs the plugin from
npm). Since 0.2.0, `events.listener` is ignored with a warning.

The 0.1.x RPC did not work on OpenCode ≥ 2.1 either: it was registered with `name` while V2
looks plugins up by `id` (every call returned `rpc.unavailable`).

## Finding the server address

The tool **`apex_callback_endpoint`** (and the RPC `server.info`) tells an agent how an
outside process reaches THIS server:

| Field | Content |
| --- | --- |
| `baseUrl` · `source` | Base URL and where it came from, in this order: `config` (`events.server.url`) > `service` (the background service record `<state>/opencode/service*.json` whose `pid` is this process; `<state>` is `$XDG_STATE_HOME` or `~/.local/state`) > `argv` (the `--hostname`/`--port` of `opencode serve`). `null` if none applies. |
| `rpc.ingest` · `rpc.toolsRun` · `rpc.status` · `rpc.ping` | Full URLs of the methods, already carrying this project's `location[directory]`. |
| `auth` | `{scheme:"basic", username:"opencode", password}`. `password` says **where** the password is, never the password itself: `{kind:"file", file, field:"password", shell}` for the background service (the record is a `0600` file), `{kind:"env", env:"OPENCODE_SERVER_PASSWORD", shell}` for `opencode serve`, or `null` if unknown. `shell` is a command that prints it. |
| `publicUrl` | URL for senders on **other machines** (a tunnel or reverse proxy in front of the server). Runtime value (tool `apex_set_callback_url`) > `events.server.publicUrl`. The `rpc.*` URLs always use `baseUrl`: a remote sender replaces the base with `publicUrl`. |
| `examples` | Ready-to-run `curl` commands for `ingest` and `toolsRun` (they read the password at run time). Tool only; `server.info` omits them. |
| `hint` | Present when `baseUrl` is unknown: set `events.server.url`. |

```jsonc
"events": {
  "server": { "url": "", "publicUrl": "" }   // empty = discover
}
```

The password is never returned on purpose: it would end up in the conversation and in the
model provider's logs. Scripts read it when they run.

## `tools.run`: OpenCode tools from outside

An outside process runs ONE tool (built-in, from a plugin, or from an MCP server) and gets
its result back, without any model. It is meant for watchers that depend on something only
OpenCode can reach (an MCP server such as Easypanel, the browser tools…).

```jsonc
"events": {
  "tools": {
    "enabled": true,
    "allow": ["*"],                                         // tool-name globs (* and ?)
    "deny": ["question", "subagent", "execute", "apex_*"],  // wins over allow
    "agent": "build",                                       // whose permissions apply
    "timeoutMs": 120000
  }
}
```

- Check order: `enabled` → `deny` → `allow` → the tool must exist in this directory → the
  **permissions of the agent** (`agent` from the call, otherwise `events.tools.agent`) —
  the same rules the tool applies when that agent uses it. With nobody watching, a
  permission that resolves to "ask" waits for the apex advisor (if enabled) or until
  `timeoutMs` (overridable per call).
- The defaults deny `question` (would wait for an answer forever), `subagent` and `execute`
  (would start a model) and apex's own tools.
- `tool` is the tool id as agents see it (MCP tools are usually `<server>_<tool>`).
- Tools run on behalf of a **runner** session per directory (hidden agent `apex-runner`,
  title `apex · tools.run`, persisted in the plugin storage). It never becomes the main
  session and does not appear among the selectable agents.
- Calls are not recorded in any session history and do not fire the
  `tool.execute.before/after` hooks.
- Output: `ok`, `tool`, `agent`, plus the tool's `output` (structured, if the tool declares
  it), `content` (the text a model would see) and `metadata`, or `error`. Errors (denied,
  unknown tool, permission blocked, timeout) come back as `ok: false` with `error`, not as
  HTTP errors.
- Anyone holding the server password can already do this through the session API;
  `allow`/`deny` narrow this particular path.

## Webhooks

A webhook is a callback with an **intermediate process**: the external service calls a
relay over HTTP (n8n, a small daemon), and the relay turns that call into `events.ingest`.
OpenCode itself does not expose a webhook URL. The `apex-callbacks` skill includes a
minimal Node relay (token and GitHub signature checks) and an n8n recipe. To receive webhooks
from the Internet, expose the relay (with its own token), never the OpenCode server. A relay
behind NAT needs the provider's outbound mode, a tunnel, a reverse connection or a public
receiver that stores events for it: the skill's `references/reachability.md` compares them.

## Tools

- `apex_subscribe` — creates a subscription bound to the **calling session**.
- `apex_unsubscribe` — removes a dynamic subscription by id (static ones are `readonly`).
- `apex_list_subscriptions` — lists the subscriptions of this project: the ones from config
  (`readonly: true`) and the dynamic ones.
- `apex_callback_endpoint` — server address, RPC URLs and auth (see above).
- `apex_set_callback_url` — sets/clears the server's public URL (tunnel/proxy); `null` clears it.

The **`apex-callbacks`** skill ships with the package (`skills/apex-callbacks/SKILL.md`) and
registers itself wherever apex loads. `SKILL.md` holds the model and the steps. Its
`references/` cover relay design for any source (`relays.md`), reachability and tunnels
(`reachability.md`), running on Linux, macOS, Windows or containers (`run-anywhere.md`) and
copyable code (`examples.md`).
