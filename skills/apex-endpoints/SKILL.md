---
name: apex-endpoints
description: Expose things to the Internet with opencode-apex, on any OS, without a tunnel CLI. Use it when the agent must receive a webhook (GitHub, Stripe, Slack, n8n, any HMAC or token sender) that wakes an agent, or publish a local port (a service, API or demo you started) on a public HTTPS URL, temporary or permanent. Tools apex_webhook, apex_tunnel and apex_daemon, through OpenTunnel (the makers of OpenCode) and the apex daemon.
---

# Public endpoints (apex daemon + OpenTunnel)

## The model

```
 Internet ──HTTPS──▶ OpenTunnel ──▶ apex daemon (one per user, outside OpenCode)
                     <route>.<id>.opentunnel.xyz   ├─ webhook: verify signature → events.ingest (local) → subscription → agent
                                                    └─ route → any local port (your service)
```

- **The apex daemon** keeps routes and webhooks alive. It is one process per user, launched by the plugin with OpenCode's own binary.
  - It survives the 60-minute plugin unload and OpenCode restarts.
  - It works with any init system and on Windows.
  - It starts on the first tool call. With nothing left to keep, it exits after 10 minutes.
  - After a reboot, it comes back when apex loads in any project.
- **OpenTunnel:** the daemon adds its **own routes** to this device's tunnel, the same one OpenCode remote access uses. TLS ends on this machine. New routes are cheap; new tunnels are limited to about 30 per hour per IP.
- **Every entry** belongs to this project. It is either **temporary** (`ttlMinutes`) or **permanent** (no TTL). The daemon removes temporary ones on time, even with OpenCode closed.

## Pick the tool

| You need | Use |
| --- | --- |
| A service (GitHub, Stripe, Slack, n8n, a form…) must call in and wake an agent | **`apex_webhook`**: no code at all |
| A port you started (your API, microservice, dev server, demo) on a public URL | **`apex_tunnel`** |
| A sender **you control** on another machine must call OpenCode's RPC itself | Not this skill: OpenCode remote access (skill `apex-callbacks`, Step 3) |

Prefer a source's **outbound** mode (WebSocket, polling…) when it has one. Nothing is exposed then (skill `apex-callbacks`).

## Webhooks: `apex_webhook`

1. **Subscribe first** with `apex_subscribe`, so the first event lands somewhere:
   - filter on `source` (and `type`);
   - in the template, say the payload is third-party data.
2. **Create:**
   ```jsonc
   apex_webhook({ "action": "create", "name": "gh-acme-api", "provider": "github", "ttlMinutes": 0 })
   // → { url, secretFile, secretShell: "cat '<file>'", source: "github", route, next }
   ```
   - `provider`:
     - `github`: `X-Hub-Signature-256`.
     - `stripe`: `Stripe-Signature`, with a 5-minute replay window. Pass its `whsec_…` as `secret`.
     - `slack`: signing secret, with a 5-minute replay window. Pass it as `secret`. The `url_verification` challenge is answered for you.
     - `hmac`: HMAC-SHA256 of the raw body, hex or base64, in `header` (default `X-Signature`). A `sha256=` prefix is accepted.
     - `token`: `Authorization: Bearer`, `X-Apex-Token` or `?token=`. For senders that cannot sign (n8n, curl, IFTTT).
   - Without `secret`, a random one is generated. **It is never returned**: you get only `secretFile` (`0600`).
   - Configure the sender by reading the file at run time, for example:
     `gh api repos/OWNER/REPO/hooks -f config[url]=<url> -f config[secret]="$(cat '<secretFile>')" -f config[content_type]=json -f 'events[]=pull_request'`.
     Never paste the secret in the chat.
3. **What the agent receives:**
   - `source`: the provider, or your `source`.
   - `type`, by provider:
     - GitHub: `pull_request.opened`.
     - Stripe: `invoice.paid`.
     - Slack: the event type.
     - hmac and token: `X-Event-Type`, else `payload.type`.
   - `eventID`: `<name>:<delivery id>`. A redelivery is not delivered twice.
   - `payload`: the parsed body plus `_webhook: {name, provider, headers}`. Signatures and tokens are left out of `headers`.
4. **What the sender gets back:**
   - `202`: verified and delivered.
   - `401`: bad or missing signature. Nothing is delivered.
   - `503`: OpenCode is down. Stripe and Slack retry; GitHub shows it under "Recent deliveries".
5. **Check:** `apex_webhook({action:"list"})` shows `stats`: `ok` / `rejected` / `failed`, and `lastError`. Send one real test delivery and watch the agent wake up.

## Ports: `apex_tunnel`

```jsonc
apex_tunnel({ "action": "open", "port": 5173, "ttlMinutes": 30 })          // → { id, route, url }
apex_tunnel({ "action": "open", "port": 3000, "name": "demo" })            // https://demo.<id>.opentunnel.xyz, permanent
apex_tunnel({ "action": "list" })  ·  apex_tunnel({ "action": "close", "id": "<id or route>" })
```

- Routes are random by default: 16 hex characters that never appear in certificate logs. Use `name` only when a readable URL matters.
- `proxyProtocol: "v2"` sends the visitor's IP to the app. Only use it if the app expects a PROXY header.
- The OpenCode server port is refused: that is what remote access is for.

**Your own microservice behind a route:**
- **Listen on `127.0.0.1`.** The tunnel reaches loopback, and binding to `0.0.0.0` also exposes it to the LAN.
- **Authenticate every request.** Behind the tunnel, every request comes from `127.0.0.1` with a `Host` the visitor chose, so "is it local?" checks are worthless. A random route is not authentication either.
- **To wake agents,** call `events.ingest` (`apex_callback_endpoint`, read the password from its file on every call). If it only needs to turn a third-party call into an event, use `apex_webhook` instead and write no service at all.
- **The tunnel route does not keep the process alive.** Run it so it survives the session (skill `apex-callbacks`, `references/run-anywhere.md`). Keep the route's lifetime matched to the process: a TTL for temporary ones, closing the route when you stop the service.

## Temporary or permanent

- **Temporary:** always set `ttlMinutes` for tests, demos, one-off callbacks (an OAuth redirect, a payment test) and anything "for now". The daemon removes the entry on time; a webhook also loses its URL and secret file.
- **Permanent:** omit `ttlMinutes` only when the user wants it to stay. Tell them how to remove it (`delete`, `close`).
- The URL stays the same while the device tunnel exists.

## When it is not reachable

`apex_daemon({action:"status"})` returns `tunnel.state` and the `log` file:
- `connected`: everything is fine.
- `provisioning`: the device's first tunnel. The certificate takes about 1 minute; then `url` appears in `list`.
- `reconnecting`: the network dropped. It retries on its own.
- `error`: read `lastError`.

Proxy and network settings:
- A corporate proxy or custom CA: the daemon honours `HTTPS_PROXY` / `NO_PROXY` and `OPENTUNNEL_CA_CERT`. SOCKS is not supported.
- A self-hosted OpenTunnel server: set `OPENTUNNEL_API` in OpenCode's environment.
- After changing any of these, run `apex_daemon({action:"stop"})` so it restarts with them.

## Before you call it done

1. Send one real request through the public `url`: an actual delivery for a webhook, `curl -i <url>` with credentials for a service.
2. Send a **bad** request and check it is refused: a wrong signature or token gets `401`.
3. Tell the user:
   - the URL and what it reaches;
   - temporary (until when) or permanent;
   - how to remove it;
   - the subscription id, if any.
