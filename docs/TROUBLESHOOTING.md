# Troubleshooting — opencode-apex

> **OpenCode V2 only (2.1 or newer).** OpenCode V1 has a different plugin system
> (`@opencode-ai/plugin`, config key `plugin`). apex is written for V2 (`@opencode/plugin`,
> config key `plugins`) and cannot load on V1. That is not a bug.

This page has two parts:

- [Troubleshooting](#troubleshooting): symptom → cause → fix, for anyone using apex.
- [Developer notes](#developer-notes): gotchas for people changing apex's code.

## Before you start: where to look

| What | Where |
| --- | --- |
| OpenCode version | `opencode --version` (the desktop app ships the same CLI, e.g. `/opt/OpenCode/resources/opencode-cli` on Linux) |
| Server log (plugin loading, apex warnings) | `~/.local/share/opencode/log/opencode.log`. For a foreground server, `opencode serve --print-logs`. |
| Installed copy of apex | `~/.cache/opencode/npm/opencode-apex@<spec>/<generation>/node_modules/opencode-apex` |

Useful log searches:

```bash
grep -a "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail
grep -a "\[apex" ~/.local/share/opencode/log/opencode.log | tail
```

On every load apex logs a `[apex] config: inline=… global=… local=…` line, which says
which config sources it found.

---

# Troubleshooting

## The plugin does not load

**Symptom:** apex tools such as `apex_subscribe` do not exist, and the log shows
`failed to load plugin … target=opencode-apex`.

| Cause in the log | Fix |
| --- | --- |
| `Cannot find package '@opencode/plugin'`, or OpenCode reports a 1.x version | You are on OpenCode V1. Upgrade to V2 (2.1+). |
| `Schema.isStartsWith is not a function`, `missing TypeId`, or other errors from inside `effect` | An `@opencode/*` package installed with apex is older than your OpenCode (see next section). Force a reinstall. |
| `Plugin must export a default definition…` | You pointed `package` at a file. Point it at the plugin **directory** or at the npm name `opencode-apex`. |
| `Plugin entrypoint not found` | The path in `package` is wrong, or the directory has no `index.ts`. |

## Version mismatch with OpenCode (`effect`)

apex is written with the [`effect`](https://effect.website) library, and so is OpenCode.

**What OpenCode guarantees.** Since 2.1, OpenCode serves `effect` and `@opencode/plugin` (every
subpath) to plugins **from its own copy**:
- an `import "effect"` inside a plugin always gets the host's version;
- loading those two packages from a plugin's own `node_modules` is refused, with
  `… is not provided by OpenCode; plugins must use the host's "effect" and "@opencode/plugin" modules`.

**What can still drift.** The *other* `@opencode/*` packages come from apex's own
`node_modules`: `@opencode/schema` and `@opencode/client`, pulled in by `@opencode/plugin`,
and `@opencode/plugin-browser`. They run on the host's `effect`, so they must come from the
same release line as your OpenCode. When they don't, errors come from deep inside `effect`.
Example: `@opencode/schema` 2.0.14 calls `Schema.isStartsWith`, which no longer exists in the
`effect` 4.0.1 that OpenCode 2.1 serves.

**How apex keeps them aligned (since 0.2.0):**

1. `@opencode/plugin` and `@opencode/plugin-browser` are `^2.1.1` dependencies. A fresh
   install pulls the current 2.x packages.
2. `effect` is only an **optional peer** (`^4.0.0`), for editors and tests outside OpenCode.
   apex never pins its own version.
3. On load, apex warns (`[apex] …` in the log) in two cases:
   - OpenCode is a newer minor version than the `@opencode/plugin` installed with apex,
     which means its `@opencode/*` packages are older than the host;
   - it finds two copies of `effect` on disk.
4. Before every publish, `scripts/check-install.mjs` installs the package the way OpenCode
   does and refuses to publish if the install is inconsistent or the plugin does not import.

**The one thing you have to do yourself:** OpenCode caches installed plugins and **does
not refresh them on its own**. After upgrading OpenCode, or to move to a new apex
release, force a reinstall:

1. Stop OpenCode: `opencode service stop` for the background service, or close the app.
2. Delete the cached copy: `rm -rf ~/.cache/opencode/npm/opencode-apex@*`.
3. Start OpenCode again. The first time a directory is used, it installs apex again
   (this takes a few seconds).

In OpenCode 2.1.1, `opencode plugin update` only manages **TUI** plugins (those in
`cli.json`). For apex it answers `Plugin is not configured`, so use the steps above.

A breaking OpenCode 3.x is deliberately **not** covered by the `^2` ranges: it would need
code changes, not just new dependencies.

## RPC calls fail

apex's RPC methods are HTTP endpoints of the OpenCode server:

```
POST <server>/api/rpc/apex/<method>?location%5Bdirectory%5D=<url-encoded project dir>
Authorization: Basic <base64 of "opencode:<server password>">
Content-Type: application/json

{"input": { … }}
```

The `apex_callback_endpoint` tool prints the exact URLs, and tells you where the
password is stored, for the current project.

| Response | Cause | Fix |
| --- | --- | --- |
| `401 Unauthorized` | No or wrong Basic auth | Username `opencode`, plus the server password (see `apex_callback_endpoint` → `auth.password`). |
| `rpc.unavailable` — "RPC is unavailable: apex" | apex is not loaded **in the directory you targeted**: it failed to load (see above), it is configured only for another project, or the location parameter is wrong | Check the log. Use `location[directory]=…` (URL-encoded `location%5Bdirectory%5D=`). `?directory=` is **ignored**. |
| The call works but acts on the wrong project | The location parameter was missing or misspelled, so the server used its **default** directory | Same fix: always send `location[directory]`. |
| `rpc.invalid_input` — e.g. `Missing key at ["payload"]` | The body does not match the method | The body must be `{"input": {…}}`. `events.ingest` needs `source` and `payload`; `tools.run` needs `tool`. |
| `rpc.unavailable` with apex **0.1.x** | 0.1.x registered its RPC under the wrong key and never worked on OpenCode 2.1 | Upgrade apex (see the reinstall steps). |
| `events.ingest` returns an `error` about the events module being disabled | `modules.events` is `false` | Turn the module on. |

## `events.ingest` succeeds but nobody wakes up

`{"accepted": true, "delivered": []}` means the event was received but **no subscription
matched it**.

- Check the subscription's `filters` against the event's `type` and `source`.
- A subscription with an empty `sessionID` is bound to the project's **main session**
  (the root session you opened). If that session was deleted, there is nothing to
  deliver to until a new root session appears. For long-running automations, give the
  subscription an explicit `sessionID`.
- `deliverAs: "synthetic"` with `resume: false` only *stores* the message; the agent
  reads it on its next turn. Use `deliverAs: "prompt"`, or `resume: true`, to wake it.
- Re-sending the same `eventID` within 5 minutes is deduplicated on purpose: the second
  call returns `delivered: []`.

## Automations stop after an hour, or after a restart

This is expected OpenCode V2 behavior, not an apex bug. OpenCode loads plugins **per
project directory** and **unloads** a directory's plugins after **60 minutes without
session activity** there. The value is fixed in OpenCode 2.1.1. After a restart, nothing
is loaded until something uses that directory.

So nothing that runs *inside* the plugin survives on its own: timers, open ports,
watchers. apex 0.2.0 removed its HTTP listener for exactly this reason. What does
survive is the **RPC**: the server waits for the directory's plugins and loads them if
needed, as part of the call itself.

**Rule:** keep the clock (cron, systemd timer) and the door (webhook relay, n8n)
**outside** OpenCode, and have them call the RPC. The bundled `apex-callbacks` skill
explains the pattern step by step.

## The first call is slow

- **First use after installing or upgrading:** OpenCode downloads apex and its
  dependencies from npm. Expect 20–30 s once.
- **First call to a directory that is not loaded** (idle unload or restart): the server
  loads every plugin of that directory first, about 5 s. Later calls are fast.
- Scripts should use generous timeouts and retry with backoff on that first call.

## `tools.run` fails

| `error` | Cause | Fix |
| --- | --- | --- |
| `tool denied for tools.run (events.tools.deny): …` | The tool matches `events.tools.deny` (`question`, `subagent`, `execute` and `apex_*` by default) | Adjust `events.tools.deny` if you really need it. |
| `tool not in events.tools.allow: …` | The tool is not in `events.tools.allow` | Add it, or a glob such as `easypanel_*`. |
| `tool not registered in this project: …` | No tool with that exact id in this project, e.g. an MCP server not enabled there | Use the exact tool id as the agent sees it (MCP tools are usually `<server>_<tool>`). |
| `timed out after … ms` | The permission check answered "ask" and nobody approved it | Add an `allow` rule for that action to the agent in `events.tools.agent` (default `build`), or enable the apex advisor. |
| A generic message such as `Unable to write …` | The tool ran but was blocked by a permission rule (`deny`) or failed | Check that agent's permissions, and the log. |
| `tools.run is disabled (events.tools.enabled=false)` | Turned off in config | Set `events.tools.enabled: true`. |

## Configuration does not seem to apply

apex merges three sources. Each one overrides the previous:

1. `~/.config/opencode/opencode-apex.jsonc` — global file
2. the `options` object of the apex entry in `opencode.json` — global and project
   `opencode.json` are already merged by OpenCode
3. `<project>/.opencode/opencode-apex.jsonc` — project file

- The `[apex] config: inline=… global=… local=…` log line shows which ones were found.
- An invalid config is reported (`[apex] … inválida`) and apex falls back to defaults.
- Keys that no longer exist are ignored with a warning: `events.enabled` (use
  `modules.events`), `events.listener` (removed in 0.2.0).
- Modules are switched on and off **only** in `modules` (`"modules": { "guard": true }`).
- Config is read when the plugin loads: after editing, restart OpenCode or wait for the
  directory to reload.

## The browser tools say "No desktop browser is connected"

See [BROWSER.md](BROWSER.md): a session only gets a browser after `browser_target` or
`/browser-target` asks for one.

---

# Developer notes

## Running a local checkout

Point OpenCode at the plugin **directory** (not a file):

```jsonc
// opencode.json
{ "plugins": [{ "package": "/path/to/opencode-apex" }] }
```

Then, in that directory:

```bash
bun install
npm run typecheck                 # tsc --noEmit
npm test                          # events + guard suites
npm run check:install             # install like OpenCode does: one effect copy, plugin imports
bun -e "await import('./index.ts'); console.log('OK')"   # load smoke test
TEST_CDP_URL=9333 bun test test/browser.test.ts          # needs a Chromium with CDP on that port
```

`prepublishOnly` runs `test`, `typecheck` and `check:install`. A misaligned dependency
cannot be published.

To watch the plugin load, run a throwaway server in the foreground:
`opencode serve --port 4096 --print-logs --log-level info`.

## Rules that keep apex loading

- **V2 imports only:** `@opencode/plugin` and `@opencode/plugin/effect`, never the V1
  package `@opencode-ai/plugin`.
- **No own `effect` version** (see the version mismatch section above). OpenCode serves
  `effect` and `@opencode/plugin` to plugins. Import them freely, but never declare `effect`
  as a regular dependency.
- **Keep `@opencode/plugin` current.** It is the package that pulls the `@opencode/schema`
  and `@opencode/client` matching the host. Keep its range in step with the OpenCode
  versions you support.
- **Tool and RPC schemas are plain JSON Schema**, not `Schema.Struct` from `effect`.
  OpenCode validates them with its own `effect`. A schema object built by another copy
  is not recognized, and the plugin is disabled with
  `undefined is not an object (evaluating 'ast._tag')`.
- **The RPC definition needs an `id`** (`{ id: "apex", methods, events }`). OpenCode
  registers RPCs by `id`.
- **The plugin must start with no configuration at all.** A missing config file means
  defaults, and every field of the Zod schema in `core/config.ts` has a `.default()`.
  Never add a required top-level field.
- **No per-directory state at module level.** The module is imported once per process
  and registered once per directory, so mutable state belongs inside `register()`.
- **The event bus is global.** `ctx.event.subscribe()` delivers events from every
  directory. Filter session events by `event.location.directory`.

## Effect 4, not 3

The API names changed: `Effect.catch` (not `catchAll`), `Effect.andThen` (not
`zipRight`), `Effect.promise`, `Stream.tap` / `Stream.runDrain` / `Effect.forkScoped`.
Each module exports `register(ctx, config): Effect<…, never, Scope>`. Registrations use
`yield* ctx.tool.transform(…)`, `ctx.session.hook(…)` or `ctx.permission.hook(…)`, and
cleanup goes in `Effect.addFinalizer`.

## Bun quirks

- **`bun -e` resolves bare imports from the current directory**, not from the imported
  file. Run smoke tests from the plugin directory, or `effect` will not be found.
- **`bun install` can hang silently** when `package.json` references a package that does
  not exist on npm. Check with `npm view <pkg> version` first.
- **Type-only re-exports must be marked:** `export { apexBus, ApexBus }` fails at run time
  if `ApexBus` is a type. Write `export { apexBus }` plus `export type { ApexBus }`.
- **Stale `node_modules` symlinks** (for example to a temporary test directory) cause
  `Not a directory` errors when loading. Remove them before debugging anything else.

## The editor will not catch these — the runtime will

The TypeScript language server reported zero errors on builds that failed to load:

1. importing a name that another file does not export;
2. type-only re-exports in a value position (see above).

Always run the load smoke test and `npm run typecheck` before calling a change done.

## Checklist for a new module

- [ ] Imports only from `@opencode/plugin` (V2)
- [ ] `bun -e "await import('./<module>.ts')"` passes from the plugin directory
- [ ] Names imported from other modules really exist (grep, do not trust the editor)
- [ ] Type re-exports use `export type { … }`
- [ ] New runtime dependencies are in `package.json`, and `npm run check:install` passes
- [ ] Tool and RPC schemas are JSON Schema
- [ ] No module-level per-directory state; events filtered by directory
- [ ] Config fields have defaults; the module is switched by `modules.<name>`
- [ ] `npm test` and `npm run typecheck` pass
- [ ] No new `as any`, `@ts-ignore` or `globalThis` hacks
