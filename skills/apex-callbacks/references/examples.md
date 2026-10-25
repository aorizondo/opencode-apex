# Copyable examples

All of them take their values from `apex_callback_endpoint`:
- `INGEST` = `rpc.ingest`;
- `TOOLS_RUN` = `rpc.toolsRun`;
- `PASSWORD_FILE` = `auth.password.file`. If `auth.password.kind` is `env`, set `OPENCODE_SERVER_PASSWORD` instead.

They read the password on every call and never print it. Pick the language the machine already has. The contract is the same everywhere.

## 1. Watcher in sh + curl (Linux, macOS, WSL)

Notifies only when a URL goes from up to down, and back:

```sh
#!/bin/sh
# watch-http.sh — tells apex when a URL goes from up to down (and when it recovers).
TARGET="https://my-server.example.com/health"
INGEST='<rpc.ingest>'
PASSWORD_FILE='<auth.password.file>'
pw() { sed -n 's/.*"password" *: *"\([^"]*\)".*/\1/p' "$PASSWORD_FILE"; }   # env kind: printf %s "$OPENCODE_SERVER_PASSWORD"
STATE="$HOME/.local/state/apex-watch/$(printf %s "$TARGET" | cksum | cut -d' ' -f1)"
mkdir -p "$(dirname "$STATE")"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$TARGET")
case "$code" in 2??|3??) now=up ;; *) now=down ;; esac
before=$(cat "$STATE" 2>/dev/null || echo up)
[ "$now" = "$before" ] && exit 0          # no change: nobody gets bothered
echo "$now" > "$STATE"

type="server.$now"; since=$(date +%s)
body=$(printf '{"input":{"source":"watch-http","type":"%s","eventID":"%s-%s","payload":{"host":"%s","detail":"HTTP %s"}}}' \
  "$type" "$type" "$since" "$TARGET" "$code")
for i in 1 2 3 4 5; do
  curl -sS --fail --max-time 30 -X POST "$INGEST" -u "opencode:$(pw)" \
    -H 'content-type: application/json' -d "$body" && exit 0
  sleep $((i * 10))
done
exit 1
```

**With an OpenCode or MCP tool as the check** (`tools.run`, needs `jq`):

```sh
TOOLS_RUN='<rpc.toolsRun>'
out=$(curl -sS --max-time 150 -X POST "$TOOLS_RUN" -u "opencode:$(pw)" \
  -H 'content-type: application/json' \
  -d '{"input":{"tool":"<exact tool id, e.g. easypanel_list_services>","input":{ },"timeoutMs":60000}}')
echo "$out" | jq -e '.output.ok' >/dev/null || { echo "could not check: $(echo "$out" | jq -r '.output.error // .')" >&2; exit 2; }
echo "$out" | jq -r '.output.content'      # the tool's text output: decide here
```

## 2. Streaming relay in Python (stdlib only, any OS)

It reads an SSE stream and forwards each event.
- **Resume:** it resumes with `Last-Event-ID` and saves the cursor after each successful ingest.
- **Reconnect:** it reconnects with backoff.
- **Other sources:** for a WebSocket, IMAP or polling source, replace `events()` and keep the rest.

```python
#!/usr/bin/env python3
"""sse-relay.py: SSE stream -> apex events.ingest. Python >= 3.8, stdlib only, any OS."""
import base64, hashlib, json, os, pathlib, sys, time, urllib.request

STREAM = os.environ["STREAM_URL"]                      # the source's text/event-stream endpoint
STREAM_TOKEN = os.environ.get("STREAM_TOKEN", "")      # its own credential, if any
INGEST = os.environ["INGEST"]                          # rpc.ingest
PASSWORD_FILE = os.environ.get("PASSWORD_FILE")        # auth.password.file (or OPENCODE_SERVER_PASSWORD)
SOURCE = os.environ.get("SOURCE", "sse")
STATE = pathlib.Path(os.environ.get("STATE_DIR", pathlib.Path.home() / ".local" / "state" / "sse-relay"))
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def password():
    # Read on every call: OpenCode's password changes when it restarts.
    if PASSWORD_FILE:
        return json.loads(pathlib.Path(PASSWORD_FILE).read_text())["password"]
    return os.environ["OPENCODE_SERVER_PASSWORD"]


def ingest(event):
    if DRY_RUN:
        log("dry-run", json.dumps(event)[:300])
        return {"delivered": []}
    auth = "Basic " + base64.b64encode(f"opencode:{password()}".encode()).decode()
    body = json.dumps({"input": event}).encode()
    for attempt in range(8):                            # OpenCode restarting: wait and retry
        try:
            request = urllib.request.Request(INGEST, data=body, method="POST",
                                             headers={"authorization": auth, "content-type": "application/json"})
            with urllib.request.urlopen(request, timeout=30) as reply:
                return json.load(reply).get("output", {})
        except Exception as error:
            log(f"ingest failed ({error}); retry {attempt + 1}")
            time.sleep(min(60, 2 ** attempt))
    raise RuntimeError("OpenCode unreachable")


def events():
    """Yields {'id', 'event', 'data'} dicts from the stream (one per blank-line-terminated block)."""
    headers = {"accept": "text/event-stream"}
    if STREAM_TOKEN:
        headers["authorization"] = f"Bearer {STREAM_TOKEN}"
    cursor = STATE / "cursor"
    if cursor.exists():
        headers["last-event-id"] = cursor.read_text().strip()
    # Read timeout: the source must send data or a ":" keep-alive at least every 90 s.
    with urllib.request.urlopen(urllib.request.Request(STREAM, headers=headers), timeout=90) as stream:
        message = {}
        for raw in stream:
            line = raw.decode("utf-8").rstrip("\r\n")
            if not line:
                if "data" in message:
                    yield message
                message = {}
            elif line.startswith(":") or ":" not in line:
                continue
            else:
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                message[field] = message[field] + "\n" + value if field == "data" and "data" in message else value


def to_event(message):
    """Normalize, or return None to drop. Adapt this to your source."""
    try:
        data = json.loads(message["data"])
    except ValueError:
        data = {"text": message["data"]}
    if data.get("from_me"):                             # never wake an agent for the user's own messages
        return None
    raw_id = message.get("id") or data.get("id") or hashlib.sha256(message["data"].encode()).hexdigest()[:16]
    return {"source": SOURCE, "type": message.get("event", "message.received"),
            "eventID": f"{SOURCE}:{raw_id}", "payload": data}


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    delay = 1
    while True:
        try:
            for message in events():
                delay = 1
                event = to_event(message)
                if event:
                    out = ingest(event)
                    log(f"{event['type']} {event['eventID']} delivered={out.get('delivered')}")
                if message.get("id"):                   # cursor only after a successful ingest
                    tmp = STATE / "cursor.tmp"
                    tmp.write_text(message["id"])
                    tmp.replace(STATE / "cursor")
        except Exception as error:
            log(f"stream lost ({error}); reconnecting in {delay}s")
        time.sleep(delay)
        delay = min(delay * 2, 60)


if __name__ == "__main__":
    main()
```

Run it with the four variables, `DRY_RUN=1` first, and keep it alive as in `run-anywhere.md`.

**Calling a tool from Python** (enrich before ingesting):

```python
def run_tool(tools_run_url, tool, tool_input, timeout_ms=60000):
    auth = "Basic " + base64.b64encode(f"opencode:{password()}".encode()).decode()
    body = json.dumps({"input": {"tool": tool, "input": tool_input, "timeoutMs": timeout_ms}}).encode()
    request = urllib.request.Request(tools_run_url, data=body, method="POST",
                                     headers={"authorization": auth, "content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout_ms / 1000 + 30) as reply:
        out = json.load(reply)["output"]
    return (out.get("content"), None) if out.get("ok") else (None, out.get("error"))
```

## 3. Webhook relay in Node (≥ 18, no dependencies)

It listens on a local port and checks its own token. If `GITHUB_SECRET` is set, it also checks GitHub's signature. Expose this port, not OpenCode, through a tunnel (`reachability.md`).

```js
// webhook-relay.mjs — POST http://<host>:<port>/<type>?token=<RELAY_TOKEN> → apex events.ingest
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { createHmac, timingSafeEqual } from "node:crypto"
const { INGEST, PASSWORD_FILE, RELAY_TOKEN, GITHUB_SECRET, PORT = "8787", HOST = "127.0.0.1", SOURCE = "webhook" } = process.env
if (!INGEST || !RELAY_TOKEN) throw new Error("INGEST or RELAY_TOKEN missing")
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
// Read on every request: OpenCode's password changes when it restarts.
const password = () =>
  PASSWORD_FILE ? JSON.parse(readFileSync(PASSWORD_FILE, "utf8")).password : process.env.OPENCODE_SERVER_PASSWORD
createServer(async (req, res) => {
  const url = new URL(req.url, "http://relay")
  if (req.method !== "POST" || !same(url.searchParams.get("token") ?? "", RELAY_TOKEN)) return res.writeHead(401).end()
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    if ((size += chunk.length) > 1_000_000) return res.writeHead(413).end()
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  const h = req.headers
  // GitHub signs the raw body: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, body)
  if (GITHUB_SECRET && !same(h["x-hub-signature-256"] ?? "", "sha256=" + createHmac("sha256", GITHUB_SECRET).update(raw).digest("hex")))
    return res.writeHead(401).end()
  let body
  try { body = JSON.parse(raw.toString("utf8") || "{}") } catch { body = { raw: raw.toString("utf8").slice(0, 10_000) } }
  const delivery = h["x-github-delivery"] ?? h["idempotency-key"] ?? h["x-request-id"]
  const input = {
    source: SOURCE,
    type: url.pathname.slice(1) || String(h["x-github-event"] ?? h["x-event-type"] ?? "webhook"),
    ...(delivery ? { eventID: `${SOURCE}:${delivery}` } : {}),
    payload: { body, headers: { "content-type": h["content-type"], "user-agent": h["user-agent"] } },
  }
  try {
    const auth = "Basic " + Buffer.from(`opencode:${password()}`).toString("base64")
    const r = await fetch(INGEST, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ input }) })
    res.writeHead(r.ok ? 202 : 502, { "content-type": "application/json" }).end(await r.text())
  } catch (error) {
    res.writeHead(502).end(String(error))   // OpenCode stopped: the sender may retry
  }
}).listen(Number(PORT), HOST)
```

- Generate the token with `openssl rand -hex 24`, or `[guid]::NewGuid()` twice on Windows.
- The sender calls `https://<tunnel>/<type>?token=<RELAY_TOKEN>`.
- GitHub payloads are large. Before shipping, trim `payload.body` to the fields the agent needs.

## 4. Ingest from PowerShell (Windows PowerShell 5.1 and PowerShell 7)

```powershell
$ingest = '<rpc.ingest>'
$pwFile = '<auth.password.file>'
$pw     = (Get-Content -Raw $pwFile | ConvertFrom-Json).password      # env kind: $env:OPENCODE_SERVER_PASSWORD
$auth   = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("opencode:$pw"))
$event  = @{ input = @{
  source = 'disk-watch'; type = 'disk.low'; eventID = "disk.low-C-$(Get-Date -Format yyyyMMdd)"
  payload = @{ drive = 'C:'; freeGB = [math]::Round((Get-PSDrive C).Free / 1GB, 1) }
} }
$reply = Invoke-RestMethod -Method Post -Uri $ingest -Headers @{ Authorization = $auth } `
         -ContentType 'application/json' -Body ($event | ConvertTo-Json -Depth 10)
"delivered: $($reply.output.delivered -join ', ')"
```

`ConvertTo-Json` cuts nested objects at depth 2 by default: always pass `-Depth`.

## 5. n8n as the receiver (no code)

Use a *Webhook* node, then an *HTTP Request* node: `POST <rpc.ingest>` with Basic auth (credential `opencode` + password) and this body:

```
{"input":{"source":"github","type":"{{$json.headers['x-github-event']}}","eventID":"github:{{$json.headers['x-github-delivery']}}","payload":{{JSON.stringify($json.body)}}}}
```

If n8n runs on another machine, it cannot reach OpenCode's loopback. Either tunnel to it and `apex_set_callback_url`, or let n8n store events while a local relay pulls them (`reachability.md`, option D).
