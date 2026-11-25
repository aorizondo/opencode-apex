---
name: apex-endpoints
description: Expose things to the Internet and keep them running with opencode-apex, on any OS, without systemd, launchd or a tunnel CLI. Use it when the agent must receive a webhook (GitHub, Stripe, Slack, n8n, any HMAC or token sender), publish a local port on a public HTTPS URL (temporary for a demo or test, or permanent), or write and run its own microservice or API that reacts to external calls and wakes agents. Tools apex_webhook, apex_tunnel, apex_service and apex_daemon, all through OpenTunnel (the makers of OpenCode) and the apex daemon.
---

# Public endpoints and microservices (apex daemon + OpenTunnel)

## The model

```
 Internet ──HTTPS──▶ OpenTunnel ──▶ apex daemon (one per user, outside OpenCode)
                     <route>.<id>.opentunnel.xyz   ├─ webhook receiver: verify signature → events.ingest (local) → subscription → agent
                                                    ├─ route → your microservice (127.0.0.1:PORT)  ─ APEX_INGEST_URL ─▶ agent
                                                    └─ route → any local port
```

- **The apex daemon** keeps everything alive. It is one process per user, launched by the plugin with OpenCode's own binary. It survives the 60-minute plugin unload and OpenCode restarts, and works with any init system and on Windows. It starts on the first tool call. With nothing left to keep, it exits after 10 minutes.
- **OpenTunnel:** the daemon adds its **own routes** to this device's tunnel, the same one OpenCode remote access uses. Routes are cheap: new tunnels are limited to about 30 per hour per IP, routes are not. TLS ends on this machine.
- **Every entry** (webhook, tunnel, service) belongs to this project. It is either **temporary** (`ttlMinutes`) or **permanent** (no TTL), and the daemon removes temporary ones on time, even if OpenCode is closed.

## Pick the tool

| You need | Use |
| --- | --- |
| A service (GitHub, Stripe, Slack, n8n, a form…) must call in and wake an agent | **`apex_webhook`**: no code at all |
| An API or microservice you write, running in the background | **`apex_service`** (`public: true` to give it a URL) |
| A port you already started (dev server, demo, test) on a public URL | **`apex_tunnel`** |
| A sender **you control** on another machine must call OpenCode's RPC itself | Not this skill: OpenCode remote access (skill `apex-callbacks`, Step 3) |

Prefer a source's **outbound** mode (WebSocket, polling…) when it has one. Nothing is exposed then (skill `apex-callbacks`).

## Webhooks: `apex_webhook`

1. **Subscribe first**, so the first event lands somewhere: `apex_subscribe` with filters on `source` (and `type`), and a template that says the payload is third-party data.
2. **Create:**
   ```jsonc
   apex_webhook({ "action": "create", "name": "gh-acme-api", "provider": "github", "ttlMinutes": 0 })
   // → { url, secretFile, secretShell: "cat '<file>'", source: "github", route, next }
   ```
   - `provider`:
     - `github`: `X-Hub-Signature-256`.
     - `stripe`: `Stripe-Signature`, with a 5-minute replay window. Pass its `whsec_…` as `secret`.
     - `slack`: signing secret, with a 5-minute replay window. Pass it as `secret`. The `url_verification` challenge is answered for you.
     - `hmac`: HMAC-SHA256 of the raw body, hex or base64, in `header` (default `X-Signature`); a `sha256=` prefix is accepted.
     - `token`: `Authorization: Bearer`, `X-Apex-Token` or `?token=`. Use it for senders that cannot sign (n8n, curl, IFTTT).
   - Without `secret`, a random one is generated. **It is never returned**: only `secretFile` (`0600`). Configure the sender by reading the file at run time, for example `gh api repos/OWNER/REPO/hooks -f config[url]=<url> -f config[secret]="$(cat '<secretFile>')" -f config[content_type]=json -f 'events[]=pull_request'`. Never paste the secret in the chat.
3. **What the agent receives:**
   - `source`: the provider, or your `source`.
   - `type`, by provider:
     - GitHub: `pull_request.opened`.
     - Stripe: `invoice.paid`.
     - Slack: the event type.
     - hmac and token: `X-Event-Type`, else `payload.type`.
   - `eventID`: `<name>:<delivery id>`. A redelivery is not delivered twice.
   - `payload`: the parsed body, plus `_webhook: {name, provider, headers}`. Signatures and tokens are left out of `headers`.
4. **Replies to the sender:**
   - `202`: verified and delivered.
   - `401`: bad or missing signature. Nothing is delivered.
   - `503`: OpenCode is down. Stripe and Slack retry; GitHub shows the failure under "Recent deliveries".
5. **Check:** `apex_webhook({action:"list"})` shows `stats` (`ok` / `rejected` / `failed`, `lastError`). Send one real test delivery and watch the agent wake up.

## Microservices: `apex_service`

Write the service in any language. Contract:
- **Listen on `127.0.0.1:$PORT`.** The tunnel reaches loopback, and binding to `0.0.0.0` exposes it to the LAN too.
- **Authenticate every request.** Behind the tunnel, every request comes from `127.0.0.1` with a `Host` the visitor chose, so "is it local?" checks are worthless. A random route is not authentication.
- **To wake agents:** `POST $APEX_INGEST_URL` with `Authorization: Bearer $APEX_INGEST_TOKEN` and `{"source"?, "type", "eventID"?, "payload"}`. It reaches this project's `events.ingest` without the OpenCode password. The default `source` is `service:<name>`.
- **Other variables:** `APEX_PUBLIC_URL` (when public) and `APEX_SERVICE_NAME`, plus your `env`. Keep secrets in `0600` files read at start, not in `env`: the registry is private, but `env` is shown by `list` (keys only).
- **Logs:** print them to stdout/stderr; they go to `<state>/opencode-apex/logs/<name>.log`.

```jsonc
apex_service({ "action": "up", "name": "invoice-api", "command": "node server.mjs", "port": 8787,
               "public": true, "restart": "always", "ttlMinutes": 120 })
// → { id, status: "running", pid, url, logFile }
apex_service({ "action": "logs", "id": "invoice-api", "lines": 50 })
apex_service({ "action": "restart", "id": "invoice-api" })   // after editing the code
apex_service({ "action": "down", "id": "invoice-api" })      // stops it and removes its route
```

- `restart`:
  - `always` (default): restarts with backoff from 1 s up to 60 s. The counter resets after a minute up.
  - `on-failure`: restarts only on a non-zero exit.
  - `never`: one run (for a batch job).
- `command` is a shell line: `sh -c` on Unix, `cmd /c` on Windows. `cwd` defaults to the project.
- Services keep running while the daemon restarts or updates: the new daemon adopts them.

## Ports: `apex_tunnel`

```jsonc
apex_tunnel({ "action": "open", "port": 5173, "ttlMinutes": 30 })          // → { id, route, url }
apex_tunnel({ "action": "open", "port": 3000, "name": "demo" })            // https://demo.<id>.opentunnel.xyz, permanent
apex_tunnel({ "action": "list" })  ·  apex_tunnel({ "action": "close", "id": "<id or route>" })
```

- Routes are random by default: 16 hex characters that never appear in certificate logs. Use `name` only when a readable URL matters.
- `proxyProtocol: "v2"` sends the visitor's IP to the app. Set it only if the app expects a PROXY header.
- The OpenCode server port is refused: that is what remote access is for.

## Temporary or permanent

- **Temporary:** always set `ttlMinutes` for tests, demos, one-off callbacks (an OAuth redirect, a payment test) and anything "for now". The daemon removes the entry on time: a webhook loses its URL and secret file, a service is stopped.
- **Permanent:** omit `ttlMinutes` only when the user wants it to stay. Then tell them how to remove it (`down`, `delete`, `close`).
- **After a reboot,** the daemon comes back when apex loads in any project. To bring it back at boot without that, run `apex_daemon({action:"autostart", enabled:true})` once. It uses `cron @reboot` on Linux, macOS and BSD (any init system: systemd, sysvinit, antiX…) and a logon task on Windows. Ask the user before turning it on.
- The URL stays the same while the device tunnel exists, so the entry keeps its URL across restarts.

## When it is not reachable

`apex_daemon({action:"status"})` returns:
- `tunnel.state`:
  - `connected`: everything is fine.
  - `provisioning`: first tunnel on this device; the certificate takes about 1 minute, then `url` appears in `list`.
  - `reconnecting`: the network dropped; it retries on its own.
  - `error`: read `lastError`.
- the entries the daemon keeps, the `log` file, and `autostart`.

Corporate proxy or custom CA:
- the daemon honours `HTTPS_PROXY` / `NO_PROXY` and `OPENTUNNEL_CA_CERT`;
- a SOCKS proxy is not supported;
- for a self-hosted OpenTunnel server, set `OPENTUNNEL_API` in OpenCode's environment, then `apex_daemon({action:"stop"})` so it restarts with it.

## Before you call it done

1. One real request through the public `url`: an actual delivery for a webhook, `curl -i <url>` with credentials for a service.
2. A **bad** request is refused (wrong signature or token: `401`).
3. Tell the user:
   - the URL and what it reaches;
   - temporary (until when) or permanent;
   - where the logs are;
   - how to remove it;
   - the subscription id, if any.
