# Pixel Agents — Compressed Reference

Pixel art office where AI agents (Claude Code terminals today, any tool tomorrow) become animated characters. Ships as a **VS Code extension** and an **`npx pixel-agents` standalone CLI** from the same source tree.

`CONTEXT.md` is the canonical glossary — read it for what terms like Agent, Sub-agent, Teammate, Lead, Adopt, or Headless agent mean here, and use its vocabulary in code, comments, and docs.

## Architecture

Strict layering: `core/` depends on nothing; `server/` depends only on `core/`; `webview-ui/` depends only on `core/`; `adapters/vscode/` depends on `core/` and `server/`. The standalone CLI never imports `adapters/vscode/` and vice versa.

```
core/                                Protocol + interface definitions (zero runtime side effects)
  asyncapi.yaml                      AsyncAPI 3.0 contract — single source of truth
  src/
    messages.ts                      AUTO-GENERATED discriminated unions (do not edit)
    schemas.ts                       AgentMeta, SpriteData, FurnitureCatalogEntry
    provider.ts                      HookProvider, AgentEvent (the integration boundary)
    teamProvider.ts                  Optional TeamProvider (semantic queries for Lead + Teammates)
    transport.ts                     MessageTransport interface, TransportState
    adapter.ts                       StateAdapter, AssetCache, PersistedAgent, AgentSeat
    terminalAdapter.ts               TerminalAdapter (editor-driven terminal management)
    normalizeProjectPath.ts
    constants.ts

server/                              Lifecycle runtime + Fastify HTTP/WS server
  src/
    providers/hook/claude/           Reference HookProvider — only place that knows Claude specifics
      claude.ts                      normalizeHookEvent for 11 Claude events, formatToolStatus, file fallback
      claudeTeamProvider.ts          TeamProvider: reads ~/.claude/teams/<name>/config.json
      claudeHookInstaller.ts         Consent-gated install/uninstall in ~/.claude/settings.json (abort on unparseable file or non-array hooks.<Event>; one-time .pixel-agents.backup, exclusive-create, no backup ⇒ no write — but skipped when the replaced content is entirely our own install's output, since backing up our own file masquerades as the user's original (`settingsHoldOnlyOurHooks`, compared against makeHookEntry — the WRITER — so a field added to what we write can't silently revive the bug; only `command`/`timeout` may differ, they vary across installs); every write failure THROWS; mode preserved, 0600 on create; re-read verify immediately before rename + retry; hook identity = `/.pixel-agents/hooks/claude-hook.js` suffix anchored at both ends of the command's first token, case-insensitive; `areHooksInstalled` = ANY of our commands on ANY event)
      consentCopy.ts                 Claude's first-run consent disclosure text (scope/data/undo), served through consentDisclosure()
      constants.ts                   Claude hook event names, script path
      hooks/claude-hook.ts           Hook script (CJS+shebang, bundled to dist/hooks/claude-hook.js)
    providers/hook/consentGate.ts    Provider-agnostic consent POLICY: when to ask (hooksConsentRequest per provider) and what an answer means (consentActionFor(choice, {installed, consent}) — see docs/adr/0001)
    providers/hook/consentExecutor.ts Provider-agnostic consent EXECUTION: applyConsentChoice(providerId, choice, ConsentEffects) runs the six actions in one order for both surfaces, and SERIALIZES answers per process across ALL providers
    providers/index.ts               Provider registry (claudeProvider + the hookProviders list the consent gate loops over)
    agentRuntime.ts                  Lifecycle core: timers, scanners, HookEventHandler, SessionRouter, DismissalTracker
    agentStateStore.ts               EventEmitter-backed single source of truth (typed mutations + events)
    sessionRouter.ts                 session_id → agent_id mapping, event buffering, pending external sessions
    dismissalTracker.ts              Unified dismissal state (replaces four legacy globals)
    hookEventHandler.ts              Dispatches normalized AgentEvent into runtime
    httpServer.ts                    Fastify: POST /api/hooks/:providerId, GET /api/health, GET /ws, SPA (standalone)
    clientMessageHandler.ts          Single dispatch point for ClientMessage from webview
    server.ts                        Top-level composition
    cli.ts                           npx pixel-agents entry (npm bin)
    fileStateAdapter.ts              Namespaced ~/.pixel-agents/ persistence
    configPersistence.ts             { vscode, standalone, externalAssetDirectories, hooksConsent: {providerId: granted|declined}, hooksEnabled: {providerId: boolean} }
    layoutPersistence.ts             ~/.pixel-agents/layout.json with atomic tmp+rename
    fileWatcher.ts                   Hybrid fs.watch + 500ms polling, JSONL line buffering, /clear detection
    transcriptParser.ts              JSONL parsing for heuristic / file-fallback mode
    timerManager.ts                  Waiting / permission timers
    assetLoader.ts                   PNG → SpriteData via pngjs
    teamUtils.ts                     isInlineTeammateOf, getInlineTeammates, hasInlineTeammates
    chatLog.ts                       Session chat: transcript records → bounded per-agent log, upserting agentChatEntry, tail seed
    chatSender.ts                    Office → terminal messages: per-agent queue, held mid-turn and ALWAYS during a permission prompt
    boardStore.ts                    Whiteboard pins: ~/.pixel-agents/board.json, validated + bounded, polled across windows
    launcher.ts                      `pixel-agents claude`: runs Claude in a node-pty it owns, long-polls every live server for office input
    launcherHub.ts                   Server side of the launcher: per-session inbox, lease, TerminalWriter for ChatSender
    terminalTyping.ts                Types office messages as keystrokes (never a paste) + Enter; shared by VS Code and the launcher
    tokenUsage.ts                    Session token totals + burn rate from transcript usage (each request counted once by message.id)
    types.ts                         ServerAgentState
    constants.ts                     All timing/scanning constants
  __tests__/                         35 Vitest files
  manual-hook-events.http            Manual hook testing helper (REST-Client format)

adapters/vscode/                     VS Code surface — composes core + server
  extension.ts                       activate() / deactivate()
  PixelAgentsViewProvider.ts         WebviewViewProvider, thin bridge to AgentRuntime
  agentManager.ts                    Terminal lifecycle (claude --session-id <uuid>), restore, persist
  vscodeTerminalAdapter.ts           TerminalAdapter implementation
  uninstall.ts                       vscode:uninstall hook — removes hook entries + factory-resets hooks config after extension removal
  migrateVsCodeState.ts              One-time legacy state migration (verify-before-clear)
  constants.ts                       VS Code IDs, command names, key names

webview-ui/                          React 19 + Canvas UI (depends only on core/)
  src/
    transport/
      index.ts                       createTransport() — single runtime branching point
      postMessageTransport.ts        VS Code mode (acquireVsCodeApi)
      webSocketTransport.ts          Standalone mode (exponential backoff, send queue)
      types.ts                       Re-exports MessageTransport from core
    runtime.ts                       isBrowserRuntime detection
    browserMock.ts                   Standalone-browser asset fetch + message injection
    testHooks.ts                     window globals exposed for e2e (officeState, helpers)
    main.tsx                         React entry (StrictMode + createRoot)
    App.tsx                          Composition root (hooks + components + EditActionBar)
    constants.ts                     Webview magic numbers/strings
    notificationSound.ts             Web Audio API chime
    changelogData.ts                 Changelog modal content
    components/                      React UI (toolbars, modals, settings)
      BottomToolbar.tsx, ZoomControls.tsx, SettingsModal.tsx, InfoModal.tsx,
      Tooltip.tsx, DebugView.tsx, ui/Button.tsx, ...
    hooks/
      useExtensionMessages.ts        Message handler — translates ServerMessage into OfficeState mutations
      useEditorActions.ts            Editor state + callbacks
      useEditorKeyboard.ts           Keyboard shortcuts (R, T, Esc, Ctrl+Z/Y)
      introTourState.ts              Intro tour wire-state machine (pure reducer, Node-runner tested)
      useIntroTour.ts                Wires the reducer to React + transport (snapshot, verdict, choices)
    office/
      types.ts                       OfficeLayout, Character, etc. + re-exports constants
      toolUtils.ts                   STATUS_TO_TOOL mapping, extractToolName (DOM-free; defaultZoom lives in useEditorActions)
      projection.ts                  World→screen math shared by renderer + DOM overlays (mapOffset, overlayProjection)
      colorize.ts                    Colorize (grayscale→HSL) + Adjust (HSL shift)
      floorTiles.ts                  Floor sprite storage + colorized cache
      wallTiles.ts                   Wall auto-tile: 16 bitmask sprites
      sprites/
        spriteData.ts                Pixel data (characters, furniture, tiles, bubbles)
        spriteCache.ts               SpriteData → offscreen canvas, per-zoom WeakMap
      editor/
        editorActions.ts             Pure layout ops
        editorState.ts               Imperative state (tools, ghost, selection, undo/redo, drag)
        EditorToolbar.tsx
      layout/
        furnitureCatalog.ts          Dynamic catalog from loaded assets
        layoutSerializer.ts          OfficeLayout ↔ runtime (tileMap, furniture, seats)
        tileMap.ts                   Walkability, BFS pathfinding
      engine/
        characters.ts                Character FSM (idle/walk/type) + wander AI
        officeState.ts               Game world (layout, characters, seats, selection, subagents, consent greeter)
        gameLoop.ts                  rAF loop with delta-time cap (0.1 s)
        renderer.ts                  Canvas: tiles, z-sorted entities, overlays, edit UI
        matrixEffect.ts              Spawn/despawn digital rain (drawing only)
        matrixEffectState.ts         Effect state: startMatrixEffect/advanceMatrixEffect (DOM-free)
      components/
        OfficeCanvas.tsx             Canvas, resize, DPR, mouse hit-testing, drag-to-move
        ToolOverlay.tsx              Activity label above hovered/selected character
    officeChat.ts                    Pure chat/whiteboard helpers (pin → prompt text, entry upsert, preview)
    hooks/useOfficeChat.ts           Chat + queue + board state (own transport listener)
    components/ChatCard.tsx          Chat card anchored beside a character (click to open)
    components/ChatPeekBubbles.tsx   Unread-reply previews above characters
    components/WhiteboardRail.tsx    Right-edge whiteboard: pins, add form, drag onto characters/chat

e2e/                                 Playwright suite (real VS Code + mock-claude scenarios)
  playwright.config.ts
  global-setup.ts
  fixtures/
    pixel-agents.ts                  VS Code fixture: launch Electron, wait for panel
    standalone.ts                    Standalone CLI fixture: spawn server + browser page
    mock-claude, mock-claude.cmd     Bash + cmd wrapper invoked instead of real claude
    mock-claude-runner.cjs           Scenario runner: appendJsonl, emitHook, holdOpen
  helpers/
    launch.ts                        Electron app + isolated HOME/workspace
    mock-claude.ts                   claudeScenario() builder
    office.ts                        Overlay locators + assertions
    webview.ts                       Settings/modal helpers
    hooks.ts                         Hook server lifecycle helpers
    standalone.ts                    Standalone server + WebSocket browser helpers
    internal-agent.ts                spawnInternalAgentAndWait
    lifecycle.ts                     Reusable scenario fragments
    team.ts                          Team config seeding + teammate helpers
    allure-labels.ts                 @area:<tag> → Allure epic
  tests/
    claude/hooks-on/                 basic.spec.ts, lifecycle.spec.ts, teams.spec.ts
    claude/hooks-off/                lifecycle.spec.ts, matrix.spec.ts
    standalone/                      hooks.spec.ts
  README.md                          Auto-generated test inventory (regen via npm run e2e:inventory)

scripts/
  generate-messages.ts               AsyncAPI → core/src/messages.ts via Modelina (with CI drift check)
  run-e2e.mjs                        Playwright wrapper (run-id namespacing, video attach flags)
  generate-e2e-inventory.mjs         Splices test list into e2e/README.md (CI drift check)
  build-allure-report.mjs            Combine e2e+server+webview Allure results
  assemble-vercel-output.mjs         Stage /reports/allure/ for Vercel deploy
  asset-manager.html                 Unified furniture editor (positions + metadata)
  jsonl-viewer.html                  Standalone JSONL transcript inspector
  wall-tile-editor.html              Wall sprite editor

core/                                npm workspace (no separate package; root manages)
server/                              npm workspace
webview-ui/                          npm workspace
```

## Distribution

Two artifacts from one source tree:

- **VS Code extension** (`.vsix`) — `pablodelucca.pixel-agents` on VS Code Marketplace and Open VSX. Bundles VS Code adapter + webview SPA + assets + hook scripts.
- **npm package** (`pixel-agents`) — `npx pixel-agents [--port 3100]` runs the Fastify server and serves the SPA on the same port. Bundles CLI + webview SPA + assets + hook scripts + `core/asyncapi.yaml` (so third-party clients can regenerate from it).

`package.json:files` allowlist controls the npm tarball: `dist/cli.js{,.map}`, `dist/webview/`, `dist/assets/`, `dist/hooks/`, `core/asyncapi.yaml`, `icon.png`. `dist/extension.js` is intentionally excluded since the VS Code entry ships through the `.vsix`.

## Communication Flow

Hub-and-spoke. The server is the single aggregation point for all agent activity, regardless of source.

```
Hook scripts ─POST /api/hooks/:providerId─┐
                                          ├─→ HookProvider.normalizeHookEvent()
JSONL transcripts ─FileWatcher─→ TranscriptParser ┤
                                                   ↓
                                              AgentEvent (canonical)
                                                   ↓
                                              AgentRuntime (dispatch on .kind)
                                                   ↓
                                           AgentStateStore (mutate)
                                                   ↓
                                              StoreEvents → broadcast
                                                   ↓
                          PostMessageTransport ──┤├── WebSocketTransport
                                 (VS Code)      (standalone browser)
```

The VS Code adapter wires `PostMessageTransport` against `acquireVsCodeApi()`. The standalone CLI exposes the same protocol over WebSocket at `/ws` with the webview SPA served from the same Fastify instance. **The protocol shape is identical; only the wire differs.**

Adding a new CLI integration is one subdirectory under `server/src/providers/hook/<id>/`: provider, optional `TeamProvider`, installer, hook scripts. Zero changes to the runtime, the UI, or any existing provider.

## AsyncAPI Protocol Contract

`core/asyncapi.yaml` is the contract. Pinned to **3.0.0** because `@asyncapi/modelina@5.10.1` declares `supportedVersions: ['3.0.0']` only; bumping to 3.1.0 produces `export type Root = any`. Revisit when Modelina ships 3.1.0 support.

- **57 ServerMessage variants** (server → client): agent lifecycle, permission asks (`agentPermissionAsk`, `agentPermissionAnswered`), folder picker (`folderListing`), agent activity, sub-agent activity, team + context usage, session chat (`agentChatEntry`, `agentChatHistory`, `agentChatQueue`, `agentChatSendable`), whiteboard (`boardLoaded`), "show me" (`focusRequests`), workflows (`workflowsLoaded`, `workflowRuns`, `workflowNotice`), teams (`teamsLoaded`, `teamRuns`, `teamNotice`), AI drafts (`teamDraft`, `workflowDraft`), review changes (`proposals`), assets, settings + workspace, diagnostics.
- **57 ClientMessage variants** (client → server): permission answers (`answerPermission`, `answerScreenQuestion` — privileged), Stop (`interruptAgent` — privileged), folder picker (`listFolder` — privileged), lifecycle (`webviewReady`, `launchAgent`, `focusAgent`, `closeAgent`), chat (`sendChatMessage` — privileged, `cancelChatMessage`), whiteboard (`saveBoardPin`, `removeBoardPin`, `answerFocus` — privileged), workflows (`saveWorkflow`, `deleteWorkflow`, `attachWorkflow`, `answerGate`, `stopWorkflowRun`, `importWorkflow` — all privileged), teams (`saveTeam`, `deleteTeam`, `startTeam`, `stopTeam`, `importTeam`, `draftTeam`, `draftWorkflow` — all privileged), review changes (`decideHunk`, `applyProposal`, `discardProposal`, `undoProposal` — all privileged), layout (`saveAgentSeats`, `saveLayout`, `exportLayout`, `importLayout`), settings (`setSoundEnabled`, `setHooksEnabled`, `setWatchAllSessions`, `setAlwaysShowLabels`, `setHooksInfoShown`, `setLastSeenVersion`), discovery + assets, diagnostics.

Both unions use `oneOf` with `discriminator: type`. Every concrete message sets `additionalProperties: false`.

`core/src/messages.ts` is generated by `scripts/generate-messages.ts` invoking `@asyncapi/modelina` with custom constraints (`propertyKey` preserves `type`/`status` field names; `constant` inlines `const` literals). The file has an auto-generation banner. **CI runs `asyncapi:generate` then `git diff --exit-code core/src/messages.ts` — any non-empty diff fails the build.**

## Transport Abstraction

```typescript
export interface MessageTransport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): () => void;
  readonly ready: Promise<void>;
  readonly state: TransportState;
  onStateChange(handler: (state: TransportState) => void): () => void;
  dispose(): void;
}
export type TransportState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
```

`PostMessageTransport` reports `connected` for its entire lifetime. `WebSocketTransport` reconnects with exponential backoff (250 ms, 500 ms, 1 s, 2 s, 4 s, capped) and queues sends while disconnected.

`createTransport()` in `webview-ui/src/transport/index.ts` is the **only branching point** in the UI codebase. Everything downstream uses the `MessageTransport` interface and never knows which transport is active.

## Provider Abstraction

`HookProvider` (`core/src/provider.ts`) is the integration boundary. Implemented: Claude Code (reference, transcripts + hooks), plus hooks-only Codex CLI, Gemini CLI and a Generic HTTP provider (`server/src/providers/hook/{codex,gemini,generic}/`, routed by the `:providerId` in the hook URL, adopted as `hooksOnly` agents; see `docs/providers.md` — Codex needs `/hooks` trust, Gemini's permission prompt can't be answered from a hook). The Claude provider supports every transcript/hook format up to **Claude Code v2.1.220** (current as of 2026-07-30 — Task-era `agent_progress` records, explicit and implicit teams, background-by-default Agent spawns, sidecar-backed background agents). Newer CLI releases may add formats that need provider updates. The interface:

- **Required**: `normalizeHookEvent(raw)` → `{ sessionId, event: AgentEvent } | null`; `installHooks` / `uninstallHooks` / `areHooksInstalled`; `formatToolStatus`; `permissionExemptTools`, `subagentToolNames`, `readingTools` sets.
- **Optional file fallback**: `getSessionDirs(workspace)`, `getAllSessionRoots()`, `sessionFilePattern`, `parseTranscriptLine(line)`, `buildLaunchCommand(sessionId, cwd, opts)`. Used when hooks aren't installed.
- **Optional team extension**: `team?: TeamProvider` for Lead + Teammates support.

`AgentEvent.kind` values: `toolStart`, `toolEnd`, `turnEnd`, `subagentStart`, `subagentEnd`, `subagentTurnEnd`, `progress`, `permissionRequest`, `sessionStart`, `sessionEnd`. The runtime dispatches on `kind`, never on CLI-specific tool names.

### TeamProvider (Lead + Teammates)

Optional extension for CLIs that support team workflows (Claude Agent Teams today). Semantic queries (`discoverTeammates`, `getTeamMembers`, `getTeamMetadataForSession`, `extractTeammateNameFromEvent`, `isTeammateSpawnCall`) — providers choose their own storage strategy.

Four teammate modes:

| Mode                            | Trigger                                          | Detection                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic subagent (teams OFF)      | `Task(...)` or `Agent(run_in_background: false)` | `subagentStart` with team gate not matched, or JSONL `agent_progress`                                                                                                                                                                                                                                                                                                                   |
| Inline teammate (teams ON)      | `Agent(run_in_background: true)` in-process      | `onTeammateDetected` → `discoverTeammates(projectDir, leadSessionId)`                                                                                                                                                                                                                                                                                                                   |
| Session teammate (teams + tmux) | `Agent(run_in_background: true)` in tmux pane    | Own session, own hooks, routes through normal flow                                                                                                                                                                                                                                                                                                                                      |
| Implicit-team agent (Claude 5)  | `Agent(...)` — background by default, NO flag    | Lead-side: spawn tool_result `agent_id: <name>@<team>` → `extractTeammateSpawnFromToolResult` sets lead `teamName`; teammate = own top-level UUID session tagged `teamName`/`agentName` on every record, discovered by `discoverTeammates(projectDir, leadSessionId, teamName)` and fast-attached in `onExternalSessionDetected` (bypasses the Watch All gate when the lead is tracked) |

Newer harnesses (Claude 5) never tag the LEAD's records with team metadata and never write `agent_progress`/`queue-operation` records for these spawns — the spawn tool_result and the teammate's own session (own JSONL, own hooks) are the only signals. The implicit team writes `~/.claude/teams/session-<8hex>/config.json` (its `leadSessionId` matches no transcript on disk — don't link by it). Own-session teammates are registered with the SessionRouter (`setTeammateRegisterCallback`) so their hooks route directly to them.

**Team generations on resume (last-wins latch)**: every CLI run of a session mints a FRESH implicit team, so a resumed lead's transcript carries spawn tool_results from several `session-<8hex>` generations. A tag-less lead re-latches to the newest spawn's team (`setTeamSwitchCallback` removes the defunct team's teammates); tag-derived identity (`teamNameFromTags`, set by the record-tags branch) is authoritative and never overwritten by spawn results. `linkTeammates` never badges a named teammate as LEAD — if only teammates are tracked, linking waits until the real lead is detected (prevents a phantom LEAD character when a teammate session is adopted before/without its lead). Restore drops `isTeamLead` from persisted agents that carry an `agentName`.

**Background spawns without a CLI team (sidecar-backed)**: `Agent(...)` spawns that never register a team take the async path — result "Async agent launched successfully. agentId: \<hex>" (no team anywhere), transcript + sidecar under `<projectDir>/<leadSessionId>/subagents/` (sidecar carries `agentType`/`description`/`toolUseId`, plus `name` when the spawn was named), completion via `queue-operation`. `scanForBackgroundAgentFiles` classifies them by the sidecar `name` — the domain model's sole Sub-agent vs Teammate distinction (see CONTEXT.md):

- **Named → Teammate**: its own seated character, `agentName` from the sidecar `name`; the spawner gets `isTeamLead` + an `agentTeamInfo` broadcast (derived team — NO `teamName`, so config polling stays away) and the transient Subtask is ghost-killed via `subagentClear`. The child has `leadAgentId` + `spawnToolUseId`; it's removed on the completion queue-operation or lead sessionEnd (`removeTeammate` must NOT unregister its session — it shares the lead's).
- **Unnamed → Sub-agent**: the Subtask sub-character stays; the spawn's transcript is watched in a **shadow `AgentStateStore`** (`server/src/subagentWatch.ts`, owned by `AgentRuntime`, ids from 1 000 000 up) whose broadcasts are translated onto the main store as `subagentToolStart/Done/Permission` keyed `(leadId, spawnToolUseId)` — live activity on the sub-character, no protocol change. `agentToolsClear` on the shadow agent synthesizes `subagentToolDone` for still-live tools so the sub idles between turns. Never persisted, never announced.

The gate for both: the sidecar `toolUseId` must match a LIVE entry in the lead's `backgroundAgentToolIds` (anti-spurious; no teamName involved). `scanForTeammateFiles` skips sidecars carrying a live `toolUseId` so it can't race the classification. The lead's `backgroundAgentToolIds` are persisted (children never are — they're derived state the 1 s scan re-materializes after a reload; restore skips stale entries with `leadAgentId` but no `teamName`). The turn-end background-tool re-sends (transcriptParser, hookEventHandler, timerManager's `clearAgentActivity`) must include `toolName` + `runInBackground` (or the webview can't recreate the Subtask after `agentToolsClear`) and must skip tools whose spawn became a teammate character (`hasPromotedBackgroundAgent`, or a ghost Subtask appears next to it).

Teammate dismissal is driven by team config polling (`getTeamMembers(teamName)` is authoritative; members with `isActive: false` are treated as departed), by the teammate's own `sessionEnd` (own-session teammates), and by `sessionEnd` on the lead.

**Subtle gate (the one that bit us recently)**: in `webview-ui/src/hooks/useExtensionMessages.ts`, `agentToolStart` with `runInBackground=true` only creates a Subtask sub-character when the **parent has no `teamName`**. With a team, `onTeammateDetected` creates the teammate instead (and the gate prevents a ghost sub-agent). Without a team, the teammate path never fires and the basic Subtask sub-character is the only visible representation. The gate's blind spot — a TEAMED lead's unnamed background spawn — is covered by `subagentToolStart` creating the sub-character lazily when it's missing (`addSubagent` is idempotent); the same lazy path recreates subs after a panel reload.

## Server Runtime

`AgentRuntime` (`server/src/agentRuntime.ts`) is the shared lifecycle core. Both surfaces (`adapters/vscode/PixelAgentsViewProvider.ts` and `server/src/cli.ts`) compose the same runtime; only the `StateAdapter` namespace, `MessageTransport`, and `TerminalAdapter` differ.

```typescript
export class AgentRuntime {
  constructor(opts: {
    store: AgentStateStore;
    providerRegistry: ProviderRegistry;
    layoutPersistence: LayoutPersistence;
    assetCache: AssetCache;
    config: Pick<AdapterSettings, 'hooksEnabled' | 'watchAllSessions'>;
    terminalAdapter?: TerminalAdapter;
    callbacks: RuntimeLifecycleCallbacks;
  });
  registerAgent / unregisterAgent / removeAgent / removeTeammate / removeTeammates
  restoreExternalAgents / handleHookEvent
  startProjectScan / startExternalScanning / startStaleCheck
  dispose();
}
```

Owns timer Maps (waiting, permission, text-idle, stale), scanners (project-dir 1 s, external 3 s, stale 30 s), `HookEventHandler`, `SessionRouter`, `DismissalTracker`. Scanners are skipped entirely while hooks are flowing (`hookDelivered` is set on every agent). `RuntimeLifecycleCallbacks` is the only seam between runtime and host.

### AgentStateStore

EventEmitter-backed container in `server/src/agentStateStore.ts`. Typed mutations, typed events (`agentAdded`, `agentRemoved`, `agentUpdated`, `broadcast`). The broadcast layer subscribes once at boot and translates `StoreEvents` into `ServerMessage` over the active transport. **No module under `server/` calls a transport method directly.**

### SessionRouter and DismissalTracker

Two extracted classes that replaced ad-hoc module state. `SessionRouter` owns `session_id → agent_id` mapping, pre-registration event buffering, and pending external sessions. `DismissalTracker` unifies four legacy globals (`dismissedJsonlFiles`, `clearDismissedFiles`, `seededMtimes`, `pendingClearFiles`) into one class with typed reasons.

### HTTP + WebSocket Server

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, and (in standalone) `@fastify/static`:

| Method | Path                     | Purpose                                 |
| ------ | ------------------------ | --------------------------------------- |
| POST   | `/api/hooks/:providerId` | Bearer-authenticated hook event ingress |
| GET    | `/api/health`            | Liveness: `{ ok, version, port, pid }`  |
| GET    | `/ws`                    | Bidirectional protocol channel          |
| GET    | `/*` (standalone only)   | Webview SPA via `@fastify/static`       |

`/ws` is gated in **two tiers**, because `setHooksEnabled(true)` over this socket is a durable, machine-wide consent grant plus a hook install.

1. **Connection** (`isAllowedWebSocketOrigin`): embedded requires the Bearer token; standalone requires a same-origin handshake. A missing Origin still connects (non-browser clients send none). This tier is weak by design — a DNS-rebound page sends `Origin` and `Host` as the same attacker-chosen name and IS accepted (`httpServerWs.test.ts` pins that).
2. **Privileged messages** (`standaloneTokenValid`, `ClientMessageContext.privileged`): proved by an out-of-band secret — embedded via its Bearer token, standalone via the server token in the `/ws` `?token=` query, which the CLI prints in the local URL and the SPA forwards (`webview-ui/src/transport/index.ts`). **Never a network position**: peer address, `Host` and `Origin` all ride the channel a proxy speaks, so a LAN-bound forwarder piping bytes to 127.0.0.1 satisfies all three. The token is a replayable bearer capability, not evidence of locality — it also reaches browser history and Fastify's request log, so the printed URL is documented to the user as a secret. An untokened client still watches the office; it just cannot change `~/.claude/settings.json`.

The **hooks preference is persisted only after the install/uninstall settled and the on-disk result agrees** — writing it first strands the user when an uninstall fails: entries still firing, but a persisted hooks-off makes the next startup skip the consent/install path entirely.

Server discovery written to `~/.pixel-agents/server.json` with `{ port, pid, authToken }`. Multi-window safe: a second server detects an existing `server.json` and reuses or replaces it based on PID liveness.

### ClientMessageHandler

Single dispatch point for `ClientMessage`. Each variant calls into `AgentRuntime`, `AgentStateStore`, `LayoutPersistence`, or `FileStateAdapter`, or delegates to host-specific callbacks (`onLaunchAgent`, `onOpenSessionsFolder`, `onExportLayout`, `onImportLayout`, `onSetHooksEnabled`). Both surfaces wire the same handler.

### ServerAgentState (server/src/types.ts)

Per-agent runtime data: provider reference, session key, transcript-fallback fields (`jsonlFile`, `fileOffset`, `lineBuffer`), tool state Maps and Sets, team fields (`teamName`, `agentName`, `isTeamLead`, `leadAgentId`, `teamUsesTmux`), context usage (`contextTokens`, `maxContextTokens`, `sawMainChainUsage`), and the **`hookDelivered`** flag that suppresses heuristic timers when hooks are flowing.

## Persistence

```
~/.pixel-agents/
  config.json              { vscode, standalone, externalAssetDirectories, hooksConsent, hooksEnabled (both per-provider) }
  vscode-state.json        { agents, seats }
  standalone-state.json    { agents, seats }
  layout.json              OfficeLayout (shared across surfaces)
  server.json              { port, pid, authToken }
  hooks/claude-hook.js     Bundled hook script (CJS, shebang)
```

`FileStateAdapter({ namespace })` backs both runtimes. Per-namespace settings: `soundEnabled`, `lastSeenVersion`, `alwaysShowLabels`, `watchAllSessions`, `hooksInfoShown` (the hooks preference is per-provider and machine-global, at the config top level). Running both surfaces in parallel never clobbers either.

`migrateVsCodeState` (VS Code adapter only) walks each known legacy key once with **verify-before-clear** semantics: write to file, read back, only then clear the legacy key. While anything remains unmigrated, activation shows a non-blocking warning.

Layout writes are atomic via tmp + rename. Cross-window watching is hybrid (`fs.watch` + 2 s polling). `markOwnWrite()` prevents the watcher from re-reading our own write.

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result, non-exempt tools trigger permission timers), `bash_progress` (Bash output — restarts permission timer), `mcp_progress` (MCP tool — same timer restart). Also observed but not tracked: `file-history-snapshot`, `queue-operation`.

**File watching**: 500 ms polling with partial-line buffering for mid-write reads. Tool-done messages delayed 300 ms to prevent React batching from hiding brief active states.

### Dual-mode detection

| Mode                     | Source                                                 | Detection                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hooks** (preferred)    | Claude Code Hooks API → HTTP POST → `HookEventHandler` | Instant, reliable. Installed events are `CLAUDE_HOOK_EVENTS`. `UserPromptSubmit`/`TaskCreated` are deliberately NOT installed — they normalize to null, so installing them only forwarded prompt text to be dropped; `normalizeHookEvent` still tolerates them for stale installs |
| **Heuristic** (fallback) | Polling JSONL files                                    | Per-agent 500 ms JSONL polling for /clear detection; 1 s main scanner for terminal adoption; 3 s external scanner; 30 s stale check. Content-based /clear detection (`/clear</command-name>` in first 8 KB)                                                                       |

The `hookDelivered` flag (per agent) and `hooksEnabled` (global) gate timer logic. JSONL polling always runs in both modes for tool content (status text, animations); only permission (7 s) and text-idle (5 s) timers are suppressed by `hookDelivered`.

### Sub-agent permission detection (heuristic)

When a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent. If `PERMISSION_TIMER_DELAY_MS` (7 s) elapses with no data, permission bubbles appear on both parent and sub-agent characters via `agentToolPermission` + `subagentToolPermission` broadcasts.

`activeSubagentToolNames: Map<parentToolId, Map<subToolId, toolName>>` tracks which sub-tools are active for the exempt check. Cleared when data resumes, Task completes, or `turn_duration` arrives.

**Timing budget for tests**: the test waits for the bubble AFTER waiting for the "Subtask:" overlay. But the Subtask overlay appears when the parent's **Task tool_use** is parsed (scenario time T), while the timer only starts when the **sub-tool tool_use** in the progress record is parsed (~1 s later). Plus 7 s timer + 300 ms IPC/render slop = a wait timeout less than ~10 s is unsafe.

### Context usage (server/src/contextUsage.ts)

Every agent's context gauge. Fed from `message.usage` on assistant records by `processTranscriptLine`, broadcast as `agentContextUsage` and rendered by `ToolOverlay`.

- **Snapshot, not a total.** Context = the newest turn's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`. Summing turns measures spend, not occupancy, and misses the cached tokens that ARE the context (`input_tokens` is single digits once caching kicks in). Falls on compaction and `/clear` for free.
- **All-zero usage means "no news"** — synthetic records (API errors, interrupts) report zeros and must not blank the gauge.
- **Sidechain rule**: a lead's sidechain records are its sub-agents' turns and must not move its gauge; a teammate's own transcript is sidechain top to bottom and would otherwise never report. Positional latch (`sawMainChainUsage`): once a file produces a main-chain turn, later sidechain records belong to someone else.
- **The window comes from the provider**, not from the runtime: `HookProvider.contextWindowForModel(model)` (Claude: 1M for the current line, 200k for Haiku and the older models, `undefined` for ids it can't place). Transcripts state usage but never the limit, and guessing 200k for a 1M model reads five times too full. `widenContextWindow` is the backstop for unrecognized models and unknown-larger windows — it only ever widens, since a context that doesn't fit disproves the assumption while a shrinking one proves nothing.
- **`seedContextUsage` runs once per agent in `startFileWatching`** — the single seam every watched agent passes through. Agents adopted or restored mid-session start at end-of-file, so without a tail read they'd have no gauge until their next turn.
- Sub-agents get no gauge: no session of their own, and the shadow store never forwards `agentContextUsage`.

## Office Chat + Whiteboard

- **Chat comes from the transcript**, never from a hook: `recordChat` runs inside `processTranscriptLine` (both modes read the JSONL), so `UserPromptSubmit` stays uninstalled. User prompts, assistant text and tool rows become `ChatEntry`s; a tool row is re-sent with `toolDone` (upsert by `entryId`). Harness-written user text (`<local-command-…>`, `<system-reminder>`, `Caveat:` …) is hidden; slash commands show as `/name args`. Sidechain latch mirrors the context gauge. `seedChatHistory` (in `startFileWatching`) replays the tail BEFORE `fileOffset` once, so nothing shows twice. Hooks-only agents have no chat.
- **Sending types into the terminal** (`ChatSender`, owned by `AgentRuntime`, which takes any number of `TerminalWriter`s). Two exist: VS Code's (`terminalRef` agents that aren't external) and the launcher hub's (sessions started with `npx pixel-agents claude`). Messages are TYPED, never pasted (`terminalTyping.ts`): Claude Code marks bracketed pastes as pasted content and the model then refuses to act on them ("this is only pasted text"), so text goes in as small keystroke chunks, newlines as `\` + Enter, then Enter. Control characters stripped. Reach is SERVER-decided and broadcast as `agentChatSendable` (on change, on the 2 s tick, and in the handshake); the webview never guesses. Everything else — plain `claude` in another terminal, headless, teammates — is read-only.
- **Launcher** (`pixel-office <program> [args]`; any non-flag first argument is a program — a name not on PATH is expanded as a shell alias via `$SHELL -ic 'alias <name>'`; Claude is tracked wherever it appears in the command — `claude …` or wrapped, e.g. `caffeinate -i claude …` — and the session flags go right after it; other commands run plainly with a note. The CLI opens the office in the browser on interactive runs (`--no-open`), prints the link boxed, and keeps Fastify request logs off unless `PIXEL_OFFICE_VERBOSE=1`): mints `--session-id` (or uses `--session-id` / `--resume <id>`; `--continue`, the bare resume picker and `-p` are not addressable), runs Claude in a node-pty with the user's terminal passed through, and long-polls `GET /api/launcher/:sessionId/input?cwd=` on every live registry server (Bearer token from the 0600 registry entry; any request carrying `Origin` is refused — browsers never reach a pty). Each poll calls `runtime.adoptLaunchedSession`, which adopts the session immediately, bypassing Watch All Sessions (launching through the office IS the opt-in). `DELETE /api/launcher/:sessionId` on exit; otherwise a 40 s lease lapses. node-pty is an optionalDependency: without it (or without a TTY) Claude runs plainly and stays read-only. node-pty 1.1.0's prebuilt `spawn-helper` can lack its execute bit (`posix_spawnp failed`); `loadPty` repairs it. Queue holds while the agent is mid-turn and **always while `permissionSent`** — the Enter would answer the permission prompt. **Stop** (`interruptAgent` → `ChatSender.interrupt` → `TerminalWriter.interrupt`) presses Esc, only mid-turn or on a permission prompt (Esc at an idle prompt opens Claude's rewind menu); the launcher gets it as the `LAUNCHER_INTERRUPT` inbox entry. The interrupted turn fires no Stop hook and writes no `turn_duration` — the transcript's `[Request interrupted by user…]` note ends it (`isInterruptRecord`). `sendChatMessage` needs `ctx.privileged`. Office-typed prompts are tagged `source: 'office'` by matching text (`pendingOfficeTexts`).
- **Whiteboard** (`runtime.board`, created lazily): pins `{id, kind: link|file|snippet|note, title, value, scope: agentIds (empty = all)}`; every change broadcasts `boardLoaded`. Pins carry an optional `detail` (notes; edited in place on the rail, `PATCH /api/board/pins/:id`, `board detail <id> "text"`), sent in brackets after the pin when attached. Attaching a pin prefixes the message text (`@path`, `title: url`, fenced snippet, note) — agents need nothing new. **Agents post too**: `pixel-office board add|list|detail|rm` (boardCli.ts) → Bearer `GET/POST/PATCH/DELETE /api/board/pins` (Origin refused), direct board.json write when no office runs.
- **Permission prompts answered in the office** (`permissionBroker.ts`, `PermissionPrompts.tsx`): the PermissionRequest hook (Claude, Codex) tags the event with `pixel_request_id`; a server with a privileged client open (`addDecider`: tokened /ws socket or the VS Code panel) replies `{await:true}` and broadcasts `agentPermissionAsk`; the hook long-polls `GET /api/hooks/:id/permission/:requestId` (`PERMISSION_POLL_MS`) until Allow/Deny/Terminal or `PERMISSION_WAIT_MS`, then prints Claude's `hookSpecificOutput.decision` — no output = the terminal dialog shows as before. So the PermissionRequest entry gets `PERMISSION_HOOK_TIMEOUT_S`, not 5 s. Asks close on answer, deadline, turnEnd/sessionEnd, or agent removal. Nobody connected ⇒ never held.
- **@mentions**: relay aliases match the office label (`displayName`, `agentName`, `<folder> #<id>`, `Agent #<id>`, `agent<id>`) — unnamed agents used to be unreachable. In group chat, `@Label` in the draft sends only to those members (`addressedMembers`; a spaced label is also matched dashed, `@Frontend-Dev`, which is what typing `@` + Tab/click inserts); with no mention a team channel sends to its lead only (`defaultRecipients`), `# everyone` to all ticked. The relay toggle shows for any privileged connection (`officeCapabilities.privileged`).
- **Chat files**: `POST /api/files?name=` stores under `~/.pixel-agents/files/chat_<hex>-<name>` and returns `{path}`; the message goes out as `@<path>`. `GET /api/files/:name` serves uploaded IMAGES only (inline previews). Standalone + `?token=` only.
- **+ Agent folder picker** (`FolderPicker.tsx`, `folderBrowser.ts`): browses sub-folders over `listFolder`/`folderListing` (privileged; dot-folders and node_modules hidden, project folders tagged).
- Clicking a character opens its chat (a sub-agent opens its parent's); "Terminal" in the card is what `focusAgent` used to be on click.

## Workflows

- A **workflow** is a markdown file, `~/.pixel-agents/workflows/<id>.md` (`workflowFile.ts` parses/serializes: front-matter `title`, numbered steps `N. [do|show|gate] text`, indented `ref:` / `show:` lines; lenient, so hand edits load). The FILE is the record: `WorkflowStore` polls the folder (name:mtime:size signature) and broadcasts `workflowsLoaded`.
- **Attach** (`attachWorkflow`, drag a card onto a character, chat card "Workflow", or "Give to…"): `runtime.attachWorkflow` needs `chatSender.canSend`, starts a **run** (`WorkflowRuns`, in memory — agent ids die with the process) and types `attachMessage`: the file's PATH and how to report, never the steps. A new run for the same agent stops the old one.
- Agents report with `pixel-office workflow step|gate|show <run> [n]` → Bearer `/api/workflows/runs/:runId/…` (Origin refused; 404 = not this office's run). Steps may arrive out of order: gaps become `skipped`, never refused. A gate marks the step `waiting` and long-polls; the office shows it in the prompt stack (Continue / Stop workflow). Removed agents' runs become `abandoned`.
- Webview: `WorkflowRail.tsx` (left rail + editor; shares the left edge with the task desk, one at a time), `WorkflowBadges.tsx` (progress pips under characters), run steps in the chat card, pure helpers in `webview-ui/src/workflows.ts`. Client messages go through `workflowMessages.ts` on both surfaces.

## Team presets, sharing, AI drafts

- **Preset** = `~/.pixel-agents/teams/<id>.json` (`TeamStore`, polled; `sanitizeTeam` in `teamFile.ts`: unique member names without spaces, at most one lead, ≤ `TEAM_MAX_MEMBERS`). Members carry role, instructions, start command, look (`palette`) and an optional `workflowId`.
- **Start** (`startTeam`, standalone only — `runtime.agentStarter` is `OfficeSessions`): `TeamRuns` starts ONLY the lead (`OfficeSessions.start`, `firstMessage()` on the command line: `fillGoal(goalTemplate, goal)` + role + the benched teammates and how to call them). The others are `benched` in the run until the lead's NEW reply names them as `@name` (`TeamRuns.onReply`, fed by chatLog's reply listener beside the relay, `callsMember` whole-word); each then starts once, its first message = role + roster + "@lead called you in: <reply>". A member's workflow message rides its first prompt with a pre-minted run id (`workflowIntro`); typed afterwards it queued behind the whole first turn. `relay: true` turns the @mention relay on. A 1 s link loop maps each session id to its adopted agent and then starts the member's workflow run (`attachWorkflow(agentId, id, runId)` — no typing). The team is an OFFICE grouping only: the webview calls `officeState.setTeamInfo`/`setLook` for members (team room, group chat channel, name, look) — the server never sets `teamName`/`leadAgentId`, so Claude-team config polling and the desk's "top-level" rule are untouched.
- **Export/import** (`webview-ui/src/teams.ts`): a bundle `{format:'pixel-team', version:1, team, workflows}` saved as `.pixelteam` or a `PXT1-` base64url share code. Commands are left out by default (aliases, paths); workflow `path`s never travel. `importTeam` saves workflows first under fresh ids (keep both), remaps members, saves the team — nothing starts. Workflows export as their markdown; `importWorkflow` parses one.
- **AI drafts** (`aiDraft.ts`): `claude -p … --output-format json --model AI_DRAFT_MODEL --disallowedTools Bash,Edit,Write,…` in the project folder only with `readProject`, else the temp dir; ≤ 2 in flight; the reply's JSON is sanitized and sent back to the requester only (`teamDraft` / `workflowDraft`). Never saved server-side — the user reviews it in the editor (guessed workflow steps drawn dashed) and saves. A drafted team's workflows go through `importTeam` on save.

## Messenger

- **Messages** (toolbar button, `M`, or ⤢ on a chat card; `MessengerPanel.tsx`, pure helpers in `webview-ui/src/messenger.ts`): a full-window (or docked beside the office — drag its left edge to resize, double-click resets; width per viewer under `MESSENGER_DOCK_WIDTH_KEY`) reader for long chats — client-side only, same `chat.*` state as the chat card. Replies render through `parseMarkdown` (fenced code, headings, lists, `code`, **bold**) into React elements — never HTML. Runs of tool rows fold into one "N steps" block (`groupEntries`); a file edit breaks out as its own diff card — tool rows carry `edit` (`ChatEdit`: path, kind, hunks) from the provider's optional `describeEdit` (Claude: Edit/MultiEdit/Write/NotebookEdit), bounded by `clipEdit` to `CHAT_EDIT_MAX_CHARS`; `editRows` trims shared lines to one line of context (not a real diff — old/new strings are already local). Message text uses `font-reading` (system face; the pixel font stays on chrome); reading prefs (font, size, fold steps, times) live in localStorage under `MESSENGER_PREFS_KEY`, wrapped in try/catch. Rooms in its list open the group chat on that channel (`initialChannelId`). The side panel (lg+) shows context, token totals, an outline of the user's prompts, and files the agent showed.

## Token Usage, Fire, Names, City Office

- **Token usage** (`server/src/tokenUsage.ts`): sums, unlike the context snapshot, so each request is folded ONCE per `message.id` as a delta (one request spans several records repeating the same usage, output growing while it streams). Totals include cache reads; the **burn rate** counts only NEW tokens (input + cache writes + output) over 5 min and decays on a 5 s tick. Sidechain records count (a sub-agent's spend is its lead's). Seeded once in `startFileWatching` from up to 32 MB before `fileOffset` (`partial` beyond that). Broadcast as `agentTokenUsage` (the UI shows only `outputTokens` — what the agent wrote; totals with cache reads re-count the whole context every request, so "ok" read as 63k); assistant chat entries carry their request's `usage`.
- **Fire**: the webview maps burn to `burnLevel` (`BURN_WARM_PER_MIN` smoke, `BURN_FIRE_PER_MIN` flames + glow, `webview-ui/src/constants.ts`); `renderBurnEffects` draws before speech bubbles, and TYPE frames speed up by `BURN_TYPING_SPEED`.
- **Rename**: `renameAgent` → `runtime.renameAgent` (control chars stripped, 32 chars) → `displayName` persisted on both surfaces' `PersistedAgent` → `agentRenamed` (also in the handshake). Labels prefer it everywhere.
- **City Office**: furniture `OFFICE_DESK`, `DUAL_MONITOR` (electronics, on/off), `CITY_WINDOW`, `PLANTER`, `CUBICLE_DIVIDER` plus the bundled preset `webview-ui/src/office/layout/presets/cityOffice.json`, applied from Settings → Use City Office Layout as an undoable editor edit (Undo/Reset restore the old layout). Floor pattern 3 (low contrast) — pattern 9 is a checkerboard.

## Agents the office runs (+ Agent in the browser)

- `startAgent` (privileged, standalone) → `OfficeSessions` (`server/src/officeSessions.ts`) spawns Claude in a node-pty the server owns — no terminal window. `planLaunch` mints the session id; the command may be an alias but must run Claude. The agent is adopted at once via `runtime.adoptLaunchedSession` (retried each second; the transcript only appears with the first prompt). `OfficeSessions.writer` is a third `TerminalWriter` for `ChatSender`. `closeAgent` kills the pty; pty exit removes the agent. Max `OFFICE_SESSION_LIMIT`.
- **Screen view**: pty output feeds `@xterm/headless`; the visible screen goes out as plain text (`agentScreen`, throttled) and `sendAgentKeys` (privileged, fixed key enum) presses keys — the only way to answer Claude's on-screen questions (trust this folder, permission prompts). A numbered choice on screen (`looksLikeQuestion`) sets `permissionSent` + `agentToolPermission`, which holds the chat queue (ChatSender never types during a prompt) and is cleared only if the screen set it.
- **On-screen questions become dialogs** (`parseScreenQuestion`, `ScreenQuestionCard.tsx`): `agentScreen` carries `question {key, prompt, options}` whenever the screen shows a numbered choice ("❯ 1. Yes") OR an unnumbered cursor menu over an "Enter to confirm / Esc to cancel" hint — current Claude's folder-trust dialog has NO numbers, which `looksLikeQuestion` used to miss. The options are the LAST "1." on screen (a numbered list higher up in the conversation is not a dialog). `answerScreenQuestion` (privileged) re-reads the screen, refuses unless the `key` (hash of prompt + options, not the cursor) still matches, then presses ↑/↓ to the option and Enter, one key per `OFFICE_SESSION_KEY_GAP_MS`. "No, and tell Claude what to do differently" opens a text box; the text goes through `sendChatMessage`, which the queue holds until the question is gone.
- **Typing waits until the terminal is ready** (`TerminalWriter.ready`, office-run sessions only): Claude drops keys while it starts up, and a key typed into a dialog answers it. A session starts not-ready; every change in the VISIBLE screen (content, not raw output — idle repaints don't count) re-holds it, and it becomes ready after `OFFICE_SESSION_SETTLE_MS` of stillness with no question showing, then calls `ChatSender.retry`. `looksLikeQuestion` strips the `│` borders real Claude draws around its dialogs (the unbordered-only regex missed the real trust dialog, so messages were typed into it and lost).
- **The first message rides the command line** (`claude "<prompt>"`), never the keyboard: typed text landed in the trust dialog and its Enter accepted it.
- `officeCapabilities` (handshake) tells the client whether + Agent is available (`canStartAgents` needs node-pty AND a privileged connection) and lists recent folders (in memory). `resendAgentActivity` re-sends a pending `agentToolPermission`.

## Team rooms and group chat

- **Team room** = an Area with `teamRoom: true` (layout JSON; the server treats layouts as opaque). `renderTeamRooms` always draws its glass walls + name tab. `OfficeState.moveIntoTeamRoom` (from `setTeamInfo`): a team (lead id) takes the first team room nobody holds with a free seat and its members are reseated there; no free room/seat → the usual cluster-next-to-lead. Freed in `removeAgent(lead)`. `+ Room` = `handleAddTeamRoom` (adds the area, enters the editor on the Area paint tool). Solo agents avoid rooms for free: `findFreeSeat` prefers unzoned seats. The City Office preset has a 4-desk main floor and two 4-desk rooms — a room needs a seat per member.
- **Group chat** (`GroupChatPanel.tsx`, helpers in `officeChat.ts`) is a client-side VIEW: channels = `# everyone` + one per team (`buildChannels`, named after the team's room); the conversation = members' own chats merged by time (`mergeTimeline`: tool rows dropped, the same prompt sent to several agents within 90 s collapses to one "you → N agents" line, relayed copies hidden). Sending loops `sendChatMessage` per ticked member. The first group message to an agent carries a one-line note (teammates, `~/.pixel-agents/board.md`, and `@Name` when the relay is on), stripped again for display.
- **@mention relay** (`server/src/mentionRelay.ts`): OFF by default, in-memory, toggled by `setAgentRelay` (privileged) / reported by `agentRelayState`. A NEW streamed assistant reply (never seeded history — `setReplyListener` in chatLog) is split by `addressedParts.ts`: only a paragraph that OPENS with `@displayName|agentName` (≤ 2 words before it; following lists/code and paragraphs after a trailing `:` stay with it) goes to that agent, as `Message from X (teammate, via the office): <its part>` through `ChatSender` — a passing mention ("@scout is still searching") sends nothing, and nobody gets the whole reply. Team call-ins (`TeamRuns.onReply`) use the same rule. Limits: `RELAY_PAIR_LIMIT` per sender→receiver and `RELAY_TOTAL_LIMIT` overall per `RELAY_WINDOW_MS` — every pass starts a paid turn and two agents can loop.
- **Team docs**: `BoardStore` writes `~/.pixel-agents/board.md` (every pin with type, `for:` names, path/url/body) on each change, so agents can read shared docs whenever they want; pins scoped to agents = team docs.
- Office-run teammates: team discovery may adopt a teammate's transcript under a different `sessionId`, so `OfficeSessions` matches agents by session id OR transcript basename.

## Task desk

- **Cards** (task / issue / feature) live in `~/.pixel-agents/tasks.json` (`taskStore.ts`, the BoardStore pattern: sanitize everything, atomic write, 2 s cross-window poll, `tasks.md` mirror). Vocabulary is in CONTEXT.md — say **card**, never "task" (that is Claude's Task tool).
- **Three files, three jobs**: `taskTransitions.ts` is the pure state machine (`draft → inbox → looking → brief → ready → working → result → done`; WHETHER a move is allowed, never mutates), `taskStore.ts` keeps cards, `taskDesk.ts` owns timing and side effects (who is free, folder matching, turn ends, typing the prompt). Same decide/perform split as the consent gate.
- **Folder matching needs the agent's real `cwd`**, which `projectDir` cannot give (it is the transcript folder; its name is the path with separators turned into `-`, not reversible). `agent.cwd` is learned from hook adoption, `adoptLaunchedSession`, the transcript's own `cwd` field (`agentCwd.ts`; sidechain records only fill an UNKNOWN cwd — a sub-agent may sit in its own worktree) and a tail/head seed in `startFileWatching`. `gitRoot.ts` resolves it to `{root, branch}` (`git rev-parse`, 2 s timeout, 5 s cache). Match is on the git top-level, so `repo/server` takes a `repo` card and a worktree is its own folder. No known cwd ⇒ never handed a card.
- **Who is free**: top-level session (no `leadAgentId`, no `spawnToolUseId`, not `hooksOnly`), `isWaiting`, no `permissionSent`, `chatSender.canSend` + `isIdle`, pick-up on, same root, on the card's `allow` list (empty = anyone in the folder), not already holding a card. **Pick-up defaults ON only for agents the office started** (`runtime.deskDefaultPickup` = `officeSessions.owns`); a session somebody started themselves is off until switched on, so the desk never types into work in progress.
- **The card's text never rides the keyboard.** The prompt is four short lines naming `pixel-office task show|brief|step|done <num>` (`taskCli.ts` → Bearer `GET/POST /api/tasks/:ref[/brief|/step|/done]`, any `Origin` refused). No offline mode: only the office process that handed a card out can take its reply.
- **Turn ends**: a claim records `sawBusy`; `agentStatus: waiting` only counts as a turn end AFTER the agent was seen active — it is still `waiting` right after the prompt is sent. A look that ends with no brief returns to the inbox, and after `TASK_MAX_LOOK_ATTEMPTS` goes to the human with an empty brief. A build that ends with no `task done` lands in `result` with the agent's last reply as the summary.
- **Two offices, one file**: agent ids mean nothing across processes, so every claim carries `owner` (pid). A process leaves foreign claims alone while that pid lives and releases them once it is gone. 409 from `/api/tasks` = "not handed out here"; the CLI tries the next live office.
- **`tick()` coalesces**: a call landing mid-pass joins it and the pass runs once more. Dropping it instead lost the human's call until the next 3 s tick.
- **Every desk client message is privileged** (`taskDeskMessages.ts`, shared by both surfaces' dispatch): a card is work agents spend tokens on. Refusals come back as `taskDeskNotice` to the requester only.
- **Starting an agent for a card** reuses `startAgent` unchanged — `command` is free text, aliases expand, extra args survive (`c-caff --model claude-opus-5`). It carries a first message because the office only sees a session once its transcript exists. Standalone only; the VS Code panel offers its workspace folders instead of the folder browser (`listFolder` is not routed there).
- **Not enforced yet**: "look only" is an instruction in the prompt, not a lock. The lock would be the `PreToolUse` hook denying edits while an agent's card is `looking`.
- **Drafts**: `saveDeskTask {draft: true}` creates a card in state `draft` — the human's own, invisible to agents (never assigned, left out of `tasks.md`). `deskTaskAction: publish` moves it to `inbox`. Title, details, kind, priority and folder stay editable in `draft` and `inbox`; the folder is frozen once an agent has looked.
- **Two views, one filter**: the rail groups cards (Needs you / Drafts / With agents / Done); "Full board" is a full-window overlay with one column per state (`deskColumns`) and the open card beside them. `filterCards` (text needs EVERY word; searches title, details, `#num`, folder name, newest brief + its subtasks; plus kind, folder, priority, agent) feeds both. The closed tab's count ignores the filter — a filter must never hide work waiting on the human.
- UI: `TaskDesk.tsx` (left rail, mirrors the whiteboard; tab counts cards waiting on you), `useTaskDesk.ts`, pure helpers in `webview-ui/src/taskDesk.ts` (`stuckReason` says why a waiting card isn't moving).

## Document viewer

- **"Show me"** (`focusRequests.ts`, `showCli.ts`, `FocusNotices.tsx`): `pixel-office show PATH [--lines A-B|--page N|--cell REF|--find TEXT] --why T [--wait]` → Bearer `POST /api/focus` (Origin refused). The request rides on a board FILE pin (reused if the path is already pinned), so the viewer loads it through the existing pin route and its checks — only the path travels. Requests are in memory (`runtime.focus`), broadcast whole as `focusRequests`; one open request per agent (a newer one replaces it and a waiting `--wait` gets `gone`). The asking agent is the `--agent` name, else the one agent in that folder (preferring one mid-tool). The office shows a notice + a doc bubble (`Character.docBubble`, drawn only when no other bubble shows); the viewer opens at the spot (numbered highlighted lines, `#page=N`, outlined cell) with the agent's note, Got it / Reply. `--wait` long-polls `GET /api/focus/:id`; a reply nobody waits for is typed to the agent through `ChatSender`. Source-code extensions are viewable (always `text/plain` + nosniff).

- Whiteboard **file pins** open inside the standalone office (`DocViewer.tsx`): PDF and images natively (blob URL), Word via `mammoth` rendered in a **sandboxed iframe** (`sandbox=""` — document HTML never runs in the office page), Excel via `read-excel-file` and CSV as a table (capped at `DOC_TABLE_MAX_ROWS`), text as text. Both libraries are dynamic imports, so they load only when such a file is opened.
- Server (`boardFiles.ts`, routes in `httpServer.ts`): `GET /api/board/files/:pinId` — the client names a PIN, never a path; only `kind: 'file'` pins, absolute or `~` paths, an extension allowlist (no html/svg/js), `realpath` re-checked, 25 MB cap, `nosniff`. `POST /api/board/files?name=` stores an upload under `~/.pixel-agents/files/<pinId>-<safe name>` (0600, `wx`) and pins it. Both need the Bearer token (the page reads `?token=`): a token holder can already type into sessions, an untokened LAN viewer gets nothing.
- **Pick and ask** (`DocRef` helpers in `docViewer.ts`): in the viewer, click line numbers (Shift for a range) or cells, type a PDF page, or take a whole Word/image file; "Add to selection" collects picks in a tray across files, "Ask <agent> about this" moves the tray onto that agent's chat (the open chat, else the agent whose "show me" is open) as chips. On send they are appended as `[@path lines A-B]` / `cells REF` / `page N` — `refText` never includes file content.
- **Review changes** (`proposals.ts`, `lineDiff.ts`, `proposeCli.ts`, `ReviewPanel.tsx`): `pixel-office propose FILE --from NEWFILE --why T [--wait]` → Bearer `POST /api/proposals` with two PATHS. The server diffs them (LCS, trimmed prefix/suffix, one replacement hunk past `maxCells`) into hunks with 2 lines of context — text files only (≤ 1 MB, no NUL bytes; docx/xlsx/pdf/images refused). One open suggestion per file. Decisions live on the server (`decideHunk`, `"*"` = all) so windows agree. **Apply** re-reads the file and refuses when its sha256 differs from the one at suggestion time — the hunks are then recomputed against the current file with decisions reset — else copies the old file to `~/.pixel-agents/backups/`, writes only accepted hunks (line endings, final newline and mode kept, tmp+rename), and tells the agent what landed (✓/✗ with reasons, … undecided) via the `--wait` poll or `ChatSender`. **Undo** restores the backup only while the file still has the applied hash. Not enforced: nothing stops an agent from editing directly (a PreToolUse deny would be the lock).
- VS Code panel: no View/upload (no HTTP route to call from the webview) — file pins still attach as `@path`.

## Phones

- `npx pixel-agents --lan` binds 0.0.0.0 and prints this machine's LAN URLs (with the token) for a phone on the same Wi-Fi, plus a warning: the token can type into sessions and traffic is plain HTTP.
- Touch (OfficeCanvas): one finger pans past `TOUCH_TAP_SLOP_PX` (a still finger stays a tap → normal click), two fingers pinch-zoom in whole steps; canvas has `touch-action: none`. Pin drag-and-drop is mouse-only — phones use the pin's Attach button.
- Under `MOBILE_BREAKPOINT_PX` the chat card is a full-width bottom sheet and the whiteboard rail goes full width.

## Office UI

**Rendering**: Game state in imperative `OfficeState` class (not React state). Pixel-perfect: zoom = integer device-pixels-per-sprite-pixel (1x–10x). No `ctx.scale(dpr)`. Default zoom = `Math.round(2 * devicePixelRatio)`. Z-sort all entities by Y. Pan via middle-mouse drag (`panRef`). **Camera follow**: `cameraFollowId` (separate from `selectedAgentId`) smoothly centers camera on the followed agent; set on agent click, cleared on deselection or manual pan.

**UI styling**: Pixel art aesthetic — sharp corners (`borderRadius: 0`), solid backgrounds (`#1e1e2e`), `2px solid` borders, hard offset shadows (`2px 2px 0px #0a0a14`, no blur). CSS variables in `index.css` `:root` (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...). Pixel font: FS Pixel Sans (`webview-ui/src/fonts/`), loaded via `@font-face`, applied globally.

Custom ESLint rules (`eslint-rules/pixel-agents-rules.mjs`) enforce: `no-inline-colors` (hex/rgb/rgba/hsl/hsla literals only in `constants.ts`), `pixel-shadow` (must use `var(--pixel-shadow)` or `2px 2px 0px`), `pixel-font` (must reference FS Pixel Sans). All `error`-level — they block PRs.

**Characters**: FSM states — active (pathfind to seat, typing/reading animation by tool type), idle (wander randomly with BFS, return to seat after `wanderLimit` moves). 4-directional sprites, left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading (Read/Grep/Glob/WebFetch). Sitting offset: characters shift down 6 px in TYPE state. Z-sort uses `ch.y + TILE_SIZE/2 + 0.5` so characters render in front of same-row furniture but behind lower-row furniture. **Chair z-sorting**: non-back chairs use `zY = (row+1)*TILE_SIZE` (capped to first row); back-facing chairs use `zY = (row+1)*TILE_SIZE + 1` so the chair back renders in front of the character. Chair tiles are blocked for all characters except their own assigned seat (per-character pathfinding via `withOwnSeatUnblocked`).

**Diverse palette assignment**: `pickDiversePalette()` counts palettes of current non-sub-agent characters; picks randomly from least-used palette(s). First 6 agents each get a unique skin; beyond 6, skins repeat with a random hue shift (45–315°) via `adjustSprite()`. Character stores `palette` (0-5) + `hueShift` (degrees). Sprite cache keyed by `"palette:hueShift"`.

**Spawn/despawn effect**: Matrix-style digital rain animation (0.3 s). 16 vertical columns sweep top-to-bottom with staggered timing. Spawn: green rain reveals character pixels. Despawn: character pixels consumed by green rain trails. `matrixEffect` field on Character (`'spawn'`/`'despawn'`/`null`). Normal FSM is paused during effect. Restored agents (`existingAgents`) use `skipSpawnEffect: true` to appear instantly.

**Sub-agents**: Negative IDs (from -1 down). Created on `agentToolStart` with "Subtask:" prefix, or lazily by `subagentToolStart` when missing (watched background spawns, post-reload recreation). Same palette + hueShift as parent. Click focuses parent terminal. Not persisted. Spawn at the closest free walkable tile to the parent (`closestFreeWalkableTile`) — around it, never in a seat. Idle (stop typing) when every tracked sub-tool row is done; overlay shows the latest non-done sub-tool status, falling back to the Subtask label.

**Speech bubbles**: Permission ("..." amber dots) stays until clicked/cleared. Waiting (green checkmark) auto-fades 2 s. Sprites in `spriteData.ts`.

**Sound notifications**: Ascending two-note chime (E5 → E6) via Web Audio API plays when waiting bubble appears (`agentStatus: 'waiting'`). `notificationSound.ts` manages AudioContext lifecycle; `unlockAudio()` on canvas mousedown resumes the context (webviews start suspended). Toggled via Settings modal. Persisted per-namespace in `~/.pixel-agents/config.json`.

**Seats**: Derived from chair furniture. `layoutToSeats()` creates a seat at every footprint tile of every chair. Multi-tile chairs produce multiple seats keyed `uid` / `uid:1` / `uid:2`. Facing direction priority: 1) chair `orientation` from catalog (front→DOWN, back→UP, left→LEFT, right→RIGHT), 2) adjacent desk direction, 3) forward (DOWN). Click character → select (white outline) → click available seat → reassign.

## Layout Editor

**Rooms tool** (`EditTool.ROOM`, "Rooms" in the editor and "+ Room" in the toolbar; `RoomToolOverlay.tsx`, pure geometry in `office/layout/rooms.ts`): a DOM surface over the canvas (so the canvas mouse code is untouched) for dragging a rectangle into a team room (`AreaDefinition.rect`), resizing by its 8 handles, moving it (furniture whose anchor is inside comes along), dragging its door along the walls, dropping in a ready-made room (`ROOM_TEMPLATES`) and filling a room with a preset (`FILL_PRESETS`). Anything that adds furniture goes through a **preview**: `officeState.rebuildFromLayout(after)` without an undo entry, Before/After swaps, Apply restores `before` then `applyEdit(after)`, Cancel restores `before`. "Paint a custom shape" is the old name-then-Area-paint flow.

**Doors and portals**: every team room has `door: {col,row,side}`; `ensureRoomDoors` gives rooms without a valid one a default (bottom wall first, facing floor) on every `rebuildFromLayout`, so older layouts keep working. Room walls now BLOCK walking except through the door — `setNavigation({blocked, portals})` (module state in `tileMap.ts`, set by OfficeState) makes `findPath` refuse blocked edges and treat `layout.portals` pairs as neighbours. A path step to a non-adjacent tile is a portal: `updateCharacter` jumps there and sets `warpTimer` (sparkle flash). Pets pass `{portals:false}`. `unreachableRooms` (BFS from outside every room, through doors and portals) drives the "can't be reached — place a portal pair" prompt; a room with no possible door is washed red in edit mode.

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture pick (eyedropper for furniture type), Eyedropper (floor).

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows may overlap walls.

**Furniture**: Ghost preview (green/red validity). R key rotates, T key toggles on/off state. Drag-to-move in SELECT. Delete button (red X) + rotate button (blue arrow) on selected items. Any selected furniture shows HSBC color sliders (Color toggle + Clear button); color stored per-item in `PlacedFurniture.color?`. Single undo entry per color-editing session (tracked by `colorEditUidRef`). Pick tool copies type+color from placed item. Surface items preferred when clicking stacked furniture.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture). Right-click in floor/wall/erase tools also erases to VOID (drag-erasing supported). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction. New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: ColorValue[] }`. Grid dimensions are dynamic. Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥2 = visible, `#RRGGBBAA` for semi-transparent). `loadDefaultLayout()` reads `assets/default-layout.json` as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with `id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?`. String-based type system. Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items use the `wall` category and appear in a dedicated "Wall" tab. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`).

**Office-life set** (standing desk, bean bag, rug, floor lamp, printer, server rack, water cooler, vending machine, fridge, arcade cabinet, ping-pong table, fish tank, wall TV) is drawn by `scripts/generate-office-furniture.mjs` (pngjs rectangles → PNGs + manifests); edit the drawing there and rerun rather than hand-editing those PNGs. The room tool's `FILL_PRESETS` place these by asset id (state groups by their `_OFF` id).

**Per-furniture manifests**: Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`; wall tile sets in `assets/walls/`.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants. State groups are mirrored across orientations.

**Auto-state**: `officeState.rebuildFurnitureInstances()` swaps electronics to ON sprites when an active agent faces a desk with that item nearby (3 tiles deep in facing direction, 1 tile to each side). Operates at render time without modifying the saved layout.

**Background tiles**: `backgroundTiles?: number` — top N footprint rows allow other furniture to be placed on them AND characters to walk through. Z-sort places bg-row items behind the host furniture.

**Surface placement**: `canPlaceOnSurfaces?: boolean` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks. Z-sort: surface items get `zY = max(spriteBottom, deskZY + 0.5)`.

**Wall placement**: `canPlaceOnWalls?: boolean` — items like paintings, windows, clocks can only be placed on wall tiles. `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile.

**Colorize module**: `colorize.ts` with two modes selected by `ColorValue.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture and character hue shifts): shifts original pixel HSL. `adjustSprite()` exported for character hue shifts. Cache keyed by arbitrary string (includes colorize flag).

**Floor tiles**: `floors.png` (112×16, 7 patterns). Cached by (pattern, h, s, b, c).

**Wall tiles**: `walls.png` (64×128, 4×4 grid of 16×32 pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16 px above tile (3D face). `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders. Wall sprites z-sorted with furniture/characters (`getWallInstances()` builds `FurnitureInstance[]`).

**Character sprites**: 6 pre-colored PNGs (`assets/characters/char_0.png`–`char_5.png`), one per palette. Each 112×96: 7 frames × 16 px wide, 3 direction rows × 32 px tall. Row 0 = down, Row 1 = up, Row 2 = right. Frame order: walk1, walk2, walk3, type1, type2, read1, read2. Left = flipped right at runtime. When `hueShift !== 0`, `hueShiftSprites()` applies `adjustSprite()` to all frames before caching.

**Load order**: `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` → `layoutLoaded`.

## Testing

Three tiers, each with its own framework.

### Server unit/integration (Vitest)

`server/__tests__/` covers the shared runtime, persistence, providers, HTTP/WebSocket server, CLI, diagnostics, asset reloads, and the e2e scenario runner. Representative suites include:

| File                           | Coverage                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentStateStore.test.ts`      | Mutations, EventEmitter events, snapshot                                                                                                       |
| `hookEventHandler.test.ts`     | Routing, buffering, normalized dispatch, team gating                                                                                           |
| `sessionRouter.test.ts`        | session_id mapping, pending sessions, buffer flush                                                                                             |
| `fileWatcherDismissal.test.ts` | DismissalTracker integration                                                                                                                   |
| `fileStateAdapter.test.ts`     | Namespaced persistence, allowlist, settings round-trip                                                                                         |
| `migrateVsCodeState.test.ts`   | Verify-before-clear, partial migration                                                                                                         |
| `teamUtils.test.ts`            | Inline-teammate helpers                                                                                                                        |
| `claudeTeamProvider.test.ts`   | Discovery, membership, metadata extraction                                                                                                     |
| `claude.test.ts`               | `normalizeHookEvent` per Claude event, file fallback                                                                                           |
| `claudeHookInstaller.test.ts`  | Atomic install/uninstall, unparseable-file + non-array abort, throwing writes, mode preservation, backup, hook identity, event-scope migration |
| `consentFlow.test.ts`          | In-app consent over the wire: who is asked, what each answer writes, Back-and-revise semantics, answer serialization                           |
| `claude-hook.test.ts`          | Spawned hook script integration (needs `dist/hooks/claude-hook.js`)                                                                            |
| `server.test.ts`               | HTTP lifecycle, auth, `/ws`, broadcast                                                                                                         |
| `httpServerWs.test.ts`         | `/ws` gate: standalone same-origin, embedded Bearer                                                                                            |
| `mockClaudeRunner.test.ts`     | E2E scenario runner sanity                                                                                                                     |

Run: `npm run test:server` (or `npm test` for all).

### Webview unit (Vitest, Node runner)

`webview-ui/test/` covers office state, layout editing and migration, assets, changelog behavior, and Vite/browser wiring.

Run: `npm run test:webview`.

### End-to-end (Playwright)

`e2e/` contains Playwright tests against a real VS Code Electron instance and a standalone Fastify server. CI runs the suite on Linux, macOS, and Windows in three shards at `--workers=1`. The generated [e2e inventory](e2e/README.md) is the source of truth for current specs, scenarios, and `@area:` coverage.

**Mock claude**: Tests never invoke real `claude`. A bash script (`e2e/fixtures/mock-claude`) is copied into an isolated `bin/` and prepended to `PATH`. The scenario runner (`mock-claude-runner.cjs`) honors `claudeScenario(...).at(ms).appendJsonl(record).emitHook(event).holdOpenFor(ms).build()` to drive timed JSONL writes and hook events.

**Authoring rules (normative)**: before writing a new spec, read `e2e/README.md` → "Mocking model & rules". It is the single source of truth for the process-boundary principle, the append-only transcript rule, the assert-on-visible-outcomes discipline, and the one standalone-server exception. New tests must follow that model.

**Isolation**: each test gets its own `tmpHome`, workspace directory, VS Code `--user-data-dir`, and mock-log file. No state leaks between tests.

**Auto-fixtures**: `_allureLabels` (auto: true) reads `@area:<tag>` from `testInfo.tags` and applies the corresponding Allure epic.

**Single source of truth for test inventory**: `e2e/README.md` contains an auto-generated section spliced between `<!-- BEGIN:E2E-INVENTORY -->` and `<!-- END:E2E-INVENTORY -->` markers. CI regenerates via `npm run e2e:inventory` and fails on `git diff --exit-code e2e/README.md`.

Run:

```bash
npm run e2e                                    # all tests
npm run e2e -- --workers=1                     # single worker (matches CI sharding)
npm run e2e -- --grep "lifecycle"              # filter by name
npm run e2e:debug                              # step-through
npm run e2e -- --attach-videos-on-success      # keep videos for passes too
npm run e2e:inventory                          # regen e2e/README.md inventory
npm run test:report                            # build combined Allure report
npm run test:report:open                       # serve Allure locally (file:// can't fetch)
```

**Reproducing CI failures locally**: CI uses `--workers=1` because the runners can't handle more. Reproduce locally with `npm run e2e -- --workers=1 --grep "<test>"`. For full Linux fidelity, `act -j linux-e2e --matrix shard:1 -P ubuntu-latest=catthehacker/ubuntu:full-22.04 --container-architecture linux/amd64` or run inside `mcr.microsoft.com/playwright:v1.58.2-noble` Docker with `--cpus=2 --memory=4g` to simulate runner throttling.

## Build & Dev

**npm workspaces monorepo** (`server`, `webview-ui`). A single `npm install` at the root installs deps for all workspaces; `cd webview-ui && npm install` is redundant.

```bash
npm install                # installs root + workspaces in one shot
npm run compile            # asyncapi:generate, check-types, lint, esbuild, vite
npm run build              # alias for compile
npm run package            # production build (esbuild --production)
npm test                   # webview + server vitest
npm run e2e                # Playwright
```

`esbuild.js` runs three bundles:

1. **Extension** (`dist/extension.js`) from `adapters/vscode/extension.ts`. External: `vscode`.
2. **CLI** (`dist/cli.js`) from `server/src/cli.ts`. Externals pulled at install time (`fastify`, `@fastify/*`).
3. **Hook scripts** (`dist/hooks/claude-hook.js`) from `server/src/providers/hook/claude/hooks/claude-hook.ts`. CJS, shebang.

`define: { 'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(version) }` stamps the package version into all bundles.

**Watch mode**:

```bash
npm run watch                       # parallel esbuild watch + tsc --noEmit watch
cd webview-ui && npm run dev        # Vite dev server (separate terminal)
```

The webview Vite dev server is **not** included in `npm run watch` — it has to be run separately.

**F5 in VS Code** launches the Extension Development Host with the local extension loaded.

### CI

Single workflow runs (in order): install, lint, `asyncapi:validate`, `asyncapi:generate` + drift check, `e2e:inventory` + drift check, `check-types`, `test:server`, `test:webview`, `e2e` (3-OS x 3-shard matrix: Linux, macOS, Windows), `package`, then a PR-only Vercel preview deploy of the combined Allure report (gated on secrets; gracefully skips on forks, non-blocking on failure). Pushes to `main` run the checks but never deploy to Vercel.

The drift checks are the central guarantees: `core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep; `e2e/README.md` stays in sync with the spec list.

## TypeScript Constraints

- **No `enum`** (`erasableSyntaxOnly` in webview) — use `as const` objects (`TileType`, `CharacterState`, `Direction`, `EditTool`).
- **`import type`** required for type-only imports (`verbatimModuleSyntax` in webview; convention in extension).
- **`noUnusedLocals` / `noUnusedParameters`** — strict everywhere.
- **`.js` extensions** on all relative imports in extension + server (Node16 module resolution).
- **Module Node16, target ES2022** in the extension/server. **`erasableSyntaxOnly`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`** in the webview.

## Constants Policy

All magic numbers and strings are centralized — never inline:

| Where                              | What lives there                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/constants.ts`          | All timing/scanning constants (`PERMISSION_TIMER_DELAY_MS`, `TEXT_IDLE_DELAY_MS`, scanner intervals) shared by extension and standalone |
| `adapters/vscode/constants.ts`     | VS Code-only IDs, command names, workspace state keys                                                                                   |
| `core/src/constants.ts`            | Protocol-level constants (e.g., transport state names)                                                                                  |
| `webview-ui/src/constants.ts`      | Webview magic numbers (grid, animation, rendering, camera, zoom, editor, game logic) + canvas overlay rgba strings                      |
| `webview-ui/src/index.css` `:root` | CSS custom properties (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...) for React inline styles and CSS                           |
| `webview-ui/src/office/types.ts`   | Re-exports grid constants from `constants.ts` for convenience                                                                           |

## Error Handling

- **Try-catch with graceful degradation** — errors logged but never crash the extension.
- **Malformed JSONL lines** silently ignored (catch block in `processTranscriptLine`).
- **Missing assets** logged with warning, operation continues with null/fallback.
- No centralized error reporting or telemetry.

## Logging

Use `console.log`/`error`/`warn` with prefixed context:

- Extension: `[Pixel Agents]`, `[Extension]`
- Asset loading: `[AssetLoader]`
- Webview: `[Webview]`

## Condensed Lessons

- `fs.watch` unreliable on Windows — always pair with polling backup.
- Partial line buffering essential for append-only file reads (carry unterminated lines).
- Delay `agentToolDone` 300 ms to prevent React batching from hiding brief active states.
- **Idle detection** has two signals: (1) `system` + `subtype: "turn_duration"` — reliable for tool-using turns (~98%), emitted once per completed turn. (2) Text-idle timer (`TEXT_IDLE_DELAY_MS = 5 s`) — for text-only turns. Only starts when `hadToolsInTurn` is false; suppressed once `hadToolsInTurn` becomes true. Reset on new user prompt or `turn_duration`. Cancelled by ANY new JSONL data.
- User prompt `content` can be string (text) or array (tool_results) — handle both.
- `/clear` creates a NEW JSONL file (old file just stops).
- `--output-format stream-json` needs non-TTY stdin — can't use with VS Code terminals.
- Hook-based IPC failed in early prototypes (hooks captured at startup, env vars don't propagate). HTTP `/api/hooks/:providerId` with `~/.pixel-agents/server.json` discovery works.
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 2 (`PNG_ALPHA_THRESHOLD`), supports `#RRGGBBAA` semi-transparent pixels.
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must call `onEditorSelectionChange()` to trigger React re-render for toolbar.
- **External-session adoption**: scanner runs every 3 s. In hooks-OFF mode external scenarios, the test setup can race the first scanner tick. Mock-claude scenarios should give a few seconds of margin before assertions.
- **Heuristic sub-agent permission bubble timing**: the bubble lands 7 s after the SUB-TOOL is registered, not 7 s after the parent Task tool appears. Tests waiting on it from the "Subtask:" overlay need at least `1 s (Task→Bash gap) + 7 s timer + ~300 ms IPC/render = 9–10 s` budget.
- **runInBackground sub-character gate**: in webview `agentToolStart`, `runInBackground=true` Agent tools are gated out of sub-character creation when the parent has a `teamName` (teammate path handles it). With no `teamName`, the gate must be bypassed so the basic Subtask sub-character still renders. `addSubagent` dedups via `subagentIdMap`, so the bypass is safe even if a teammate is detected later. `subagentToolStart` creates the sub lazily when it's missing — covering teamed leads' unnamed background spawns and post-reload recreation.
- **Allure HTML report**: viewing via `file://` fails (browsers block `fetch()` from local files). Use `npx allure open allure-report/allure` or `npm run test:report:open`.
- **Context usage is a snapshot against a provider-declared window**, and both halves are easy to get wrong: cumulative sums measure spend rather than occupancy, `input_tokens` without the cache counters measures almost nothing, and a 200k window assumed for a 1M model reads five times too full (the number to check it against is Claude Code's own statusline `context_window.used_percentage`).

## Manual Hook Testing

`server/manual-hook-events.http` (REST-Client format) drives the local hook server while the extension is running. Copy `port` and `token` from `~/.pixel-agents/server.json`, set `cwd` to a workspace folder opened in the Extension Development Host. Covers `SessionStart` → `PreToolUse` → `PermissionRequest`/`Notification`/`Stop` → `SessionEnd`.

If `cwd` is outside the current workspace, enable **Watch All Sessions** first.

## Asset Pipeline (legacy tileset import)

7-stage pipeline in `scripts/` for importing third-party tilesets (the bundled assets don't need this):

1. `0-import-tileset.ts` — Interactive CLI wrapper
2. `1-detect-assets.ts` — Flood-fill asset detection
3. `2-asset-editor.html` — Browser UI for position/bounds editing
4. `3-vision-inspect.ts` — Claude vision auto-metadata
5. `4-review-metadata.html` — Browser UI for metadata review
6. `5-export-assets.ts` — Export PNGs + `furniture-catalog.json`
7. `asset-manager.html` — Unified editor (stages 2+4 combined), Save/Save As via File System Access API

Supporting: `wall-tile-editor.html` (wall sprite editing), `jsonl-viewer.html` (transcript inspector).

## Key Decisions

- **Layered codebase** (core → server → adapters; core → webview-ui). Standalone CLI never imports `adapters/vscode/` and vice versa.
- **AsyncAPI 3.0 contract**, generated TS bindings, CI drift check. Single source of truth for the wire protocol.
- **AgentRuntime** shared lifecycle core, composed by both surfaces.
- **AgentStateStore** as single source of truth with typed mutations and typed events. No transport calls outside the broadcast layer.
- **Transport abstraction**: `MessageTransport` interface, `PostMessageTransport` + `WebSocketTransport`. One branching point in the entire UI.
- **HookProvider** as the integration boundary, with optional file fallback. New CLIs are a single subdirectory under `server/src/providers/hook/<id>/`.
- **TeamProvider** as optional extension. Claude Agent Teams is the only implementation.
- **Per-adapter namespaced persistence** under `~/.pixel-agents/`. VS Code and standalone never clobber each other.
- **Verify-before-clear migration** for legacy VS Code state.
- **Single `WebviewViewProvider`** (panel area, not editor area).
- **Inline esbuild problem matcher** (no extra extension needed).
- **`erasableSyntaxOnly`** in webview forbids `enum` — use `as const` objects.
- **Server always starts** regardless of hooks toggle. Only hook installation is gated by the setting.
- **Consent before any FIRST settings-file write**, per provider (`hooksConsent: {providerId: 'granted'|'declined'}`, absent = unanswered; the `hooksEnabled` preference beside it is per-provider and machine-global). **Exactly one population is asked: the one with nothing of ours installed** — hooks already on disk are granted silently at startup, since that install only ever removes events. The ask is one step of the Intro, the four-step first-run tour a greeter character speaks in-app on both surfaces (`IntroBubble.tsx`); the server sends `hooksConsentRequest` during the `webviewReady` handshake, one per provider, privileged connections only, carrying the provider's own `consentDisclosure()` so no client-side copy can drift. The ask-or-not predicate, the choice→action rule, and the execution live ONCE in `server/src/providers/hook/` (`consentGate.ts` decides, `consentExecutor.ts` performs); surfaces supply only their effects. **A choice is an absolute state command, not an event** — Back re-opens the ask, so a revision undoes whatever the earlier answer left: hooks on disk, a grant a failed install recorded, or a decline's own persisted hooks-off. That is why the consent record is a tri-state and each answer commits in ONE config write; the full rule and its rejected alternatives are `docs/adr/0001`. An abort (close x, Escape) sends nothing; the Intro shows by itself only once per browser (`INTRO_SEEN_KEY`, localStorage) and Settings → Show Welcome Tour replays it (with the consent step only while an ask is pending) — the ask stays answerable from the Settings hooks checkbox; the closing step reports the install OUTCOME, not the click.
- **`hooksStatus` is install state, `hooksEnabled` is preference.** The Settings checkbox binds to `hooksInstalled` and toggles the _displayed_ state with no optimistic local update, so it can't read "on" over an untouched settings.json and lands correct rather than flickering when an install fails. Every failure path re-derives and broadcasts the truth (standalone via `clientMessageHandler`, VS Code via `reportHooksStatus`). The hook script is copied BEFORE the entries are written; a failed copy aborts the install (entries pointing at a missing script spawn a dead `node` per event). **Hooks-off is persisted only AFTER a successful uninstall** — flipping it first strands the user: the entries keep firing while the persisted preference makes the next start skip the gate entirely.
- **Never rewrite a shape we did not author.** The unparseable-file abort generalizes: a non-object `hooks`, a non-array `hooks.<Event>`, and junk entries inside an event array are all refused or passed through, never replaced. An array `hooks` was the sharp case — string keys assigned onto it vanish from `JSON.stringify`, so the write committed and reported `installed: true` over a file with no hooks in it. Emptied event keys are deleted only when _our_ removal emptied them. **Internal sentinels must not be values user JSON can hold**: `null` marked "this entry is now empty", so a user-authored `null` inside a hooks array was silently deleted (a file with no Pixel Agents command anywhere came back rewritten and logged as "Hooks removed") — it is a `Symbol` now.
- **Hook identity is anchored at both ends, not a substring.** `includes('claude-hook.js') && includes('.pixel-agents')` claimed — and `uninstallHooks` then DELETED — a `.backup` copy of our script, a shell comment naming our path, a wrapper passing it as an argument, `/opt/evil.pixel-agents/hooks/claude-hook.js`, and `my-pixel-agents-hook.js`. Ours = the `/.pixel-agents/hooks/claude-hook.js` suffix, ending the command's FIRST token, matched **case-insensitively** (the token is normalized to lower case). Case-sensitive matching is what shipped, and on the case-insensitive volumes this runs on (macOS, Windows) a differently-cased path is the SAME INODE as our script and genuinely firing: reinstall appended a duplicate and uninstall left the cased entry as an orphan our own `areHooksInstalled` could no longer see — a live hook with no removal route. The folding is unconditional (no filesystem case-sensitivity probe), so the accepted trade is a Linux-only false positive that is **not** a mere dedup: on a case-sensitive volume `~/.Pixel-Agents/hooks/claude-hook.js` is a genuinely DIFFERENT file, we classify it as ours, and uninstall **deletes** it (`claudeHookInstaller.test.ts` pins that removal). Nothing creates that path, and the trade is deliberate — the alternative is a guaranteed unremovable live hook on the two platforms this actually ships to. A symlink alias to our script is deliberately _not_ recognized — the cost is one duplicate entry, versus deleting a stranger's hook if we resolved paths.
- **E2E over webview unit tests** for OSS friction. Community PRs change webview internals constantly; unit tests would force contributors to update internals tests on top of feature work. E2E pins user-facing behavior, which is stable across internal refactors.

## Project Identity

- Extension ID: `pablodelucca.pixel-agents` (VS Code Marketplace + Open VSX)
- npm package: `pixel-agents` (CLI bin: `pixel-agents`)
- GitHub: `https://github.com/pixel-agents-hq/pixel-agents`
- License: MIT
