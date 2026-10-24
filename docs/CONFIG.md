# Configuring apex

> **OpenCode V2 only (2.1 or newer).** apex is built on the OpenCode V2 plugin API
> (`@opencode/plugin`). It does not load in OpenCode V1.

This page covers where apex's settings live, which source wins when several define the
same key, and the details that trip people up: environment variables, comments, merge
rules and prompt template files. Every key, with its default, is listed in the annotated
template [`opencode-apex.jsonc`](../opencode-apex.jsonc).

## Background: how OpenCode loads a plugin

An OpenCode *plugin* is a package that OpenCode loads into its server process to add
tools, hooks and agents. You enable it in OpenCode's own config file, `opencode.json`, in
the `plugins` list:

```jsonc
// opencode.json
{
  "plugins": [
    {
      "package": "opencode-apex",            // npm package name (or a local directory path)
      "options": { "modules": { "events": true } }  // handed to the plugin as-is
    }
  ]
}
```

OpenCode reads `opencode.json` from two places:

| File | Applies to |
| --- | --- |
| `~/.config/opencode/opencode.json` (global) | every project |
| `<project>/opencode.json` (project) | that project only |

When both exist, OpenCode merges them itself (the project file wins) before the plugin
sees anything. On first use OpenCode downloads the npm package and its dependencies into
its own cache (`~/.cache/opencode/npm/`); you do not run `npm install` yourself.

## The three places apex reads settings from

apex accepts its settings through two *channels*:

1. **Its own config files**, named `opencode-apex.jsonc`:
   - **global**: `~/.config/opencode/opencode-apex.jsonc` (`$XDG_CONFIG_HOME` is
     honoured: `$XDG_CONFIG_HOME/opencode/opencode-apex.jsonc`);
   - **local**: `<project>/.opencode/opencode-apex.jsonc`.
2. **Inline options**: the `options` object of the apex entry in `opencode.json`
   (example above).

All three are optional. With none of them, apex starts with the defaults.

### Precedence

From **lowest to highest** priority:

| # | Source | Level |
| - | --- | --- |
| 1 | Global file `~/.config/opencode/opencode-apex.jsonc` | global file |
| 2 | Inline `options` in `opencode.json` | inline |
| 3 | Local file `<project>/.opencode/opencode-apex.jsonc` | local file |

The idea: **scope wins** (project over global), and **within a scope the file wins over
the inline options**. The result is that the inline options override the global file
but are overridden by the local file.

> **Limitation.** OpenCode hands the plugin a single, already-merged `options` object
> (global `opencode.json` + project `opencode.json`). apex cannot tell which of the two an
> inline option came from, so all inline options sit at level 2. If you need fine control
> between global and project settings, use the two `opencode-apex.jsonc` files.

### How sources are merged

- Objects are merged key by key, recursively.
- **Arrays are replaced, not concatenated.** A `bundles` or `patterns` list in a
  higher-priority source replaces the whole list from a lower one.
- A key that is absent (or `undefined`) never erases a value from a lower source.

## Turning modules on and off

Each module has exactly one switch, under `modules`:

```jsonc
"modules": { "redact": true, "events": true, "advisor": true, "guard": false, "browser": true }
```

| Module | Default when the key is omitted |
| --- | --- |
| `redact` | on |
| `events` | on |
| `advisor` | on |
| `guard` | **off** (it can block the agent if its rules are wrong, so you opt in) |
| `browser` | on |

There is no `<module>.enabled` key. A legacy `events.enabled` is ignored and logs a
warning. So does `events.listener`: the HTTP listener was removed in 0.2.0, see
[EVENTS.md](EVENTS.md).

## Environment variables

Two different substitution mechanisms exist, depending on which file the value is in:

| Where the value is written | Syntax | Done by | Missing variable |
| --- | --- | --- | --- |
| `opencode.json` (inline options) | `{env:VAR}`, `{file:path}` | OpenCode | replaced by an empty string |
| `opencode-apex.jsonc` files (and inline values too) | `${VAR}`, `${VAR:-default}`, `$VAR` | apex | `${VAR}`: error · `${VAR:-x}`: `x` · `$VAR`: left as written |

- apex does **not** understand `{env:VAR}`. That is OpenCode syntax and only works inside
  `opencode.json`.
- apex expands `$NAME` in every string, including regexes in `redact.patterns`. A `$`
  followed by letters is replaced if an environment variable with that name exists.
- A `${VAR}` without a default whose variable is not set makes the whole configuration
  invalid. apex logs a warning, retries without the inline options and, if it still
  fails, **starts with all defaults**. Use `${VAR:-}` when an empty fallback is acceptable.

The redaction key has its own `env:VAR` / `file:/path` forms. They are resolved by the
redact module, not by this mechanism. See [REDACT.md](REDACT.md#the-encryption-key).

## Comments and syntax

The apex files are JSON with comments (JSONC). Three comment styles are accepted:
`// line`, `/* block */` and `# line` (a `#` inside a string is kept). Trailing commas are
allowed.

```jsonc
{
  # hash comment
  "redact": {
    "prefix": "[SECRET:",   // line comment
    /* block comment */
    "suffix": "]"
  }
}
```

Two JSON rules that bite:

- **Strings cannot span lines.** Write line breaks as `\n`:
  `"promptTemplate": "first line\nsecond line"`.
- **Backslashes must be doubled in regexes**: the regex `\b` is written `"\\b"`
  (`"\b"` is a backspace character in JSON).

> **The parser is fault-tolerant.** A syntax error does not stop apex. It logs
> `[apex] config syntax errors in <file> (<error> @ line N)` and uses whatever part of the
> file it could parse. A string with a raw line break, for example, is cut at the first
> line, so the affected keys may be missing. A file that does not parse to an object at
> all is ignored, with a warning. If a setting seems to have no effect, look for that log
> line.

## Prompt template files

Used by `events.subscriptions[].promptTemplateFile` and `advisor.promptTemplateFile`. A
template is the text sent to the agent, with placeholders such as `{{payload.x}}` (events)
or `{{requestID}}` (advisor).

- **Only relative paths** are accepted:
  - `prompts/event.md` is relative to the **project** directory;
  - `~/templates/event.md` is relative to your **home** directory.
- **Absolute paths are rejected**, and so is any path that escapes its base directory
  with `../`. apex logs a warning and falls back to the inline `promptTemplate`.
- **If the file does not exist, apex creates it** (and any missing directories) with the
  module's default template, so you get a starting point to edit. For the advisor, the
  file is created with your inline `promptTemplate` if you set one.
- Priority: file › inline `promptTemplate` › the module's built-in default.

## Startup behaviour

apex always starts, whatever the configuration:

| Situation | What happens |
| --- | --- |
| No config at all | All defaults |
| A config file is missing | Treated as empty |
| A file cannot be read, or does not parse to an object | That file is ignored, with a warning |
| A value has the wrong type or an unknown enum value | Warning; retry without inline options, then all defaults |
| An unknown key | Silently dropped |

The server log shows which sources were found, for example
`[apex] config: inline=true global=false local=false · global=<path> · local=<path>`.

## Migrating from the old file name

The old location `<project>/apex.jsonc` is **no longer read**. Move it:

```bash
mv apex.jsonc .opencode/opencode-apex.jsonc
```
