# Apex Guard — per-agent permission rules, decided by the plugin

> **OpenCode V2 only (>= 2.1).** The guard is a `permission.evaluate` hook of the V2 plugin
> API.

The guard lets you say, per agent, which tools and paths are allowed, denied or must be
asked about, and it keeps a report of every decision. It is **off by default**
(`modules.guard`). When you turn it on, it starts in `report` mode: it only records what it
*would* do.

## Background: OpenCode V2 permissions in 30 seconds

(Longer version in [ADVISOR.md § Background](ADVISOR.md#background-how-permissions-work-in-opencode-v2).)

- **Rules.** OpenCode checks each tool call against rules
  `{ action, resource, effect: "allow" | "deny" | "ask" }`. Wildcards `*` are allowed, the
  **last matching rule wins**, and no match means `ask`, which prompts you.
- **Where rules come from.** The agent's rules come first, then the session's.
- **Plugins.** They see each call in the `permission.evaluate` hook and may change the
  effect, **except** for calls already denied by those rules. A `deny` in your config ends
  the evaluation before any plugin runs.

## Why not just write `deny` rules in the config?

Two observed reasons. Each one is enough on its own.

**1. A config `deny` on a native tool can get the agent rejected by OpenCode Zen's free
tier.** A `deny` removes the tool from the agent's toolset. In our tests, a custom agent with
any native tool removed was refused by the Zen free models with *"OpenCode's free tier can
only be used from within OpenCode"*, an error that does not hint at the cause. One rule was
enough:

| Custom agent (`agents/*.md` frontmatter) | Result on Zen free models |
| --- | --- |
| no `permission`, or only `allow` / `ask` | OK |
| `temperature`, own 3 600-character system prompt | OK |
| **`permission: { shell: deny }`** | **rejected** |
| **`tools: { shell: false }`** | **rejected** |

Notes on these observations:

- **Scope.** Only native tools trigger this. Denying MCP or plugin tools (`hindsight_*`,
  `apex_*`) did not. Tested with `nemotron-3-ultra-free` and `hindsight_banks_delete_bank`.
  For those tools, a plain config `deny` is fine.
- **Exception.** `space-bunny-free` was the only free model not affected.
- **Not fully explained.** OpenCode's own `explore` agent ships with
  `{ action: "*", resource: "*", effect: "deny" }` (`packages/core/src/plugin/agent.ts`). Its
  toolset is filtered the same way (`registry.snapshot(permissions)` in
  `session/context.ts`), and yet it is *not* rejected. Something else tells built-in agents
  from custom ones.
- **What is reproducible** is the table above: 3 out of 3 rejections for a `deny` in a custom
  `.md` agent.

The practical rule: **in your own agents, do not `deny` native tools in the config.**

**2. A config `deny` never reaches plugins.** OpenCode stops before the hooks:

```ts
// packages/core/src/permission.ts (OpenCode 2.1.1)
if (denied(input, rules)) return { effect: "deny", rules }   // no hooks run
…
const event = yield* hooks.trigger("permission", "evaluate", { …, effect })
```

So a config `deny` cannot be refined per path, cannot be logged, and cannot be reported.

**The resulting split:**
- In the config and in `agents/*.md`, native tools only get `allow` or `ask`, so the toolset
  stays complete.
- The actual prohibition is decided here, in the guard, on the `ask` / `allow` that does
  reach the hook.

## Configuration

```jsonc
"modules": { "guard": true },
"guard": {
  "mode": "enforce",        // default "report": record only, never change the permission
  "fallback": "keep",       // default "keep": when no rule matches, leave the permission as it is
  "keep": 500,              // default 500: decisions kept in the in-memory report
  "agents": {
    "code-reviewer": [
      { "action": "write", "effect": "deny", "reason": "code-reviewer does not modify the project" },
      { "action": "edit",  "effect": "deny", "reason": "code-reviewer does not modify the project" },
      { "action": "shell", "effect": "deny", "reason": "code-reviewer does not run commands" },
      { "action": "write", "resource": ".opencode/code-reviewer/**", "effect": "allow" },
      { "action": "edit",  "resource": ".opencode/code-reviewer/**", "effect": "allow" }
    ]
  }
}
```

How rules are matched:

- **The last matching rule wins**, as in OpenCode's own rules. That is what makes "nothing,
  except this path" possible: first the broad `deny`, then the narrow `allow`.
- **The `"*"` key** holds rules for every agent. They are checked *before* the agent's own
  rules, so an agent's rules can override them.
- **`action` and `resource` are patterns**, where `*` matches anything, `/` included.
  `resource` defaults to `"*"`. If a call touches several resources, the rule matches when
  any one of them matches.
- **Relative paths** in `resource` are tested both **as written** and **expanded** against
  the project directory (`~/…` expands to your home), because OpenCode hands over resources
  both ways: `read` arrives as `package.json`, while OpenCode's own rules use absolute paths
  like `/home/…/.opencode/plan/*`. Patterns that contain spaces, such as shell commands,
  are never expanded.

### `mode`

- `report` (default) records the decision but leaves the permission untouched.
- `enforce` applies it. Start with `report`, read the report, fix the rules, and only then
  switch to `enforce`. A freshly written guard that starts denying can break a session
  before you have seen a single rule in action.

### `fallback`

What happens when no rule matches:

- **`keep`** (default) leaves the permission as OpenCode decided it, and it is the only safe
  default.
- **Any other value** rewrites every unmatched decision, for every agent. With
  `fallback: "allow"`, every `ask` becomes `allow`: your config's `shell` rules stop
  prompting, and the advisor has nothing left to judge. During development this let an
  `rm -r` run without asking.

A matching `allow` rule **does** upgrade an `ask` to `allow`, on purpose: that is how a
subagent can write into its own directory without bothering you. The upgrade always needs
an explicit rule; it never comes from the fallback.

When the guard denies a call in `enforce` mode, the message reads
`⛔ apex.guard: <reason> [<rule>]`.

## Order: guard first, then advisor

The guard registers its hook **before** the [advisor](ADVISOR.md). OpenCode runs the
`permission.evaluate` hooks in registration order on the same event, and the advisor only
acts while the effect is still `ask`. So what the guard decides never reaches the advisor,
and whatever the guard leaves as `ask` is exactly what the advisor should judge. The other
way round, the advisor would approve calls the guard was about to forbid.

The guard's hook is wrapped in `try/catch`. OpenCode runs the hooks one after another, and a
hook that throws stops the chain, so every hook registered after it, the advisor included,
would silently stop running.

## The advisor itself

The `apex-advisor` agent is restricted by the permission rules apex gives it when it creates
the agent: deny everything except `execute` and `apex_advisor_decide`. Those are ordinary
OpenCode rules, so they apply whether the guard is on or not. If the advisor's model tries
`write`, OpenCode denies it before any hook runs. No model is consulted, so no recursion is
possible.

> When the guard is on, it applies the same three rules to `apex-advisor` as a second layer.
> They come from `createDefaultGuardConfig()` and are merged per agent with your
> `guard.agents`. Defining `guard.agents["apex-advisor"]` yourself replaces them. Before 0.2.2
> your (empty) `guard.agents` map dropped them by mistake. The advisor's main protection is
> still its agent ruleset.

## The report

The tool **`apex_guard_report`** returns the recorded decisions:
- **Inputs:** `limit` (default 40), `agent` and `effect`, which filters by the applied effect.
- **Output:** text, not JSON. An object with dynamic keys is rejected by OpenCode's tool
  output validator, and a compact table costs far fewer tokens.

```
apex.guard · modo=enforce · fallback=keep · 17 decisiones registradas

resumen (allow/deny/ask por agente):
  build                allow=7 deny=0 ask=1
  code-reviewer        allow=5 deny=1 ask=0

últimas 6 (más reciente primero):
  15:08:48 code-reviewer edit core/HACK.ts → ask→deny · regla: deny edit · code-reviewer no modifica el proyecto
  15:08:33 code-reviewer grep guard\.ts → allow
```

(The report text itself is currently in Spanish.)

- **Lifetime.** The report lives in memory only, and is shared by the whole OpenCode process
  (`Symbol.for("apex.guard.report.v1")`). OpenCode loads the plugin once per directory: the
  advisor runs in another one, `<tmp>/opencode-apex-advisor`. With per-module state, the hook
  of one instance would record decisions where the tool of another never looks, and the
  report would come out empty while the guard was working.
- **Trace.** Set `APEX_GUARD_TRACE=1` to also print every decision to the server console.

## Tell your agents about their toolset

The guard keeps every tool visible to the model, which is the whole point of not using
config `deny`. So the model does not know which tools it may use, and it will waste turns on
calls the guard is going to block. **Recommended:** end each agent's prompt with a short
"your toolset" section that mirrors its guard rules: what to use, what not to use, and the
path exceptions. apex does not generate this section for you.

## Tests

`bun test/guard.test.ts` runs 56 checks on the engine:
- pattern matching;
- resource expansion for relative and absolute paths;
- order precedence;
- the advisor policy;
- the report ring buffer;
- the `keep` fallback.
