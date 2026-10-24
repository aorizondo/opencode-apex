# Changelog

All notable changes to `opencode-apex`. Format based on
[Keep a Changelog](https://keepachangelog.com/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- The guard's built-in rules for `apex-advisor` were dropped: the validated config always
  carries `guard.agents: {}`, and a shallow merge replaced the defaults. `agents` is now
  merged per agent.
- `{{payload}}` (the whole payload as JSON) was not substituted in prompt templates. The
  default template uses it, so its prompts came out with the literal placeholder.
- `apex_list_subscriptions` now also lists the subscriptions from config (`readonly: true`),
  as its description already said.
- The `apex_subscribe` tool described `agent` as a filter. It is the agent the target session
  is switched to before delivery.
- The `redact.process` RPC ignored `redact.allowlist`.
- `~/` was not expanded in `browser.profile` or in `redact.key: "file:~/…"`.
- Config files with syntax errors were applied partially without any notice. apex now logs
  `config syntax errors in <file> (… @ line N)`.
- The `browser_target` tool description claimed a `profile` needs no remote debugging. It
  does: apex reads that profile's `DevToolsActivePort`.
- The template `opencode-apex.jsonc` was invalid JSONC: a multi-line string was silently
  cut. Its `in` filter example also used a wildcard that `in` doesn't support.

### Changed

- Runtime messages of `tools.run`, server discovery, compatibility warnings and the events
  tool descriptions are now in English.
- The documentation is now in English and written for readers new to OpenCode plugins and RPC.
  It states that apex is **OpenCode V2 only (≥ 2.1)**.
- Added an MIT license, and repository metadata pointing to
  https://github.com/aorizondo/opencode-apex.

## [0.2.1] — 2026-10-23

### Fixed

- The version-mismatch warning recommended `opencode plugin update`. In OpenCode 2.1 that
  command only handles TUI plugins, and for server plugins it answers `Plugin is not
  configured`. The warning now gives the procedure that works: stop OpenCode, delete
  `~/.cache/opencode/npm/opencode-apex@*`, start it again.

## [0.2.0] — 2026-10-23

Automations that survive OpenCode V2 unloading plugins: everything comes in through the
server's RPC.

### Breaking

- **Plain HTTP listener removed** (`events.listener`, port 4599). OpenCode unloads a project's
  plugins after 60 minutes without session activity, and the listener closed with the plugin.
  The key is now ignored with a warning. Callbacks come in through `apex/events.ingest`;
  webhooks come in through a relay (n8n or a small daemon) that calls that RPC.
- `apex_set_callback_url` now sets the **server's public URL**, for senders on other machines
  (a tunnel or reverse proxy to the server's base URL). It used to set the listener's URL.
- `apex.status` returns `endpoint` instead of `callback`.

### Fixed

- **The `apex` RPC was never registered on OpenCode ≥ 2.1.** The definition used `name`, but
  V2 indexes RPCs by `id`, so every call returned `rpc.unavailable`.
- **State shared across projects.** The module is imported once per process, yet the main
  session, the ingest handler and the dedup cache were module-level variables. One project
  could deliver events into another project's session, and unloading one project broke
  ingest for the others. The state is now per project.
- **Binding to another project's session.** OpenCode's event bus is global, so every apex
  instance also bound to new sessions of *other* projects. Events from other projects are
  now ignored.
- **Did not load on OpenCode 2.1.** apex pinned `effect` 4.0.0-rc.112, while
  `@opencode/plugin` 2.1 uses 4.0.1 (`Schema.isStartsWith is not a function`).

### Added

- **`apex/tools.run` RPC.** An external program runs one OpenCode tool (built-in, plugin or
  MCP), with no model involved.
  - Configured in `events.tools`: `allow`, `deny`, the `agent` whose permissions apply, and
    `timeoutMs`.
  - Runs in a hidden per-project runner session (agent `apex-runner`).
- **Server discovery:** the `apex_callback_endpoint` tool and the `server.info` RPC.
  - They return the base URL, the project's RPC URLs, Basic auth and *where* to read the
    password (never the password itself), plus curl examples.
  - The base URL comes from `events.server.url`, then the background service record (matched
    by pid), then `opencode serve --port`.
- **The `apex-callbacks` skill ships with the package** and registers itself. It covers
  stateful watchers, systemd/cron, the webhook relay and n8n, and `tools.run`.
- **Staying compatible with OpenCode releases.**
  - `effect` is no longer a direct dependency: it is an optional peer, satisfied by
    `@opencode/plugin`'s copy.
  - `@opencode/plugin` and `@opencode/plugin-browser` use `^2.1.1`.
  - Load-time warning (`core/compat.ts`) when there are two copies of `effect`, or when
    OpenCode is newer than the installed `@opencode/plugin`.
  - `prepublishOnly` installs the package the way OpenCode does and fails if the
    dependencies drift (see docs/TROUBLESHOOTING.md).
- Tests in `test/events.test.ts`, and the `npm test`, `npm run typecheck` and
  `npm run check:install` scripts.

## [0.1.0]

First published version.
