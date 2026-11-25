# Endpoints: OpenTunnel routes, verified webhooks and microservices

With this module, agents can:
- receive webhooks;
- publish local ports on public HTTPS URLs;
- run microservices they write themselves.

Each of these can be temporary (with a TTL) or permanent. The agent-facing guide is the packaged skill `apex-endpoints`. This page covers how the module works and how to run it.

## Architecture

```
 Internet ─HTTPS─▶ OpenTunnel ─▶ apex daemon ─┬─ webhook listener (127.0.0.1) ── verify ──▶ POST events.ingest (local, Basic auth)
                   <route>.<id>.opentunnel.xyz ├─ route ──▶ microservice 127.0.0.1:PORT
                                               └─ route ──▶ any local port
                                 control API (127.0.0.1, token; never routed) ◀── plugin tools
```

- **Why a daemon?** OpenCode unloads a directory's plugins after 60 minutes without activity, and a tunnel or listener inside the plugin dies with it.
  - The daemon is a separate process, **one per user**.
  - The plugin launches it detached on the first `apex_webhook` / `apex_tunnel` / `apex_service` call, and again on plugin load whenever its registry is not empty.
  - A lockfile ensures there is only one.
  - It exits after 10 minutes with nothing to keep.
- **Runtime:** OpenCode's own executable in bun mode (`BUN_BE_BUN=1`). Nothing extra to install, and it works on every platform OpenCode runs on. It uses no systemd and no launchd.
- **Tunnel:** the daemon uses the `@opentunnel/client` SDK (pure JavaScript, so it also works on Windows). It connects to the device's `default` profile, the same tunnel OpenCode remote access uses, and claims **its own routes**.
  - Routes are cheap. New tunnels are not: about 30 per hour per IP.
  - The first use on a device without a tunnel issues its certificate, which takes about a minute.
- **Webhooks:** the daemon is the intermediate program between the Internet and OpenCode's RPC.
  - Each webhook has its own random route and secret.
  - The listener verifies the signature or token in constant time.
  - Only then does it call `events.ingest` on loopback. The server password never leaves the machine.
- **Microservices:** started with `sh -c` / `cmd /c` in their own process group.
  - Their output goes straight to `logs/<name>.log`.
  - They restart with backoff from 1 s up to 60 s, according to `restart`.
  - When the daemon restarts (an update, a crash), the new one **adopts** live services by pid and boot stamp instead of restarting them.
  - Services wake agents through the daemon's local `/v1/ingest` with their own token (`APEX_INGEST_URL`, `APEX_INGEST_TOKEN`).
- **TTL:** the daemon removes expired entries every 15 seconds, even with OpenCode closed:
  - a tunnel's route is removed;
  - a webhook's route and secret file are removed;
  - a service is stopped and its route removed.
- **Updates:** a plugin with a newer version asks the old daemon to exit and starts its own. Services keep running and are adopted.

## Files

`<XDG_STATE_HOME or ~/.local/state>/opencode-apex/`, on every OS. `APEX_DAEMON_HOME` overrides it.

| File | What |
| --- | --- |
| `daemon.json` (0600) | pid, control port, control token, version |
| `daemon.lock` | single-instance lock (pid) |
| `registry.json` (0600) | tunnels, webhooks (with their secrets), services, how to reach each project's server |
| `secrets/<hook>.secret` (0600) | each webhook's secret, for configuring the sender without pasting it |
| `daemon.log` | daemon log |
| `logs/<service>.log` | each service's stdout/stderr (rotated at 10 MB) |
| `launch.sh` / `launch.cmd` | launcher used by autostart, rewritten with current paths on every launch |

## Autostart after a reboot

Without autostart, the daemon comes back as soon as apex loads in any project. `apex_daemon({action:"autostart", enabled:true})` makes it start at boot:

- **Linux / macOS / BSD:** a `@reboot` line in the user's crontab, tagged `# opencode-apex-daemon`. It works with any init system (systemd, sysvinit, OpenRC, runit, antiX…) and needs `cron` installed.
- **Windows:** a scheduled task `opencode-apex-daemon` that runs at logon (`schtasks /SC ONLOGON`).

`enabled:false` removes only that line or task.

## Security

- The control API listens on 127.0.0.1 and requires a token from a 0600 file. The tunnel never routes it.
- Behind OpenTunnel, every request arrives from 127.0.0.1 with a `Host` the visitor chose. The webhook listener uses `Host` only to **select** a webhook; the signature decides.
- Services must authenticate their own requests: a random route is not authentication.
- Tool output never contains secrets: webhook secrets are returned as `secretFile` only, and services' ingest tokens and `env` values are never returned.
- Services inherit the daemon's environment **minus** `OPENCODE_SERVER_PASSWORD` / `OPENCODE_PASSWORD`.
- Publishing the OpenCode server's own port is refused. Use OpenCode remote access (`opencode service set remote true`), which has its own password.

## Network

The daemon inherits OpenCode's environment:
- `HTTPS_PROXY` / `NO_PROXY` and `OPENTUNNEL_CA_CERT` apply. A SOCKS proxy is not supported by OpenTunnel.
- `OPENTUNNEL_API` points it at a self-hosted OpenTunnel server.

After changing any of these, run `apex_daemon({action:"stop"})`; the next tool call starts the daemon with the new values.

## Turning it off

`"modules": { "endpoints": false }` removes the four tools, and the plugin no longer launches the daemon. To stop a running daemon and its services:
1. `apex_service({action:"down"})` for each service;
2. `apex_daemon({action:"stop"})`.
