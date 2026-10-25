# Relays: design guide (any language, any OS)

A relay is a long-running program that turns events from a source into `events.ingest` calls.
A watcher is the same logic run on a schedule. Everything below applies to both.

## The loop

```
load config, cursor and the set of recently seen ids
forever:
  connect to the source                      outbound when possible (see reachability.md)
  for each raw event:
    normalize   → {source, type, eventID, payload}
    drop        → own/outgoing items, duplicates, noise, items older than N minutes after a reconnect
    enrich?     → tools.run, only if the agent will need more than the event carries
    decide      → cheap rules here (keywords, sender, chat); judgement belongs to the agent
    ingest      → POST events.ingest; if OpenCode is down, keep it in an outbox and retry
    checkpoint  → save the cursor AFTER the ingest succeeded
  on any error: log one line, wait (1 s → 2 s → … → 60 s, plus jitter), reconnect
```

Rules that keep a relay out of trouble:
- **One responsibility.** The relay moves events. It does not reply, judge or summarise. Those are the agent's job once it is awake.
- **Never wake an agent in a loop.**
  - Notify on changes, not on every check.
  - Drop what the user sends themselves.
  - After downtime, do not replay a flood. Skip items older than a few minutes, or send one `*.backlog` summary event.
- **Read the OpenCode URL and password on every call**, from the place `apex_callback_endpoint` named. They change when OpenCode restarts.
- **Log one line per event**: `type eventID delivered=[…]`. Never log the password, tokens or full payloads.
- Give it a **dry-run flag** that prints the normalized event instead of sending it.

## Getting events: source catalog

| Source | Transport | Direction | Resume after a disconnect | Notes |
| --- | --- | --- | --- | --- |
| Chat apps with a socket API (Beeper Desktop `/v1/ws`, Discord Gateway, Slack Socket Mode, Home Assistant) | WebSocket | outbound | ids or timestamps you saved | Answer pings; the server closes idle sockets |
| Your own services, MCP servers that publish a stream (`/events`) | SSE (`text/event-stream`) | outbound | `Last-Event-ID` header | A blank line ends one event; `:` lines are keep-alives |
| Telegram Bot API `getUpdates`, Matrix `/sync`, many REST APIs | long polling | outbound | `offset`, `since` or `next_batch` token | Simplest to get right |
| Email | IMAP IDLE (or polling `UID SEARCH`) | outbound | `UIDVALIDITY` + last `UID` | Re-issue IDLE at least every 29 min (RFC 2177); JMAP has push too |
| Any API with "list since" | polling (watcher) | outbound | timestamp or id | Respect rate limits; poll at the slowest acceptable pace |
| Queues and brokers (MQTT, Redis Streams, NATS, AMQP, Google Pub/Sub pull, SQS) | consumer | outbound | the broker keeps the offset; ack after ingest | Best for store-and-forward from a public receiver |
| Databases | Postgres `LISTEN/NOTIFY`, change streams | outbound | a `seq`/`updated_at` column | Notify carries ids; read the row afterwards |
| Local machine | file watch, `journalctl -f`, `tail -F`, process exit | local | file offset | Watchers and CI wrappers |
| Webhooks (GitHub, Stripe, n8n, forms…) | HTTP POST to you | **inbound** | the provider's delivery id | Needs a public address: see `reachability.md` |
| An MCP server | `tools.run` from a watcher | outbound via OpenCode | whatever the tool returns | MCP has resource subscriptions on paper, rarely implemented: poll a tool instead |

If a service offers both a webhook and a socket or long-poll mode, **take the outbound one**: no tunnel, no public port, nothing lost while the relay restarts.

## Event shape

```jsonc
{
  "source": "imap-work",                    // who sends: stable, one per relay/account
  "type": "email.received",                 // what happened: dotted, noun.verb
  "eventID": "imap-work:INBOX:4711:98213",  // unique per real-world event (provider id, or a hash)
  "payload": {                              // what the agent needs to act, small
    "mailbox": "INBOX", "uid": 98213, "from": "ana@example.com",
    "subject": "Invoice 2026-10", "snippet": "first 300 characters…", "url": "…"
  }
}
```

- **`eventID`:**
  - apex ignores a repeated `eventID` for 5 minutes. Beyond that, deduplicate in the relay with a bounded set of recent ids, for example the last 5 000, stored in a file.
  - Prefix it with the source, because ids from different sources can collide.
- **`payload`:**
  - Ids first: chat id, message id, mailbox + UID, repo + run id. The agent uses them to act through its tools.
  - Then short text. Bulky content stays at the source: the agent fetches it.
  - No secrets, tokens or full headers: everything here ends up in a prompt.
- **`type`:** keep a small fixed set per relay, so subscriptions can filter on it. Use separate types for failures that are not real events, such as `relay.error` or `relay.backlog`.

## State that survives restarts

| What | Where | Why |
| --- | --- | --- |
| cursor (last id, `Last-Event-ID`, IMAP UID, offset) | a small file, written atomically (temp file + rename) | resume without gaps or replays |
| recently seen ids | a bounded list in a file | dedupe beyond apex's 5 minutes |
| outbox | a file or folder of events whose ingest failed | OpenCode was restarting or asleep |
| last state (watchers) | a file per target | notify only on changes |

Put them in a per-user state directory: `~/.local/state/<relay>/` on Linux, `~/Library/Application Support/<relay>/` on macOS, `%LOCALAPPDATA%\<relay>\` on Windows. Mode `0600` if they contain anything personal.

## Using OpenCode tools inside the relay (`tools.run`)

```
function runTool(tool, input):
    reply = POST rpc.toolsRun {"input": {"tool": tool, "input": input, "timeoutMs": 60000}}
    if not reply.output.ok: return error(reply.output.error)   // denied, unknown, MCP down, timeout
    return reply.output.content                                // text; parse it yourself

on message event:
    details = runTool("messaging_read_messages", {"chat_id": event.chatID, "limit": 5})
    if error: ingest {type: "message.received", payload: {...event, enrichError: error}}   // still wake, but say so
    else:     ingest {type: "message.received", payload: {...event, context: lastLines(details)}}
```

- Get the exact tool id by asking the agent for its tool list. MCP tools are `<server>_<tool>`. Try the call by hand with the `curl` from `apex_callback_endpoint.examples.toolsRun` first, and copy its `input`.
- `tools.run` executes **one** tool with the permissions of `events.tools.agent` (default `build`):
  - `ask` tools stall because nobody is there to approve, so keep writes out of the relay;
  - `execute` (code mode), `question`, `subagent` and `apex_*` are denied by default;
  - only the MCP servers connected in that project directory are available.
- It costs a full tool execution, so call it once per event that matters, not for every raw item.
- Keep "could not check" (`ok: false`) apart from "nothing happened". Send the first as its own `type` if the user should know.

## Several projects or agents

- Each `location[directory]` has its own subscriptions and MCP servers. A relay can send the same event to several directories: keep a list in its config and call each `rpc.ingest`. Alternatively, route by rule, for example work chats to one project and personal chats to another.
- Many relays for one user: give each its own `source` (`whatsapp-personal`, `imap-work`). Subscriptions then pick precisely.

## Testing checklist

1. Dry run: the normalized events look right, and the noise is dropped.
2. Send one hand-made event: `delivered: ["sub_…"]`.
3. Restart the relay mid-stream: no gap, no replay.
4. Stop OpenCode for a minute: the relay retries, and the outbox drains when it comes back.
5. Kill the network: it reconnects with backoff, without a busy loop.
