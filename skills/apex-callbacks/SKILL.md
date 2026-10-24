---
name: apex-callbacks
description: Automations that wake an agent up from outside the conversation with opencode-apex (OpenCode V2). Use it when asked to watch something periodically ("check every 5 minutes whether X is up and diagnose it if it goes down"), to notify when a job finishes or after a reboot, to receive webhooks from external services (GitHub, n8n, Stripe…) or to use OpenCode tools (MCP, browser) from a script. Covers finding the server URL, subscribing, writing the watcher script, scheduling it with systemd/cron, the webhook relay and the tools.run RPC.
---

# Automations with apex: callbacks, webhooks and watchers

## The idea in one sentence

The **clock** (cron/systemd) and the **door** (a webhook relay) live OUTSIDE OpenCode;
OpenCode only works when it is called through **RPC** (an authenticated HTTP request to
the OpenCode server). When something deserves attention, the outside process calls
`events.ingest` and a **subscription** wakes the agent up with the task.

```
outside process ──(tools.run: uses OpenCode tools, optional)──▶ OpenCode
      │
      └─ criterion met? ──(events.ingest)──▶ subscription ──▶ the agent wakes up
```

**Never** keep the watching inside OpenCode (a `sleep` loop in the shell tool, a timer in a
plugin): OpenCode unloads the plugins of a directory after **60 minutes without activity**
and, after a restart, does not load them again until someone uses that directory. An RPC
call, instead, loads the directory by itself (a few seconds on the first call).

## Step 0 — Where do I point? (ask, do not guess)

Call the tool **`apex_callback_endpoint`**. It returns:

| Field | What it is |
| --- | --- |
| `baseUrl` | URL of the OpenCode server from this machine (`null` → ask the user to set `events.server.url`) |
| `rpc.ingest` / `rpc.toolsRun` | Full URLs of the methods, already carrying this project's `location[directory]` |
| `auth.username` | always `opencode` (HTTP Basic) |
| `auth.password` | WHERE the password is: `{kind:"file", file, field}` (the service's `0600` record) or `{kind:"env", env}`; `shell` prints it in a terminal |
| `publicUrl` | URL for senders on **other** machines (tunnel/proxy), if one exists |
| `examples` | `curl` commands ready to copy |

Rules:
- **Never write the password** into scripts, systemd units, crontab or the conversation:
  scripts read it when they run, from `auth.password.file` (the `pw` function below) or
  from the variable named in `auth.password.env`.
- Use the `rpc.*` URLs as they are: `location[directory]` routes the call to THIS project
  (its subscriptions, its MCP tools).
- Another machine cannot reach `127.0.0.1`: it needs a tunnel or proxy to `baseUrl`. Announce
  it with `apex_set_callback_url({url})`, have the sender use that base instead of
  `baseUrl`, and clear it with `{url: null}` when done.

## Step 1 — Subscribe (who wakes up, and with which task)

With the tool **`apex_subscribe`** (the subscription is bound to the session that calls it):

```jsonc
{
  "filters": [{ "field": "type", "operator": "equals", "value": "server.down" }],
  "agent": "build",                       // agent the session switches to before delivery (optional)
  "promptTemplate": "Server {{payload.host}} is down ({{payload.detail}}). Diagnose the cause and propose a fix.",
  "deliverAs": "prompt",                   // prompt = a new turn of the agent
  "delivery": "queue"
}
```

- Filter by `type` (and by `source` if there are several senders): a subscription without
  filters matches **every** event.
- The task goes in the template: it is the prompt the agent will receive. Placeholders:
  `{{type}}`, `{{source}}`, `{{eventID}}`, `{{payload}}` (whole payload as JSON),
  `{{payload.<field>}}`.
- `deliverAs: "synthetic"` + `resume: true` also wakes the agent; with `resume: false` the
  message stays passive until the next turn.

## Step 2 — The watcher script

What a good watcher does:
1. **Only notifies on state changes** (up → down, and optionally down → up), not on every
   check: it keeps the last state in a file.
2. **Stable `eventID` per incident** (e.g. `server.down-<host>-<time it went down>`): sending
   it again does not duplicate the delivery.
3. Tells "the service is down" apart from "I could not check" (network timeout, failing
   MCP server): they are different events.
4. Retries the call to OpenCode with backoff: right after a restart it takes a few seconds.

```sh
#!/bin/sh
# watch-http.sh — tells apex when a URL goes from up to down (and when it recovers).
TARGET="https://my-server.example.com/health"
INGEST='<rpc.ingest from apex_callback_endpoint>'
PASSWORD_FILE='<auth.password.file from apex_callback_endpoint>'
# The password is read on every run (if auth.password.kind is "env": printf %s "$OPENCODE_SERVER_PASSWORD").
pw() { sed -n 's/.*"password" *: *"\([^"]*\)".*/\1/p' "$PASSWORD_FILE"; }
STATE="$HOME/.local/state/apex-watch/$(printf %s "$TARGET" | md5sum | cut -c1-12)"
mkdir -p "$(dirname "$STATE")"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$TARGET")
case "$code" in 2??|3??) now=up ;; *) now=down ;; esac
before=$(cat "$STATE" 2>/dev/null || echo up)
[ "$now" = "$before" ] && exit 0          # no change: nobody gets bothered
echo "$now" > "$STATE"

type="server.$now"; since=$(date +%s)
body=$(printf '{"input":{"source":"watch-http","type":"%s","eventID":"%s-%s","payload":{"host":"%s","detail":"HTTP %s"}}}' \
  "$type" "$type" "$since" "$TARGET" "$code")
for i in 1 2 3 4 5; do
  curl -sS --fail --max-time 30 -X POST "$INGEST" -u "opencode:$(pw)" \
    -H 'content-type: application/json' -d "$body" && exit 0
  sleep $((i * 10))
done
exit 1
```

### If the check needs an OpenCode tool → `tools.run`

When what you have to check only exists inside OpenCode (an MCP server such as Easypanel,
the browser, `webfetch`…), the script runs that tool through RPC, without a model:

```sh
TOOLS_RUN='<rpc.toolsRun from apex_callback_endpoint>'
out=$(curl -sS --max-time 150 -X POST "$TOOLS_RUN" -u "opencode:$(pw)" \
  -H 'content-type: application/json' \
  -d '{"input":{"tool":"<exact tool id>","input":{ ... }}}')
echo "$out" | jq -e '.output.ok' >/dev/null || { echo "could not check: $(echo "$out" | jq -r '.output.error // .')"; exit 2; }
echo "$out" | jq -r '.output.content'
```

- `tool` is the exact id of the tool as you see it (MCP tools are usually
  `<server>_<tool>`). Try it by hand first and copy its input.
- Reply: `{"output":{"ok","tool","agent","output?","content?","metadata?","error?","durationMs"}}`.
  Failures (denied, unknown tool, permission blocked, timeout) come as `ok: false` + `error`.
- The **permissions** of the agent `events.tools.agent` (default `build`) apply, or those of
  the `agent` you pass in the call. With nobody watching, an "ask" permission waits for the
  apex advisor or until `timeoutMs` (120 s by default): ask the user for an `allow` rule if
  needed.
- `events.tools.allow` / `deny` limit which tools can be run this way (`question`,
  `subagent`, `execute` and the `apex_*` tools are denied by default).

## Step 3 — Schedule it (the clock)

Preferred: a **systemd user timer** (survives reboots, keeps logs):

```sh
mkdir -p ~/.config/systemd/user ~/.local/bin
install -m 0755 watch-http.sh ~/.local/bin/apex-watch-my-server.sh
cat > ~/.config/systemd/user/apex-watch-my-server.service <<'EOF'
[Unit]
Description=apex watch: my-server
[Service]
Type=oneshot
ExecStart=%h/.local/bin/apex-watch-my-server.sh
EOF
cat > ~/.config/systemd/user/apex-watch-my-server.timer <<'EOF'
[Unit]
Description=apex watch: my-server every 5 min
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now apex-watch-my-server.timer
systemctl --user list-timers | grep apex-watch          # check
journalctl --user -u apex-watch-my-server -n 20        # logs
```

Alternative: `crontab -e` → `*/5 * * * * ~/.local/bin/apex-watch-my-server.sh`.

Before calling the task done: **run the script once by hand** and, if you can, trigger the
event (or send a test `events.ingest`) to see the subscription wake the agent. Tell the user
what you installed and how to remove it:

```sh
systemctl --user disable --now apex-watch-my-server.timer
rm ~/.config/systemd/user/apex-watch-my-server.{service,timer} ~/.local/bin/apex-watch-my-server.sh
```
…plus `apex_unsubscribe({id})` for the subscription.

## Webhooks (external services that call over HTTP)

A webhook is a callback with an **intermediate process** that turns the service's HTTP call
into `events.ingest`. OpenCode does not expose a webhook URL of its own.

- **n8n**: *Webhook* node → *HTTP Request* node `POST <rpc.ingest>`, Basic auth (credential
  `opencode` + password), body
  `{"input":{"source":"github","type":"{{$json.headers['x-github-event']}}","eventID":"{{$json.headers['x-github-delivery']}}","payload":{{JSON.stringify($json.body)}}}}`.
  If n8n runs on another machine it needs to reach the server (tunnel/proxy, `publicUrl`).
- **Minimal relay** (Node ≥ 18, no dependencies) on the OpenCode machine, as a systemd user
  service. It checks its own token before forwarding anything:

```js
// webhook-relay.mjs — POST http://<host>:<port>/<type>?token=<RELAY_TOKEN> → apex events.ingest
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
const { INGEST, PASSWORD_FILE, RELAY_TOKEN, PORT = "8787", HOST = "127.0.0.1", SOURCE = "webhook" } = process.env
if (!INGEST || !RELAY_TOKEN) throw new Error("INGEST or RELAY_TOKEN missing")
// Read on every request: survives service restarts without restarting the relay.
const password = () =>
  PASSWORD_FILE ? JSON.parse(readFileSync(PASSWORD_FILE, "utf8")).password : process.env.OPENCODE_SERVER_PASSWORD
createServer(async (req, res) => {
  const url = new URL(req.url, "http://relay")
  if (req.method !== "POST" || url.searchParams.get("token") !== RELAY_TOKEN) return res.writeHead(401).end()
  let raw = ""
  for await (const chunk of req) if ((raw += chunk).length > 1_000_000) return res.writeHead(413).end()
  let body; try { body = JSON.parse(raw || "{}") } catch { body = { raw } }
  const h = req.headers
  const input = {
    source: SOURCE,
    type: url.pathname.slice(1) || String(h["x-github-event"] ?? h["x-event-type"] ?? "webhook"),
    eventID: String(h["x-github-delivery"] ?? h["idempotency-key"] ?? h["x-request-id"] ?? "") || undefined,
    payload: { body, headers: { "content-type": h["content-type"], "user-agent": h["user-agent"] } },
  }
  try {
    const auth = "Basic " + Buffer.from(`opencode:${password()}`).toString("base64")
    const r = await fetch(INGEST, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ input }) })
    res.writeHead(r.ok ? 202 : 502, { "content-type": "application/json" }).end(await r.text())
  } catch (error) {
    res.writeHead(502).end(String(error))   // OpenCode stopped: the sender will retry
  }
}).listen(Number(PORT), HOST)
```

  Configure it with `INGEST` and `PASSWORD_FILE` (from `apex_callback_endpoint`; if
  `auth.password.kind` is `env`, export `OPENCODE_SERVER_PASSWORD` instead) and a random
  `RELAY_TOKEN` (`openssl rand -hex 24`). To receive from the Internet, expose **the relay**
  (not the OpenCode server) through a tunnel.

## Security

- Whoever can call `events.ingest` steers the agent, and `tools.run` runs tools: both
  require the server password. Treat it as a credential.
- Files holding secrets: `0600`. A relay or tunnel exposed to the Internet carries its own
  token and never forwards without checking it.
- Do not widen permissions to make a watcher work without telling the user.

## Contract

| RPC method | Input | Output |
| --- | --- | --- |
| `events.ingest` | `{source, type?, payload, eventID?}` | `{accepted, eventID, delivered[]}` (or `error`) |
| `tools.run` | `{tool, input?, agent?, timeoutMs?}` | `{ok, tool, agent, output?, content?, metadata?, error?, durationMs}` |
| `server.info` | `{}` | the same as `apex_callback_endpoint` (without `examples`) |
| `status` / `ping` | `{}` | plugin status / `{pong, timestamp}` |

All of them: `POST <baseUrl>/api/rpc/apex/<method>?location[directory]=<project>`, body
`{"input":{…}}`, reply `{"output":{…}}`, Basic `opencode:<password>`. A call missing a
required field is rejected with HTTP 400 (`rpc.invalid_input`). `delivered: []` means no
subscription received the event (check the filters and the target session) or the
`eventID` was already delivered in the last 5 minutes.
