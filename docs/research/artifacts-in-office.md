# Artifacts inside the office (design)

Status: proposal. Nothing here is built yet.

## Problem

When an agent calls Claude Code's `Artifact` tool, the page is published to
claude.ai and opened in the system browser. The user leaves the office to see
it, and back in the office there is no trace of it: no notice, no link, nothing
on the character.

## What the office can already see

- The tool call is in the transcript: an `assistant` record with a `tool_use`
  named `Artifact`. Its `input` has `file_path`, the LOCAL `.html` file the agent
  wrote, plus `files`, `url` and `action`. The `tool_result` carries the
  claude.ai URL.
- Hooks see the same call (`PreToolUse` / `PostToolUse`) with the same input.
- So the office has the page's source on disk. It does not need claude.ai to
  show it.

## Why not embed claude.ai

- Artifacts are private by default, and viewing one needs the user's claude.ai
  login cookie. An iframe inside the office's origin won't carry that login
  reliably, since third-party cookies are blocked.
- claude.ai pages send `frame-ancestors` / `X-Frame-Options`, so the browser
  refuses to frame them anyway.
- Keep the claude.ai URL as an "Open on claude.ai ↗" button, not as the view.

## Design

### 1. Detect (provider layer)

Add an optional `describeArtifact(toolName, input, result?)` to `HookProvider`,
next to `describeEdit`. It returns `{ filePath, title?, url?, files? }` or null.
Claude implements it for `Artifact`. This keeps the runtime free of Claude
tool names, the same rule `describeEdit` follows.

`processTranscriptLine` (both modes read the JSONL) calls it. The chat's tool
row gets an `artifact` field (like `edit`), and the runtime registers the
artifact:

```
ArtifactRecord { id: 'a' + 12 hex, agentId, filePath, dir, title, url?, at }
```

The record lives in memory, and we broadcast `artifactsLoaded`. Its `id` is
what the client names, never a path. This is the same rule as board files: the
client names a PIN, not a path.

### 2. Serve (server)

`GET /api/artifacts/:id/` serves `filePath`. `GET /api/artifacts/:id/<rel>`
serves the published supporting files: CSS, JS and images next to the page,
resolved under `dir` with `realpath` re-checked. It never goes outside `dir`,
and it has an extension allowlist.

Headers:

- `Content-Security-Policy: sandbox allow-scripts allow-popups; default-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com data: blob:; connect-src 'none'`
  - `sandbox` without `allow-same-origin` gives the page an OPAQUE origin, even
    if someone opens the URL directly. Its scripts can't read the office's
    token, localStorage or `/api/*`.
  - The CDN list is the same set the Artifact tool allows, so real artifacts
    render.
- `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.

Auth: the iframe can't send a Bearer header. Put a short-lived per-artifact
capability in the path (`/api/artifacts/:id/:cap/…`, HMAC of id + expiry with
the server token). A copied link then dies with the office and can't reach any
other file.

### 3. Show (webview)

`ArtifactViewer.tsx` is a panel like `DocViewer`. It has an
`<iframe sandbox="allow-scripts allow-popups" src=…>` with NO
`allow-same-origin`, a header (title, agent, time), "Open on claude.ai ↗" (when
there is a url), "Reload", and "Ask <agent> about this" (reuses the doc chat).

Where it opens:

- A chat tool row with `artifact` renders as a card with a thumbnail and Open.
- A focus-style notice: "Scout published _Sales dashboard_" → View.
- A doc bubble on the character (`Character.docBubble`, which exists already).
- Files rail: an "Artifacts" tab listing this session's records.

Runtime capabilities (`window.claude.*`: db, live data, asking Claude) don't
exist locally. Inject nothing. Show a thin banner: "Live features run on
claude.ai only". Such a page renders what it can, and the button takes the
user to the real one.

### 4. Keep the browser from jumping (needs verification)

This is the part with open questions. Options, in order of preference:

1. **Agents the office runs (+ Agent, teams, the desk):** start the pty with
   `BROWSER=<pixel-office open shim>`. The shim POSTs the URL to
   `/api/focus`-like `/api/open`, and the office opens its viewer instead.
   Verify first: whether Claude Code's opener honors `BROWSER` on macOS, Linux
   and Windows. Many Node openers call `open` / `xdg-open` / `start` directly.
2. If it doesn't, tell office-run agents in their first message (`teamFile`,
   desk prompts) to publish without opening the page, if the tool allows it.
   Otherwise accept the browser tab and rely on the in-office viewer as the
   place to come back to.
3. Never patch the user's Claude settings for this. It's the consent rule:
   no new settings writes outside the hooks install.

### 5. Protocol (AsyncAPI)

- ServerMessage `artifactsLoaded { artifacts: ArtifactInfo[] }`, where
  `ArtifactInfo { id, agentId, title, url?, viewPath, at }` and `viewPath`
  already carries the capability.
- `ChatEntry.artifact?: { id, title }` on the tool row.
- No client message is needed to view. "Ask about this" uses `sendChatMessage`
  with `[@path]`, so refs travel and text never does.

### Security checklist

- Opaque origin: CSP `sandbox` on the response AND `sandbox` on the iframe,
  never `allow-same-origin`.
- `connect-src 'none'`: the page can't call the office's API or phone home. The
  CDN allowlist covers scripts, styles and fonts only.
- Only files the agent named in an `Artifact` call. The id maps to a path, and
  `realpath` must stay under that file's folder.
- Untokened viewers (LAN, no `?token=`) get nothing, the same as board files.

### Tests

- Provider: `describeArtifact` on real transcript records (tool_use plus
  result).
- Server: path escape (`..`, symlink out of `dir`), extension allowlist, CSP
  header present, capability expiry.
- Webview: the iframe has `sandbox` without `allow-same-origin`, pinned in a
  unit test.
