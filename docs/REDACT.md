# Redact: keep secrets away from the model

> **OpenCode V2 only (2.1 or newer).**

The redact module finds secrets in everything OpenCode is about to send to the model:
API keys, tokens, connection strings and so on. It **encrypts** each one and replaces it
with a readable marker. The model only ever sees the marker. When the model passes that
marker to a tool, apex decrypts it back, so the tool still receives the real value.

There is no lookup table in memory: the marker *is* the encrypted secret, so nothing is
lost when OpenCode restarts. The encryption key is the only thing you need to keep.

## What a marker looks like

```
{prefix}{patternName}:{base64url(iv || tag || ciphertext)}{suffix}
e.g. [SECRET:github-pat:AbC123...]
```

- **`patternName`** is the name of the detector that matched (for example `github-pat`,
  `aws-access-key-id` or `custom-0`), so a human reading the conversation knows *what*
  was hidden without seeing it.
- **Encryption** is AES-256-GCM, which is authenticated: a tampered payload does not
  decrypt. The IV is 12 random bytes per secret, the tag is 16 bytes, and the payload is
  base64url.
- **`prefix` and `suffix`** are configurable; the defaults are `[SECRET:` and `]`.
- **Unknown markers are left untouched**: text that looks like a marker but was not
  produced with your key does not decrypt.

## When redaction and restoration happen

OpenCode plugins react to events through *hooks*. apex uses two:

| Direction | Hook | What it touches |
| --- | --- | --- |
| **To the model → redact** | `session.hook("context")` | The system prompt, every message (your prompts, previous answers, tool results) and the tool definitions, right before each request is sent. |
| **To a tool → restore** | `tool.hook("execute.before")` | The arguments of each tool call (only when `restore.toolInput` is `true`, the default). |

- The redaction hook runs while the request is being built, before any transport, so it
  works the same over HTTP, WebSocket or ACP providers.
- **Nothing else is restored.** Model answers and reasoning keep the markers, so you see
  `[SECRET:…]` in the chat.
- **The session history keeps the original text.** Redaction applies only to what is sent
  to the model.

## The encryption key

The key comes from `redact.key`. apex resolves it in this order:

| `redact.key` value | Example | Key material |
| --- | --- | --- |
| `env:NAME` | `"env:APEX_REDACT_KEY"` | The value of that environment variable |
| `file:/path` | `"file:/home/me/.config/opencode/apex.key"` | The file's content, trimmed |
| `hex:…` | `"hex:0011aaff…"` | The hex string (must be hex digits) |
| `base64:…` | `"base64:AAEC…"` | The base64 string |
| any other text | `"my secret phrase"` | The text itself |
| empty (default) | `""` | The `APEX_REDACT_KEY` environment variable, if set |

1. The material is turned into a 32-byte key with SHA-256. The same material always gives
   the same key, so markers stay decryptable across restarts and machines.
2. If none of the above yields any material (empty value, unset variable, missing or empty
   file), apex reuses the key saved in `~/.config/opencode/apex.key`.
3. If that file does not exist either, apex generates a random key, saves it there (mode
   `0600`) and logs a warning.

**Pitfalls:**

- `file:` paths may start with `~/` (your home directory). Any other relative path is
  resolved against the server's working directory, so prefer `~/…` or an absolute path.
- If `env:NAME` points to a variable that is not set, apex goes straight to the saved key
  file. It does **not** fall back to `APEX_REDACT_KEY`.
- **Changing the key orphans existing markers**: markers created with the old key no
  longer decrypt and reach tools as plain marker text. Pick a key once (an environment
  variable is the usual choice) and keep it.
- The server log shows which source was used and a short fingerprint, never the key:
  `[apex.redact] Clave cargada (source=env, fp=1a2b3c4d), 96 patrones activos`.

## Guarantees

1. **Single pass.** All matches of all detectors are collected on the original text;
   overlaps are resolved (the longest match wins). A detector can never match inside a
   marker produced in the same pass.
2. **Idempotent.** Existing markers are protected regions, so the same text can flow
   through prompt → context → tool result → context again without being encrypted twice.
3. **Safe degradation.** A corrupt or foreign marker is left as is; an invalid payload
   decrypts to nothing and the text is kept.
4. **No state to lose.** There is no mapping table; only the key matters.

## Configuration

```jsonc
"redact": {
  "mode": "strict",                                // "strict" replaces · "warn" only logs
  "patterns": ["\\bmy-token-[A-Za-z0-9]{16}\\b"],  // your own regexes (note the \\)
  "bundles": ["aws", "github", "jwt", "env", "openai"],  // replaces the default list
  "minConfidence": "medium",                        // low | medium | high
  "allowlist": ["^sk-test-"],                       // regexes that are never redacted
  "prefix": "[SECRET:",
  "suffix": "]",
  "key": "env:APEX_REDACT_KEY",
  "restore": { "toolInput": true }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `"strict"` | `strict` replaces secrets with markers. `warn` sends the text unchanged and only logs each finding (debug level) |
| `bundles` | the 38 default bundles | Named groups of detectors (see below). Setting it **replaces** the whole default list |
| `patterns` | `[]` | Your own regexes, added on top of the bundles. Each becomes `custom-<index>` in the marker, is always active (treated as high confidence) and is case-sensitive (JavaScript `g` flag only) |
| `minConfidence` | `"medium"` | Drops bundle detectors below this confidence |
| `allowlist` | `[]` | Regexes tested against each **matched secret**; a match that fits any of them is left in clear |
| `prefix` / `suffix` | `"[SECRET:"` / `"]"` | Marker delimiters |
| `key` | `""` | See [The encryption key](#the-encryption-key) |
| `restore.toolInput` | `true` | Decrypt markers in tool arguments |

- **Escaping in JSON:** `\b` in a JSON string is a backspace character. For a regex word
  boundary write `\\b`. An invalid regex is skipped with a warning; it never stops the
  plugin.
- **Unknown bundle names** are skipped with a warning that lists the valid names.

## Detectors and bundles

apex ships **104 detectors in 41 bundles**:

- 58 are copied from **opencode-warden**;
- 45 from **opencode-secret-redactor@0.5.1**;
- 1 is apex's own (`db-uri-credentials`).

Each detector has a confidence level (`low`, `medium`, `high`). Some also have an extra
check: the Luhn checksum for credit cards, and excluding private ranges for IPv4.

**Enabled by default (38 bundles):**

```
aws github gitlab slack jwt pem bearer env
openai anthropic google stripe npm database
azure terraform vault heroku vercel supabase digitalocean cloudflare
observability pypi rubygems twilio sendgrid postman mailgun mailchimp
linear shopify square docker kubernetes cohere huggingface discord
```

**Opt-in** (noisy or personal data; add them to `bundles` explicitly):

| Bundle | Detects |
| --- | --- |
| `pii` | email, US phone number, US SSN, credit card (Luhn-checked) |
| `network` | public IPv4 addresses |
| `datadog` | Datadog API keys |

**`minConfidence`** decides how many detectors are active:

- `medium` (the default) skips the `low` ones: `cohere-key`, `redis-connection-string`,
  and, when their bundles are enabled, `datadog-api-key`, `pii-us-phone` and `pii-ipv4`.
  With the default bundles, 96 detectors are active.
- `low` enables all 98 detectors of the default bundles.
- `high` keeps only the unambiguous ones (78).

> **Why so conservative?** apex redacts the **whole** context (system prompt, history
> and tool definitions), not just one tool's output. An email address or a Redis URL in
> your source code would become a marker everywhere, which makes the code hard for the
> model to work with. Low-confidence and personal-data detectors are therefore off by
> default.

## Redacting from outside: RPC `apex/redact.process`

The same engine is available over the OpenCode server's RPC endpoint. That endpoint and
its authentication are explained in [EVENTS.md](EVENTS.md).

```
POST /api/rpc/apex/redact.process?location[directory]=<project>
{"input": {"text": "token ghp_…", "mode": "strict"}}
→ {"output": {"redacted": "token [SECRET:github-pat:…]", "findings": [{"pattern": "github-pat"}]}}
```

It uses the configured detectors, `allowlist`, key and marker format.
