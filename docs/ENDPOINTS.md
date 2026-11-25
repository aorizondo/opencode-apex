# Endpoints: OpenTunnel routes and verified webhooks

This module lets agents receive webhooks and publish local ports on public HTTPS URLs. Each one can be temporary (it has a TTL) or permanent. The agent-facing guide is the packaged skill `apex-endpoints`.

## Architecture

```
 Internet ─HTTPS─▶ OpenTunnel ─▶ apex daemon ─┬─ webhook listener (127.0.0.1) ── verify ──▶ POST events.ingest (local, Basic auth)
                   <route>.<id>.opentunnel.xyz └─ route ──▶ any local port
                                 control API (127.0.0.1, token; never routed) ◀── plugin tools
```

- **Why a daemon?** OpenCode unloads a directory's plugins after 60 minutes without activity, and a tunnel or listener inside the plugin dies with it.
  - The daemon is a separate process, **one per user**, and a lockfile keeps it that way.
  - The plugin launches it detached on the first `apex_webhook` / `apex_tunnel` call, and again on plugin load whenever its registry is not empty.
  - It exits after 10 minutes with nothing to keep.
  - After a reboot, it comes back when apex loads in any project.
- **Runtime:** OpenCode's own executable in bun mode (`BUN_BE_BUN=1`).
  - Nothing to install, and it runs on every platform OpenCode runs on.
  - No systemd or launchd involved.
- **Tunnel:** the `@opentunnel/client` SDK, which is pure JavaScript.
  - It uses the device's `default` profile, the same tunnel OpenCode remote access uses, and claims **its own routes**.
  - Routes are cheap; new tunnels are limited to about 30 per hour per IP.
  - On a device without a tunnel, the first use issues its certificate, which takes about a minute.
- **Webhooks:** the daemon is the intermediate program between the Internet and OpenCode's RPC.
  - Each webhook has its own random route and secret.
  - The listener verifies the signature or token in constant time.
  - Only then does it call `events.ingest` on loopback. The server password never leaves the machine.
- **TTL:** every 15 seconds the daemon removes expired routes and webhooks, along with each webhook's secret file. This happens even with OpenCode closed.
- **Updates:** a plugin with a newer version stops the old daemon and starts its own. The registry is kept.

## Files

They live in `<XDG_STATE_HOME or ~/.local/state>/opencode-apex/` on every OS. `APEX_DAEMON_HOME` overrides the location.

| File | What |
| --- | --- |
| `daemon.json` (0600) | pid, control port, control token, version |
| `daemon.lock` | single-instance lock (pid) |
| `registry.json` (0600) | tunnels, webhooks (with their secrets), how to reach each project's server |
| `secrets/<hook>.secret` (0600) | each webhook's secret, for configuring the sender without pasting it |
| `daemon.log` | daemon log |

## Security

- The control API listens on 127.0.0.1 and needs a token from a 0600 file. The tunnel never routes it.
- Behind OpenTunnel, every request arrives from 127.0.0.1 with a `Host` the visitor chose. The webhook listener uses `Host` only to **select** a webhook; the signature decides.
- Whatever you publish with `apex_tunnel` must authenticate its own requests: a random route is not authentication.
- Webhook secrets are never returned by the tools, only `secretFile`.
- Publishing the OpenCode server's own port is refused. Use OpenCode remote access (`opencode service set remote true`), which has its own password.

## Network

The daemon inherits OpenCode's environment:

- `HTTPS_PROXY` / `NO_PROXY` and `OPENTUNNEL_CA_CERT` apply. OpenTunnel does not support a SOCKS proxy.
- `OPENTUNNEL_API` points the daemon at a self-hosted OpenTunnel server.

After changing any of these, run `apex_daemon({action:"stop"})`; the next tool call starts the daemon with the new values.

## Turning it off

- `"modules": { "endpoints": false }` removes the tools, and the plugin no longer launches the daemon.
- `apex_daemon({action:"stop"})` stops a running daemon.
