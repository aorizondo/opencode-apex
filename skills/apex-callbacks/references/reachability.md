# Reachability: who can connect to whom

Facts to start from:
- The **OpenCode server listens on loopback** (`127.0.0.1`) with Basic auth. Only programs on the same machine reach it.
- A laptop or home PC sits **behind NAT and a firewall**. Nothing on the Internet can open a connection to it.
- **Outbound HTTPS works almost everywhere**, so a relay that connects out to its source needs nothing special.
- Many machines sleep. While the relay is off, inbound webhooks are lost unless the provider retries. Stripe retries for days. GitHub does not retry automatically: failed deliveries must be redelivered by hand or by API within 3 days.

## Decide

| Source | Relay runs | Works? | What to do |
| --- | --- | --- | --- |
| Stream or poll API (WebSocket, SSE, long-poll, IMAP, queue) | next to OpenCode | yes | default; nothing to expose |
| Internet webhook | next to OpenCode, behind NAT | **no** | A, B, C or D below |
| Service on the same LAN (n8n at home, a NAS) | next to OpenCode | yes, if routable | bind the relay to the LAN address, with a token and a firewall rule |
| Anything | on another machine (a VPS) | only if it can reach OpenCode | prefer D: the VPS stores events and the local relay pulls them. Otherwise tunnel to OpenCode plus `apex_set_callback_url` |
| Anything | OpenCode itself runs on a server with a public address | yes | the relay is local to it; expose the relay only |

## A. The provider's outbound mode (best: nothing exposed)

Look for it before reaching for a tunnel:

| Provider | Outbound alternative to webhooks |
| --- | --- |
| Slack | Socket Mode (WebSocket) |
| Discord | Gateway (WebSocket) |
| Telegram Bot API | `getUpdates` long polling (instead of `setWebhook`) |
| Matrix (incl. bridges) | client `/sync` long polling |
| Gmail | `users.watch` to a Pub/Sub topic with a **pull** subscription, or IMAP IDLE |
| Any mailbox | IMAP IDLE / JMAP push |
| GitHub | `gh webhook forward` (extension `cli/gh-webhook`) forwards a repo's or org's webhooks to `localhost` over a socket. Meant for development, needs admin rights, one forwarder per hook. Polling the REST API or `gh run watch` also works |
| Stripe | `stripe listen --forward-to localhost:<port>/<path>`, for development and test mode |

## B. A tunnel (public URL, outbound connection from your machine)

The tunnel client connects **out** to the provider. The provider gives you a public HTTPS URL that forwards to a local port. Point it at **the relay's port**, never at the OpenCode server.

**Cloudflare Tunnel (`cloudflared`)**
- **Quick tunnel**, no account, for tests: `cloudflared tunnel --url http://127.0.0.1:8787` prints a random `https://….trycloudflare.com`. The URL changes on every run and has no uptime guarantee.
- **Named tunnel**, stable. It needs a Cloudflare account and a domain on Cloudflare:
  ```sh
  cloudflared tunnel login
  cloudflared tunnel create apex-relay
  cloudflared tunnel route dns apex-relay hooks.example.com
  # ~/.cloudflared/config.yml
  #   tunnel: <tunnel id>
  #   credentials-file: ~/.cloudflared/<tunnel id>.json
  #   ingress:
  #     - hostname: hooks.example.com
  #       service: http://127.0.0.1:8787
  #     - service: http_status:404
  cloudflared tunnel run apex-relay           # as a service: `cloudflared service install` (Linux/macOS/Windows)
  ```
  A tunnel created in the dashboard is installed with the token it shows: `cloudflared service install <token>`. Cloudflare Access or WAF rules can sit in front of it, but the provider's webhook must still get through. Prefer path secrets plus signature checks.

**Tailscale Funnel:** `tailscale funnel --bg 8787` publishes `https://<machine>.<tailnet>.ts.net`. Funnel must be allowed in the tailnet policy and listens only on ports 443, 8443 and 10000. **Tailscale Serve** does the same inside the tailnet only, for senders that are your own devices.

**ngrok:** `ngrok config add-authtoken <token>` once, then `ngrok http 8787`. The free plan includes one static domain: `ngrok http --url=<name>.ngrok-free.app 8787`.

Self-hostable alternatives: frp, rathole, zrok.

## C. Reverse SSH to a VPS you control

```sh
# on the PC: publish the local relay as 127.0.0.1:9000 on the VPS
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -R 127.0.0.1:9000:127.0.0.1:8787 user@vps
```

On the VPS, a reverse proxy with TLS (Caddy, nginx) forwards `https://hooks.example.com` to `127.0.0.1:9000`. Keep the SSH session alive with `autossh` or as a service (`run-anywhere.md`). Binding to a public address on the VPS directly needs `GatewayPorts` in `sshd_config`. The proxy is cleaner.

## D. Store-and-forward (survives the PC being off)

```
provider ──webhook──▶ public receiver (VPS container, n8n, serverless function + queue)
                        verifies signature, stores event with an increasing id
local relay ──outbound SSE / long-poll / queue consumer──▶ receiver   (cursor = last id)
local relay ──▶ events.ingest
```

- Nothing is lost while the PC sleeps: events wait at the receiver.
- On reconnect the relay should skip or summarise old ones (`*.backlog`).
- The receiver needs no access to OpenCode, and OpenCode exposes nothing.
- n8n works as the receiver too: a Webhook node stores events, and the relay polls an n8n endpoint or a queue.

## Calling OpenCode from another machine (only if you must)

Prefer running the relay next to OpenCode. If a remote sender really has to call `events.ingest` itself, for example n8n on a VPS:
1. Tunnel or reverse-proxy **to the OpenCode server** with TLS. Anyone with the password then controls the agent, so restrict it at the edge if you can (IP allowlist, Access policy).
2. Announce the URL with `apex_set_callback_url({url})` so `apex_callback_endpoint` reports it as `publicUrl`. The sender replaces the `baseUrl` part of `rpc.*` with it.
3. Clear it with `apex_set_callback_url({url: null})` when done.

## Securing an inbound relay

- **TLS** at the edge: tunnels and proxies provide it.
- **Its own secret**: a random token (`openssl rand -hex 24`) in the path or a header, compared in constant time.
- **The provider's signature**, computed over the raw body before parsing:
  - GitHub: `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, body).
  - Stripe: `Stripe-Signature`, timestamped.
  - Slack: `X-Slack-Signature`, `v0=` + HMAC of `v0:<timestamp>:<body>`.
  - Reject old timestamps.
- **Limits**: maximum body size, rate limit, only `POST` on the expected path.
- **Answer fast** (2xx within a few seconds; GitHub gives up after 10 s), then ingest. Use the provider's delivery id as `eventID` for idempotency.
- Never forward headers that carry credentials into the payload.
