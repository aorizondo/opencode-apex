# Apex Advisor — let a second model answer permission prompts

> **OpenCode V2 only (>= 2.1).** This module uses the V2 plugin API (`permission.evaluate`
> hook, agents and sessions created by plugins). It does not work on OpenCode V1.

The advisor answers "may this tool run?" questions for you. When OpenCode would normally
stop and show you a permission prompt, apex asks a dedicated, cheap model instead, and
either applies its answer (`decisive: true`) or shows it to you next to the prompt
(`decisive: false`).

## Background: how permissions work in OpenCode V2

You do not need to know OpenCode internals to use the advisor, but these few facts explain
what it can and cannot do.

- **Every tool call is checked against rules.** A rule looks like
  `{ "action": "shell", "resource": "git *", "effect": "allow" }`:
  - `action` is the tool or permission name: `read`, `edit`, `shell`, an MCP tool…
  - `resource` is what the tool touches: a path, a command line…
  - `effect` is `allow`, `deny` or `ask`.
  - Both `action` and `resource` accept `*` wildcards.
- **The last matching rule wins.** The rules of the current agent come first, then the
  rules of the session. A rule added later overrides an earlier one. If no rule matches, the
  result is `ask`.
- **`ask` means "show the user a prompt"**: the tool call waits until someone answers
  Allow / Deny. If you answered "Always allow" before, that saved answer turns a later `ask`
  into `allow`.
- **`deny` is final.** OpenCode stops a denied call *before* any plugin sees it. Plugins can
  only act on calls whose effect is `allow` or `ask`.
- **Plugins can rewrite the decision.** For every call that is not hard-denied, OpenCode runs
  the `permission.evaluate` hook of every plugin, in the order they registered. Each hook may
  change the effect (`allow` / `ask` / `deny`) and attach a message. The advisor is one such
  hook.

## How it works

```
your session (agent ↔ you)
├── tool call                      ─┐
├── subagent A → tool call          ├─► ONE advisor session for the whole tree ─► agent apex-advisor
└── subagent B → tool call         ─┘     (full history, cheap model)
                                                   │
                                    apex_advisor_decide(requestID, allow | deny + reason)
```

1. A tool call in any session of the tree reaches the `permission.evaluate` hook.
2. The advisor skips it when:
   - it comes from the advisor's own session or agent;
   - the tool is not in `actions` (when you set a filter);
   - its effect is not `ask`. This is the default, `evaluate: "ask-only"`; with
     `evaluate: "all"` the advisor also judges calls that were already `allow`.
3. **Cache:** if the same `(action, resources)` pair was decided in the last 10 minutes,
   that answer is reused without asking the model. The cache is stored in plugin storage,
   so it survives reloads.
4. Otherwise apex finds the **root** of the session tree (it follows `parentID` upwards,
   at most 25 levels) and gets or creates the advisor session for that root.
5. It sends the request to the advisor session as a prompt (`delivery: "steer"`,
   `resume: true`), so the advisor agent wakes up.
6. The advisor agent answers by calling its only tool, `apex_advisor_decide`, with the
   request id and `allow` or `deny` + `reason`. A deny without a reason is rejected, and so
   is any value other than `allow` / `deny`.
7. apex applies the answer according to `decisive` and writes it to an audit log (the last
   100 decisions, in plugin storage).

**If no answer arrives in time** (`timeoutMs`, 10 s by default) or something fails,
the original permission is left untouched: you get the normal prompt.

### The advisor agent and its session

- apex creates (or updates) a hidden agent **`apex-advisor`**:
  - `mode: "subagent"` and `hidden: true`, so it never appears in your agent list;
  - it uses its own `model`;
  - its permission rules deny everything except `execute` and `apex_advisor_decide`.

  `execute` is needed because in OpenCode V2 models call tools from a JavaScript sandbox
  ("Code Mode"). Without it the advisor could decide but never deliver its answer. Every
  tool called from that sandbox still goes through the same rules, so the advisor cannot
  touch your files.
- **One advisor session per session tree.** Your main session and all its subagents share
  it, so the advisor sees every earlier request and answer. The session is kept, which also
  makes it a complete audit trail of what was asked and decided.

## `decisive`

| `decisive` | Effect on the permission | Message |
| --- | --- | --- |
| `true` | the advisor's `allow` / `deny` replaces the effect. A `deny` blocks the call | the deny reason |
| `false` (default) | the effect is **not** changed: you still get the prompt | `⚖ apex.advisor: <decision> — <reason>` is added to it |

## Configuration

The advisor module is **on by default** (`modules.advisor`). Set `"advisor": false` in
`modules` to turn it off. The values below are the defaults, except `model` and `decisive`:

```jsonc
"modules": { "advisor": true },
"advisor": {
  "model": "opencode/big-pickle",   // "providerID/modelID"; pick a fast, cheap one. Unset = the default model
  "decisive": true,                 // default false: only advise, never change the effect
  "evaluate": "ask-only",           // "ask-only" | "all" (every tool call — much slower)
  "timeoutMs": 10000,               // wait this long for an answer, then leave the permission as it was
  "actions": [],                    // tool names to judge; empty = all
  "location": "",                   // advisor session directory; empty = <tmp>/opencode-apex-advisor
  "system": "…",                    // optional: replaces the advisor's system prompt
  "promptTemplate": "…",            // optional: the request text sent to the advisor
  "promptTemplateFile": "…"         // optional: same, from a file (wins over promptTemplate)
}
```

- **Template placeholders:** `{{requestID}}`, `{{action}}`, `{{resources}}`, `{{sessionID}}`,
  `{{agent}}`, `{{enforcement}}` (a sentence that tells the advisor whether its decision is
  applied) and `{{metadata.<path>}}`.
- **`promptTemplateFile`** must be a relative path, inside the project or your home
  directory. If the file does not exist, it is created with the default template.

## Keeping the project's AGENTS.md away from the advisor

OpenCode V2 has no per-agent instructions. Every session gets the instruction files found
for its **directory**: the project's `AGENTS.md`, plus files found walking up from it. An
advisor that reads your repo's coding rules is slower and gets confused about its job.

That is why apex creates the advisor session in a dedicated directory **outside the
project** (`advisor.location`, by default `<tmp>/opencode-apex-advisor`):

- ✅ the repository's `AGENTS.md` and its parent directories are not loaded;
- ✅ being outside your home, the home-directory chain is not walked either;
- ⚠️ the **global** `~/.config/opencode/AGENTS.md` and `instructions` from your config still
  apply. A plugin cannot turn those off.

Changing `advisor.location` makes apex create a new advisor session. The location is stored
in the session's `metadata.apexAdvisorLocation`.

## Limitations

- **The advisor session is a sibling, not a child, of your session.** OpenCode 2.1 lets a
  plugin create a session with `parentID`, but then the plugin cannot choose its directory:
  it would run in your project and load its `AGENTS.md`. apex keeps it separate and stores
  the link in `metadata.apexAdvisorFor`.
- **Each uncached decision costs one model round trip.** With `evaluate: "all"`, every tool
  call waits for it.
- **The cache key is only `(action, resources)`.** An answer given for one agent is reused
  for any other agent asking the same thing within 10 minutes.
- **A missing answer never blocks you:** after `timeoutMs` the normal prompt appears.

## Working with the guard

If the [guard](GUARD.md) module is also on, it is registered **before** the advisor. The
guard resolves what its rules cover, and the advisor only judges what is still `ask`
afterwards. See [GUARD.md § Order](GUARD.md#order-guard-first-then-advisor).
