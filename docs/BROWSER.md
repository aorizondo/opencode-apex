# Browser module — drive an external Chromium with OpenCode's `browser` tools

> **OpenCode V2 only (2.1 or newer).** OpenCode V1 has a different plugin system and
> cannot load apex.

## The problem it solves

OpenCode V2 ships a set of **browser tools** — open a tab, take a snapshot of the page,
click, fill a form, read the console, and so on (45 operations). The agent sees them as
`browser_tabs_open`, `browser_snapshot`, `browser_click`… (in Code Mode, as
`tools.browser.tabs.open(…)`, `tools.browser.snapshot(…)`…).

Out of the box those tools need a **browser attached to the session**, and only the
OpenCode **desktop app** attaches one: it has a built-in browser pane. On a headless
server, in the terminal UI, or when you simply want the agent to use *your* Chrome,
nothing is attached and every browser tool fails with:

```
[browser.disconnected] No desktop browser is connected to this session.
```

The browser module attaches a **Chromium-based browser of your choice** (Chrome,
Chromium, Edge, Brave…) instead. It talks to that browser over the **Chrome DevTools
Protocol (CDP)**: a WebSocket interface Chromium exposes when remote debugging is
enabled, the same one DevTools and Puppeteer use.

It does not replace or wrap any OpenCode tool: names, input schemas, permissions and
descriptions are still OpenCode's own. apex only provides the browser behind them.

## Quick start

1. Start a Chromium with remote debugging on a port, using its **own** profile directory
   (see [Chrome's two remote-debugging modes](#chromes-two-remote-debugging-modes) for
   why):

   ```bash
   google-chrome --remote-debugging-port=9333 --user-data-dir="$HOME/.cache/apex-chrome"
   ```

   Port 9333 rather than the usual 9222: a stale `DevToolsActivePort` file from your
   everyday Chrome often still claims 9222.

2. Make sure the module is on (it is by default) and point it at that port:

   ```jsonc
   // in the apex options (see docs/CONFIG.md)
   {
     "modules": { "browser": true },
     "browser": { "mode": "external", "cdpUrl": "9333" }
   }
   ```

3. In a session, **ask for the browser once**:
   - the agent calls the `browser_target` tool, for example `browser_target({ mode: "external" })`;
   - or you type the command `/browser-target external`.

   From then on that session's browser tools run against your Chromium.

Nothing attaches until step 3. Loading the plugin never opens a connection by itself,
so it never triggers an unexpected "Allow remote debugging?" prompt.

## Choosing who serves the browser

OpenCode allows **one browser attachment per session**: a new attachment replaces the
previous one. So apex and the desktop app never serve the same session at the same
time, and "choosing a browser" really means choosing **who attaches**:

| Mode | What apex does | Who serves the browser tools |
| --- | --- | --- |
| `in-app` | never attaches, and releases any attachment it holds in that session | the desktop app's built-in browser |
| `external` | attaches when asked (tool or command) | apex, with your Chromium; the desktop app is told its pane was replaced |
| `auto` (default) | nothing until asked; once asked, the same as `external` | apex, after the first request |

You can switch at any time without reloading anything:

- **Agent:** `browser_target({ mode: "external" | "in-app" | "auto" })`
- **You:** `/browser-target external` (or `in-app`, `auto`)

The mode set by the tool or the command wins over the config value, until the plugin
reloads.

Asking again in a session that is already attached does nothing: the connection is
**not** restarted. After an attachment is replaced (for example the desktop app took the
session), apex re-attaches by itself after `reconnectSeconds` unless the mode is `in-app`.

## Choosing where the browser is

The destination can come from the config (the default) or from the tool or command at
run time; run-time values win.

**Config:**

```jsonc
"browser": {
  "mode": "external",
  "cdpUrl": "auto",   // "auto" | a port like "9222" | "ws://host:port/path" | "wss://…"
  "profile": "",      // a Chromium user-data directory; wins over cdpUrl
  "headers": {},      // extra headers for a wss:// endpoint behind a proxy
  "caFile": "",       // CA certificate for that proxy
  "insecureSkipVerify": false
}
```

**At run time:**

```
browser_target({ mode: "external", cdpUrl: "9333" })
browser_target({ mode: "external", cdpUrl: "wss://tunnel.example/devtools" })
browser_target({ mode: "external", profile: "/home/you/.config/google-chrome" })

/browser-target external 9333
/browser-target external wss://tunnel.example/devtools
/browser-target external /home/you/.config/google-chrome
```

- In the command, a destination starting with `/` or `~` is read as a **profile
  directory**; anything else as a **URL or port**.
- Leaving the destination out keeps the current one.
- `profile: ""` goes back to discovery through `cdpUrl`.
- Profile paths may start with `~/` (your home directory), e.g. `~/.config/google-chrome`.

**How `cdpUrl` is resolved:**

| Value | What happens |
| --- | --- |
| `ws://…` / `wss://…` | used as is (a remote browser, usually behind a tunnel or proxy) |
| `profile` set | reads that profile's `DevToolsActivePort` file (written by Chrome while remote debugging is on) |
| `auto` | reads `DevToolsActivePort` from known Linux profiles under `~/.config` (Chrome, Chromium, Edge, Brave, BrowserOS, the OpenCode desktop app), preferring port 9222 |
| a port (`9222`) or `http://host:port` | finds the profile that declares that port, or falls back to asking `http://host:port/json/version` |

When several candidates match, they are tried **in order** and the first one that really
answers wins. When Chrome closes, it leaves its `DevToolsActivePort` file behind, so
several profiles can claim the same port while only one is listening.

Changing the destination **closes the CDP connection and drops every attachment**. The
session that made the change re-attaches in the same call; other sessions must ask
again with `browser_target`. This is unavoidable: each session's tab registry and
console/network buffers are tied to the old connection.

### Which destination to use

| You want | Do this |
| --- | --- |
| A browser just for the agent, no prompts | Start Chromium with `--remote-debugging-port=9333 --user-data-dir=<its own dir>` and set `cdpUrl: "9333"` |
| Your everyday Chrome, with its logins | Turn on the toggle at `chrome://inspect/#remote-debugging`, then `profile: "/home/you/.config/google-chrome"`. Chrome shows a consent prompt **for every new connection**. |
| A browser on another machine | Put a tunnel or reverse proxy in front of it and use `cdpUrl: "wss://…"`, with `headers` for its auth |

## Chrome's two remote-debugging modes

| How it is enabled | `GET /json/version` | Consent prompt | Notes |
| --- | --- | --- | --- |
| `--remote-debugging-port` flag | 200 | no | Ignored on Chrome's **default** profile since Chrome 136: use a separate `--user-data-dir` |
| Toggle at `chrome://inspect/#remote-debugging` | **404, by design** | **yes, per connection** | The WebSocket address is read from `DevToolsActivePort` |

A 404 from `/json/version` is not a misconfiguration: it is how the toggle mode works.

Because the toggle asks for consent **per connection**, apex opens the CDP connection
**once** and keeps it open. It never reconnects per command.

## A browser on another machine

Chrome's native CDP endpoint speaks neither TLS nor authentication: it is a plain,
unauthenticated WebSocket, and anyone who reaches it controls the browser. **Never
expose it directly.** Put a tunnel or reverse proxy in front of it (`ssh -L`, Tailscale,
cloudflared, nginx) and point apex at the `wss://` URL it publishes:

```jsonc
{
  "browser": {
    "cdpUrl": "wss://tunnel.example/devtools",
    "headers": { "Authorization": "Bearer …" },
    "caFile": "/path/to/ca.pem"          // only for a private CA
  }
}
```

`insecureSkipVerify: true` disables certificate checks. Use it only for a quick test.

## About the OpenCode desktop app's own profile

The desktop app's browser panes use **ephemeral partitions**: there is no persistent
browsing profile to reuse. Pointing `profile` at the app's data directory
(`~/.config/ai.opencode.desktop` on Linux) only works with the app **closed**. While it
runs it holds that directory's lock, and two processes on one user-data directory
corrupt its cookie database. For daily use, prefer a dedicated profile started with
`--remote-debugging-port`.

## What is supported

37 of the 45 browser operations. The other 8 return an `unsupported` error that says
why, instead of hanging until OpenCode's 60-second command timeout:

| Operation | Why not |
| --- | --- |
| `preview` | needs the desktop app's Review pane |
| `trace.analyze`, `cpu.analyze` | they analyze a capture's contents; apex returns the capture file, not an analyzer |
| `heap.summary`, `heap.query`, `heap.object`, `heap.compare` | same: the heap snapshot file is returned, not analyzed |
| `lighthouse` | needs a Lighthouse runtime, not just CDP |

Results are capped at **512,000 characters of JSON**, the same limit the desktop app's
browser applies. A bigger result fails with a message telling the agent what to reduce:
fewer items, a shallower snapshot, or only the needed fields.

## Configuration reference

```jsonc
{
  "modules": { "browser": true },     // on by default
  "browser": {
    "mode": "auto",                   // in-app | external | auto
    "cdpUrl": "auto",                 // "auto" | "9222" | "ws://…" | "wss://…"
    "profile": "",                    // "" = discover through cdpUrl
    "connectTimeoutMs": 90000,        // how long one connection attempt may take
    "reconnectSeconds": 15,           // wait before re-attaching after being replaced (0 = at once)
    "headers": {},                    // for wss:// behind a proxy
    "caFile": "",
    "insecureSkipVerify": false
  }
}
```

## Testing it

```bash
# No prompts: a throwaway headless Chromium with the flag
chromium --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/cdp-probe about:blank &
TEST_CDP_URL=9333 bun test test/browser.test.ts
```

With the Chrome toggle instead, use `TEST_CDP_URL=auto` and approve the prompt.

## Implementation notes (measured, not assumed)

For contributors. These are the non-obvious details that make the bridge work:

- **The tab inventory is published before each command is answered.** OpenCode validates
  `tabID` against *its* copy of the inventory. Without this, `tabs.open` returns an id
  OpenCode does not know yet and the next call fails with `tab_unavailable`. The desktop
  app does the same.
- **`attach` comes before `state`, and `state` is retried.** OpenCode only accepts
  `state` once the attachment exists, and the attachment is created inside `attach`,
  which does not return until it is closed (it is a long poll).
- **Releasing an attachment means interrupting the `attach` fiber**, not just forgetting
  it. The attachment lives in that call's scope. Clearing local state alone would leave
  OpenCode sending commands to a browser apex no longer controls.
- **Tab `sessionId`s are cached.** `Target.attachToTarget` returns a new one on every call.
  Without the cache each command opened a new CDP session, and the console and network
  buffers always came back empty.
- **The `command` event carries no `sessionID`**, only a `connectionID`, so commands are
  routed by `connectionID`.
- **File `data` travels as base64** and is decoded by the RPC layer.
- **`evaluate` with a `ref` is a function, not an expression.** It runs through
  `Runtime.callFunctionOn` on the resolved node.
