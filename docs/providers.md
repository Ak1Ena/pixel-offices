# Providers: Claude Code, Codex, Gemini CLI, Antigravity CLI, and Generic HTTP

Pixel Agents shows an agent as a character whenever a tool reports what it is doing. Claude Code is the
primary provider (hooks plus its JSONL transcripts). Four more providers are hook-only: their characters
are driven entirely by hook events.

| Provider id   | Tool                    | Where hooks are installed                           | Office can answer permission prompts |
| ------------- | ----------------------- | --------------------------------------------------- | ------------------------------------ |
| `claude`      | Claude Code             | `~/.claude/settings.json`                           | Yes                                  |
| `codex`       | OpenAI Codex CLI        | `~/.codex/hooks.json` (or `$CODEX_HOME`)            | Yes                                  |
| `gemini`      | Google Gemini CLI       | `~/.gemini/settings.json` (`hooks` key)             | No, answer in the terminal           |
| `antigravity` | Antigravity CLI (`agy`) | `~/.gemini/config/hooks.json` (`pixel-agents` spec) | No, answer in the terminal           |
| `generic`     | Any script or tool      | Nothing. Your tool POSTs its own events.            | No, shows a bubble only              |

Every provider POSTs to the same server route, `POST /api/hooks/<provider id>`. Events for an unknown id
are dropped.

## Enabling Codex and Gemini

The office asks about Codex and Gemini only when their config directory exists (`~/.codex` or
`~/.gemini`). If you don't use a CLI, you are never asked about it. When it exists, the first-run Intro
adds one consent step for that CLI, just like Claude's. After you approve:

1. The bundled hook script is copied to `~/.pixel-agents/hooks/codex-hook.js` or `gemini-hook.js`.
2. The Pixel Agents entries are merged into the CLI's file. Your other settings and hooks are kept, and a
   one-time backup is saved next to the file as `<file>.pixel-agents.backup`.
3. On later starts, the office reinstalls the entries if they are missing. This happens only while
   consent is recorded.

The installer follows the same safety rules as Claude's:

- It never rewrites a file it can't parse.
- It never replaces a `hooks` value it didn't write.
- Writes are atomic and keep the file's permissions.
- It removes only commands whose script path ends in `/.pixel-agents/hooks/<provider>-hook.js`.

### Codex: trust the hooks (required)

Codex skips new or changed hooks until you trust them. After installing, start Codex, run `/hooks`, and
trust the Pixel Agents entries. Until you do, nothing from Codex reaches the office.

Installed events: `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PermissionRequest`,
`Stop`, `Interrupt`, `SubagentStart`, `SubagentStop`. `UserPromptSubmit` is not installed because it
would forward your prompt text, and nothing uses it.

Permission prompts work like Claude's. While the office is open, Codex's approval prompt waits there for
your Allow or Deny, for up to 5 minutes, and then falls back to the terminal.

### Gemini: permission prompts are answered in the terminal

Gemini reports a tool confirmation as a `Notification` (`notification_type: "ToolPermission"`), and a
hook can't answer it. The office shows the waiting bubble, but you choose Allow or Deny in the Gemini
terminal. The bubble clears when the tool finishes.

Gemini's `BeforeTool` and `AfterTool` events carry no tool-call id. The office creates its own ids and
pairs each start with its end by tool name, in order.

Installed events: `SessionStart`, `SessionEnd`, `BeforeTool`, `AfterTool`, `AfterAgent`, `Notification`.
`BeforeAgent` is not installed because it would forward your prompt text.

`~/.gemini/settings.json` may contain comments, which Gemini accepts. The installer refuses to rewrite a
file with comments ("Couldn't parse …"). Remove the comments, or add the entries by hand.

### Antigravity CLI (`agy`)

Asked about when `~/.gemini/antigravity-cli` exists. agy's `hooks.json` is a map of named hook specs, so
the office owns one key, `pixel-agents`, and leaves every other key alone (same safety rules: it never
rewrites a file it can't parse, refuses a `pixel-agents` key it didn't write, and backs the file up once).

Installed events: `PreInvocation`, `PostToolUse`, `Stop`. **`PreToolUse` is not installed**: agy reads a
hook's reply there as a permission decision. `{}` denies the tool and `"allow"` would skip your own
prompts, so no reply is safe. Because of that, a tool shows in the office when it finishes
(`PostToolUse`) and stays until the next model call or `Stop`. Permission prompts are answered in the
terminal.

agy's payload has no event name, session id or (in `-p` mode) workspace, so the hook script fills them
in: the event from its command line, the session from `conversationId`, and the folder from the first
workspace path, else agy's own working directory, else the tool call's `Cwd`. agy has no session start
event; every model call re-announces the session, so an office opened mid-conversation still finds it.
Each hook prints `{}`, since agy requires a JSON reply.

**Starting agy from the office.** `pixel-office agy …` and **+ Agent** with `agy` as the start command
both work (with the agy hooks on). The character appears at once; a first message is optional and rides
the command line as `agy -i "<message>"`. agy takes no session id up front, so the office links its
conversation to the terminal it started by process id: on a conversation's first event the hook reports
its ancestor pids (`ps` on macOS/Linux, one PowerShell `Get-CimInstance` call on Windows, where hooks run
through `cmd /c`), and the office matches the terminal's pid among them and moves the character onto that
conversation. That run is shown whatever **Watch All Sessions** says, the office can type into it and
stop it, and on Windows (which can't read another process's working folder) the office fills in the
folder it started agy in. Its chat (your prompts, agy's replies and tool rows) is read from agy's own transcript, the
`transcriptPath` every hook reports, into the chat card and Messages.

### Undo

Settings → Instant Detection (Hooks) controls Claude only. To remove Codex or Gemini hooks, delete the
entries that run `codex-hook.js` or `gemini-hook.js` from the CLI's file, or disable them in the CLI's
`/hooks`. For agy, delete the `pixel-agents` key from `~/.gemini/config/hooks.json`. Uninstalling the VS Code extension removes the Pixel Agents entries from all three files.

### Which sessions appear

A Codex or Gemini session is adopted when one of these is true:

- Its working directory (`cwd`) is a workspace the office is watching.
- **Watch All Sessions** is on.

As with Claude, a session appears after its first real activity, such as a tool call or a finished turn,
not on `SessionStart` alone. It leaves on `SessionEnd`.

## Generic HTTP provider

Any tool can show up in the office by POSTing JSON to `/api/hooks/generic`. Nothing is installed for it,
and it never appears in the consent flow.

**Finding the server.** Each running office writes `~/.pixel-agents/servers/<pid>-<port>.json` (mode 0600) containing `{ "port": …, "pid": …, "token": "…" }`. Send the token as a Bearer token. If several
offices are running, POST to each one.

**Payload:**

```json
{
  "session_id": "my-tool-42",
  "hook_event_name": "PreToolUse",
  "cwd": "/path/to/project",
  "tool_name": "deploy",
  "tool_input": { "command": "make deploy" },
  "tool_use_id": "call-1",
  "agent_name": "Deploy bot"
}
```

| Field             | Required | Meaning                                                                                   |
| ----------------- | -------- | ----------------------------------------------------------------------------------------- |
| `session_id`      | yes      | Stable id for one agent run                                                               |
| `hook_event_name` | yes      | `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `PermissionRequest`, or `SessionEnd` |
| `cwd`             | on start | Working directory, used to decide whether the session belongs to a watched workspace      |
| `tool_name`       | no       | Shown as `Using <tool_name>`, or `Running: <command>` when `tool_input.command` is set    |
| `tool_input`      | no       | Object. `command`, `file_path`, and `path` are used for the status line                   |
| `tool_use_id`     | no       | Pairs a `PostToolUse` with its `PreToolUse`. Without it, the latest tool is closed        |
| `agent_name`      | no       | The character's label, applied only until the user renames it                             |

Event meanings:

- `SessionStart`: registers the session.
- `PreToolUse` / `PostToolUse`: the character works, then the tool row is marked done.
- `Stop`: the turn is finished and the character waits.
- `PermissionRequest`: shows the "…" bubble only. The office can't answer it for a generic tool.
- `SessionEnd`: the character leaves.

**Example:**

```bash
ENTRY=$(ls ~/.pixel-agents/servers/*.json | head -1)
PORT=$(node -p "require('$ENTRY').port")
TOKEN=$(node -p "require('$ENTRY').token")
post() {
  curl -s -X POST "http://127.0.0.1:$PORT/api/hooks/generic" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"
}
post '{"session_id":"demo-1","hook_event_name":"SessionStart","cwd":"'"$PWD"'"}'
post '{"session_id":"demo-1","hook_event_name":"PreToolUse","tool_name":"build","tool_input":{"command":"make"},"tool_use_id":"t1","agent_name":"Builder"}'
sleep 3
post '{"session_id":"demo-1","hook_event_name":"PostToolUse","tool_use_id":"t1"}'
post '{"session_id":"demo-1","hook_event_name":"Stop"}'
post '{"session_id":"demo-1","hook_event_name":"SessionEnd","reason":"exit"}'
```

If the character doesn't appear, check two things: `cwd` must be a watched workspace (or Watch All
Sessions must be on), and a `SessionStart` must come before the first `PreToolUse`.

## Adding a provider in code

A new provider goes in `server/src/providers/hook/<id>/`:

- `<id>.ts`: the `HookProvider`. It owns every raw field of the CLI's payload.
- `<id>HookInstaller.ts`: a thin wrapper over `createHookSettingsInstaller` in
  `providers/hook/hookSettingsInstaller.ts`.
- `consentCopy.ts`: the consent text for the Intro step.
- `hooks/<id>-hook.ts`: one line calling `runHookScript` from `providers/hook/hookScript.ts`.

Then register it in `server/src/providers/index.ts`, `esbuild.js`, and `package.json` `files`.
