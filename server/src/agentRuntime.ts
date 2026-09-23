/**
 * AgentRuntime: shared agent lifecycle core for VS Code and standalone modes.
 *
 * Owns all infrastructure that both PixelAgentsViewProvider (VS Code) and the
 * standalone CLI need: timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. Adapters (VS Code, CLI) create an instance
 * and register platform-specific lifecycle callbacks.
 *
 * This is the single source of truth for agent lifecycle wiring. No duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { pruneBackups } from './backups.js';
import { BoardStore } from './boardStore.js';
import { setReplyListener } from './chatLog.js';
import { ChatSender } from './chatSender.js';
import {
  AGENT_NAME_MAX_CHARS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  TOKEN_BURN_TICK_MS,
} from './constants.js';
import { ContextClear } from './contextClear.js';
import { DismissalTracker } from './dismissalTracker.js';
import { DocEdits } from './docEdits.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  isTrackedProjectDir,
  reassignAgentToFile,
  scanForBackgroundAgentFiles,
  scanForTeammateFiles,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  setSubagentWatch,
  setTeammateRegisterCallback,
  setTeammateRemovalCallback,
  setTeamProvider,
  startExternalSessionScanning,
  startFileWatching,
  startStaleExternalAgentCheck,
} from './fileWatcher.js';
import { FocusRequests } from './focusRequests.js';
import { HookChatWatch } from './hookChatWatch.js';
import type { HookEvent } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import { LauncherHub } from './launcherHub.js';
import { MentionRelay } from './mentionRelay.js';
import { OfficeFiles } from './officeFiles.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { PathSet, pathsMatch } from './pathKey.js';
import { PermissionBroker } from './permissionBroker.js';
import { suggestionsFilePath } from './proposals.js';
import { Proposals } from './proposals.js';
import { SessionRouter } from './sessionRouter.js';
import { SubagentWatch } from './subagentWatch.js';
import { TaskDesk } from './taskDesk.js';
import type { AgentStarter } from './teamRuns.js';
import { TeamRuns } from './teamRuns.js';
import { TeamStore } from './teamStore.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import { tickTokenBurn } from './tokenUsage.js';
import {
  setBackgroundAgentCompletedCallback,
  setBackgroundAgentDetectedCallback,
  setHookProvider,
  setTeamSwitchCallback,
} from './transcriptParser.js';
import type { AgentState } from './types.js';
import { attachMessage, newRunId, WorkflowRuns } from './workflowRuns.js';
import { WorkflowStore } from './workflowStore.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  /** Called when a teammate is removed. */
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state. PathSet (not Set) so a transcript adopted via hooks is still
  // recognized as known when a scanner rebuilds the path from the workspace folder
  // -- the two spellings differ by drive-letter case on Windows.
  readonly knownJsonlFiles = new PathSet();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private externalScanTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  /** Shadow-store watcher for unnamed background spawns (sub-agents). */
  readonly subagentWatch: SubagentWatch;
  /** Chat from hooks-only CLIs' own transcripts (agy). */
  private readonly hookChat: HookChatWatch;
  /** Office chat: messages typed into agents' terminals (host supplies the writer). */
  readonly chatSender: ChatSender;
  /** Agent-to-agent @mention passing (off by default). */
  readonly relay: MentionRelay;
  /** Permission prompts held open by a hook until the office answers them. */
  readonly permissions: PermissionBroker;
  /** Sessions started with `pixel-agents claude`: their launchers poll here for office input. */
  readonly launchers: LauncherHub;
  /** Clearing agents' context (/clear), by the human or on an agent's own request. */
  readonly contextClear: ContextClear;
  private boardStore: BoardStore | null = null;
  private focusRequests: FocusRequests | null = null;
  private proposalStore: Proposals | null = null;
  private docEditor: DocEdits | null = null;
  private officeFiles: OfficeFiles | null = null;
  private workflowStore: WorkflowStore | null = null;
  private workflowRuns: WorkflowRuns | null = null;
  private teamStore: TeamStore | null = null;
  private teamRuns: TeamRuns | null = null;
  /** Runs followed by process id (agy): terminal pid → its key and folder. */
  private readonly launchedPids = new Map<number, { key: string; cwd: string }>();
  /** Sessions whose hooks came from a followed pid: session id → key. */
  private readonly launchedSessions = new Map<string, string>();
  /** …and the folder their run was started in. */
  private readonly launchedCwds = new Map<string, string>();
  /** Starts agents the office runs itself (standalone only; set by the CLI). */
  agentStarter: AgentStarter | undefined;
  private taskDesk: TaskDesk | null = null;
  /** Which agents pick up task desk cards without being asked to (the host knows which it started). */
  deskDefaultPickup: (agentId: number) => boolean = () => false;
  private readonly tokenBurnTimer: ReturnType<typeof setInterval>;
  private hookEventHandler: HookEventHandler;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};
  /** Every provider whose hook events are routed, by id (primary included). */
  private readonly providersById = new Map<string, HookProvider>();

  /**
   * @param provider - The primary provider (Claude): transcripts, scanners,
   *   teams and launched sessions are its.
   * @param additionalProviders - Further providers whose hook events are
   *   routed by `/api/hooks/<id>` (Codex, Gemini, Generic). Their sessions
   *   become hooks-only agents that remember their provider, so tool status
   *   formatting and permission prompts use that provider's rules.
   */
  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: HookProvider,
    additionalProviders: readonly HookProvider[] = [],
  ) {
    for (const p of additionalProviders) this.providersById.set(p.id, p);
    this.providersById.set(provider.id, provider);
    // Wire module-level dependencies
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(provider);
    setFileWatcherHookProvider(provider);
    this.subagentWatch = new SubagentWatch(store);
    this.hookChat = new HookChatWatch(store);
    setSubagentWatch(this.subagentWatch);
    this.chatSender = new ChatSender(store);
    this.relay = new MentionRelay(store, (id, text) => this.chatSender.send(id, text));
    this.permissions = new PermissionBroker(store);
    this.contextClear = new ContextClear(store, this.chatSender);
    setReplyListener((id, text) => {
      this.relay.onReply(id, text);
      this.teamRuns?.onReply(id, text);
    });
    this.tokenBurnTimer = setInterval(() => tickTokenBurn(this.store), TOKEN_BURN_TICK_MS);
    this.tokenBurnTimer.unref?.();
    this.launchers = new LauncherHub(() => this.chatSender.refreshSendable());
    this.chatSender.addWriter(this.launchers.writer);
    if (provider.team) {
      setTeamProvider(provider.team);
    }
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));
    // New-style teammates run their own sessions; registering routes their hook
    // events (PreToolUse, Stop, SessionEnd) directly to the teammate agent.
    setTeammateRegisterCallback((sessionId, agentId) => this.registerAgent(sessionId, agentId));
    // Background spawns (teams OFF): classify by sidecar name on spawn (named
    // -> teammate character, unnamed -> shadow-watched sub-agent), remove when
    // the completion queue-operation lands on the lead.
    setBackgroundAgentDetectedCallback((leadId) => {
      scanForBackgroundAgentFiles(
        leadId,
        this.store,
        this.store.nextAgentId,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
        () => this.store.persist(),
        undefined,
      );
    });
    setBackgroundAgentCompletedCallback((leadId, toolUseId) => {
      for (const [id, agent] of this.store) {
        if (agent.leadAgentId === leadId && agent.spawnToolUseId === toolUseId) {
          this.removeTeammate(id, 'background-complete');
          break;
        }
      }
      // Unnamed spawns live in the shadow store; the webview sub-character is
      // cleared by the lead-side queue-op subagentClear, not by this call.
      this.subagentWatch.removeBySpawn(leadId, toolUseId);
    });
    // A resumed lead that spawns again belongs to a freshly minted implicit
    // team; its previous team's teammates are defunct. Promoted anonymous
    // background agents (leadAgentId but no teamName) are left untouched.
    setTeamSwitchCallback((leadId, previousTeamName) => {
      const stale = [...this.store].filter(
        ([, a]) => a.leadAgentId === leadId && a.teamName === previousTeamName,
      );
      for (const [id] of stale) {
        this.removeTeammate(id, 'team-switch');
      }
    });

    this.hookEventHandler = new HookEventHandler(
      store,
      this.waitingTimers,
      this.permissionTimers,
      provider,
      new SessionRouter(),
      this.watchAllSessions,
      (id) => this.providersById.get(id),
    );

    // Wire hook lifecycle callbacks to shared agent operations
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd, providerId) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        // Teammate session of a tracked lead? Attach it as a teammate character
        // instead of adopting a generic external agent -- and regardless of the
        // Watch All Sessions setting: tracking the lead is the opt-in for its
        // team. (Newer harnesses run every spawned agent as an independent
        // top-level session that fires its own hooks.)
        if (transcriptPath) {
          const teamMeta = provider.team?.getTeamMetadataForSession(transcriptPath);
          if (teamMeta?.teamName && teamMeta.agentName) {
            for (const [leadId, lead] of this.store) {
              if (lead.teamName !== teamMeta.teamName || lead.leadAgentId !== undefined) continue;
              console.log(
                `[Pixel Agents] Hook: session ${sessionId.slice(0, 8)}... is teammate "${teamMeta.agentName}" of Agent ${leadId}, attaching`,
              );
              scanForTeammateFiles(
                lead.projectDir,
                lead.sessionId,
                leadId,
                this.store.nextAgentId,
                this.store,
                this.fileWatchers,
                this.pollingTimers,
                this.waitingTimers,
                this.permissionTimers,
                () => this.store.persist(),
                undefined,
              );
              break;
            }
            // Done only if discovery actually adopted this transcript. Old-style
            // tmux teammates (non-UUID transcript names outside discovery's scan)
            // fall through to normal external adoption and self-identify from
            // their record tags.
            for (const a of this.store.values()) {
              if (pathsMatch(a.jsonlFile, transcriptPath)) return;
            }
          }
        }
        // A hooks-only session (no transcript) reports its working directory;
        // it is tracked when that is a workspace whose primary-provider project
        // dir is being watched.
        const launchKey = this.launchedSessions.get(sessionId);
        const tracked =
          launchKey !== undefined ||
          isTrackedProjectDir(projectDir) ||
          (!transcriptPath &&
            !!cwd &&
            (this.provider.getSessionDirs?.(cwd) ?? []).some((dir) => isTrackedProjectDir(dir)));
        if (!tracked && !this.watchAllSessions.current) {
          console.log(
            `[Pixel Agents] Hook: external session ${sessionId.slice(0, 8)}... not adopted ` +
              `(project untracked, Watch All Sessions off)`,
          );
          return;
        }
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.knownJsonlFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => {
            if (providerId && providerId !== this.provider.id) agent.providerId = providerId;
            if (cwd) agent.cwd = cwd;
            if (launchKey) agent.launchKey = launchKey;
            this.registerAgent(agent.sessionId, agent.id);
          },
        );
        if (launchKey) this.chatSender.refreshSendable();
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        if (newTranscriptPath) {
          this.knownJsonlFiles.add(newTranscriptPath);
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.knownJsonlFiles.delete(transcriptPath);
      },
      onTeammateDetected: (parentAgentId, sessionId, _agentType) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          // Don't register inline teammates: they share the lead's sessionId
          // and registering them would overwrite the lead in the session router.
          undefined,
        );
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      onSessionEnd: (agentId) => {
        const agent = this.store.get(agentId);
        if (!agent) return;
        this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        // Covers real team leads AND leads of background teammates (which
        // have children but no teamName). No-op when childless.
        this.removeTeammates(agentId);
        // Unnamed background spawns die with their lead's session too.
        this.subagentWatch.removeByLead(agentId);
        if (agent.isExternal) {
          this.unregisterAgent(agent.sessionId);
          this.removeAgent(agentId);
        }
      },
    });
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Hook event routing ──

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    const sessionId = typeof event.session_id === 'string' ? event.session_id : '';
    const pids = Array.isArray(event.cli_pids) ? event.cli_pids : [];
    const launch = pids
      .map((pid) => (typeof pid === 'number' ? this.launchedPids.get(pid) : undefined))
      .find((l) => l !== undefined);
    if (launch && sessionId) this.linkLaunched(sessionId, launch.key, launch.cwd);
    const cwd = sessionId ? this.launchedCwds.get(sessionId) : undefined;
    if (cwd && typeof event.cwd !== 'string') event = { ...event, cwd };
    this.hookEventHandler.handleEvent(providerId, event as HookEvent);
    const provider = this.providersById.get(providerId);
    if (!provider) return; // unknown provider: the handler dropped it too
    if (provider.chatTranscript && sessionId) {
      const chatAgent = this.hookEventHandler.agentIdForSession(sessionId);
      if (chatAgent !== undefined) this.hookChat.observe(chatAgent, provider, event);
    }
    // A finished turn or session settles every prompt it had open (answered in
    // another window, or in the terminal after the wait ran out).
    const kind = provider.normalizeHookEvent(event)?.event.kind;
    if (kind === 'turnEnd' || kind === 'sessionEnd') {
      const agentId = this.hookEventHandler.agentIdForSession(String(event.session_id));
      if (agentId !== undefined) this.permissions.closeForAgent(agentId);
    }
    // A name the event carries (Generic HTTP's agent_name) labels a character
    // that has none yet; a user's rename always wins.
    const name = provider.agentNameFromEvent?.(event);
    if (name) {
      const agentId = this.hookEventHandler.agentIdForSession(String(event.session_id));
      const agent = agentId !== undefined ? this.store.get(agentId) : undefined;
      if (agent && !agent.displayName) this.renameAgent(agentId, name);
    }
  }

  /**
   * A hook script is holding a permission prompt open (`pixel_request_id`).
   * Returns true when the office will answer it — the hook then polls for the
   * decision — and false when the prompt should show in the terminal as usual.
   * Call after handleHookEvent, so a just-confirmed session has its agent.
   */
  askPermission(providerId: string, event: Record<string, unknown>): boolean {
    const provider = this.providersById.get(providerId);
    if (!provider) return false;
    const described = provider.describePermissionRequest?.(event);
    if (!described) return false;
    const agentId = this.hookEventHandler.agentIdForSession(String(event.session_id));
    if (agentId === undefined) return false;
    return this.permissions.open({
      requestId: String(event.pixel_request_id),
      agentId,
      providerId,
      ...described,
    });
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number): void {
    this.hookEventHandler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string): void {
    this.hookEventHandler.unregisterAgent(sessionId);
  }

  // ── Agent removal (shared cleanup) ──

  /** Remove an agent: stop watchers, cancel timers, delete from store. */
  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;

    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Remove from store (fires agentRemoved event) and persist
    this.store.delete(id);
    this.store.persist();
  }

  /** Remove a single teammate agent. */
  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    // Background teammates (spawnToolUseId set) share the LEAD's session id;
    // unregistering it would knock the lead itself out of the session router.
    if (!agent.spawnToolUseId) {
      this.unregisterAgent(agent.sessionId);
    }
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
    if (agent.leadAgentId !== undefined) {
      this.demoteLeadIfTeamEmpty(agent.leadAgentId);
    }
  }

  /** Drop the LEAD badge when the last teammate leaves. teamName is kept: it
   *  still routes discovery of late-arriving teammates of the same generation
   *  (and linkTeammates / the derived-team path re-badge on the next spawn). */
  private demoteLeadIfTeamEmpty(leadId: number): void {
    const lead = this.store.get(leadId);
    if (!lead || !lead.isTeamLead) return;
    for (const a of this.store.values()) {
      if (a.leadAgentId === leadId) return;
    }
    lead.isTeamLead = undefined;
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: leadId,
      teamName: lead.teamName,
      agentName: lead.agentName,
      isTeamLead: undefined,
      leadAgentId: lead.leadAgentId,
    });
    this.store.persist();
  }

  /** Remove all teammates of a lead agent. */
  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (!agent.spawnToolUseId) {
          this.unregisterAgent(agent.sessionId);
        }
        this.removeAgent(id);
      }
    }
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(projectDir: string, onAgentCreated?: (agent: AgentState) => void): void {
    ensureProjectScan(
      projectDir,
      this.knownJsonlFiles,
      this.projectScanTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ?? ((agent) => this.registerAgent(agent.sessionId, agent.id)),
      this.hooksEnabled,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string): void {
    if (this.externalScanTimer) return;

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      this.hooksEnabled,
    );
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    if (this.staleCheckTimer) return;

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.store,
      this.knownJsonlFiles,
      this.hooksEnabled,
    );
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here (no terminal to rebind).
   * VS Code uses its own restoreAgents() in agentManager.ts to also handle
   * terminal agents via vscode.window.terminals.
   */
  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      // Its pty died with the office that ran it (an unclean stop left it saved):
      // restoring it would show a character nobody can reach. Keep the scanner off it too.
      if (p.officeRun) {
        this.dismissalTracker.dismiss(p.jsonlFile);
        continue;
      }
      // Background-spawn children (a leadAgentId but no teamName) are derived
      // state: the 1s scan re-materializes them from sidecars while their spawn
      // is live. Restoring them directly would resurrect immortal characters
      // (also skips stale entries written by older builds that persisted them).
      if (p.leadAgentId !== undefined && !p.teamName) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.knownJsonlFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent: AgentState = {
        id: p.id,
        sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
        terminalRef: undefined,
        isExternal: true,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        // Live spawn ids survive the restart so the 1s scan can re-adopt the
        // spawns' transcripts and the completion queue-op still matches.
        backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        lastDataAt: 0,
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName: p.folderName,
        hookDelivered: false,
        contextTokens: 0,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        teamName: p.teamName,
        agentName: p.agentName,
        isTeamLead: p.isTeamLead,
        leadAgentId: p.leadAgentId,
        teamUsesTmux: p.teamUsesTmux,
        palette: p.palette,
        hueShift: p.hueShift,
        displayName: p.displayName,
        cwd: p.cwd,
        pickup: p.pickup,
        launchKey: p.launchKey,
        clearPolicy: p.clearPolicy,
        docEditMode: p.docEditMode,
      };

      assignPaletteIfNeeded(agent, this.store);
      this.store.set(p.id, agent);
      this.knownJsonlFiles.add(p.jsonlFile);

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Naming ──

  /** Give an agent's character a user-chosen name; empty clears it. Persisted. */
  renameAgent(agentId: unknown, rawName: unknown): void {
    if (typeof agentId !== 'number' || typeof rawName !== 'string') return;
    const agent = this.store.get(agentId);
    if (!agent) return;
    const name = rawName
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, AGENT_NAME_MAX_CHARS);
    agent.displayName = name || undefined;
    this.store.persist();
    this.store.broadcast({ type: 'agentRenamed', id: agentId, name });
  }

  // ── Launched sessions ──

  /**
   * Make sure a session started with `pixel-agents claude` is in the office.
   * Launching through the office IS the opt-in, so this skips the Watch All
   * Sessions gate and the wait for a confirming hook that filters transient
   * sessions. Called on every launcher poll; a no-op once the agent exists or
   * while the provider can't place the transcript yet.
   */
  /**
   * Follow a run by process id (agy takes no session id up front): hook events
   * whose `cli_pids` (the hook's ancestors) include `pid` belong to the
   * terminal known as `key`, started in `cwd` (filled in when the event has
   * none — Windows can't read agy's working directory). Their
   * session is adopted whatever Watch All Sessions says — starting it through
   * the office is the opt-in — and the agent gets `launchKey` so the writers
   * find its terminal.
   */
  followLaunchedPid(pid: number, key: string, cwd: string): void {
    if (this.launchedPids.get(pid)?.key === key) return;
    this.launchedPids.set(pid, { key, cwd });
    for (const [sessionId, k] of this.launchedSessions) {
      if (k === key) this.linkLaunched(sessionId, key);
    }
  }

  /** Stop following a pid (its run ended). */
  forgetLaunchedPid(pid: number): void {
    const key = this.launchedPids.get(pid)?.key;
    this.launchedPids.delete(pid);
    if (!key) return;
    for (const [sessionId, k] of this.launchedSessions) {
      if (k !== key) continue;
      this.launchedSessions.delete(sessionId);
      this.launchedCwds.delete(sessionId);
    }
  }

  /**
   * Show a run the office follows by pid (agy) right away, before its first
   * hook: a hooks-only agent known by `key`. When agy's conversation turns up
   * (linkLaunched), the agent moves onto its session id. Idempotent.
   */
  adoptLaunchedHooksSession(key: string, cwd: string, providerId: string): void {
    for (const agent of this.store.values()) {
      if (agent.launchKey === key || agent.sessionId === key) return;
    }
    adoptExternalSessionFromHook(
      key,
      undefined,
      cwd,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      (agent) => {
        agent.providerId = providerId;
        agent.cwd = cwd;
        agent.launchKey = key;
        agent.isWaiting = true;
        this.registerAgent(key, agent.id);
      },
    );
    this.chatSender.refreshSendable();
  }

  /** Remove the agent of a followed run whose terminal went away. */
  endLaunched(key: string): void {
    for (const agent of this.store.values()) {
      if (agent.launchKey === key) this.removeAgent(agent.id);
    }
  }

  private linkLaunched(sessionId: string, key: string, cwd?: string): void {
    this.launchedSessions.set(sessionId, key);
    if (cwd) this.launchedCwds.set(sessionId, cwd);
    // The agent shown since the run started takes over the conversation's id.
    for (const agent of this.store.values()) {
      if (agent.launchKey !== key || agent.sessionId === sessionId) continue;
      this.unregisterAgent(agent.sessionId);
      agent.sessionId = sessionId;
      this.registerAgent(sessionId, agent.id);
      this.store.persist();
    }
    for (const agent of this.store.values()) {
      if (agent.sessionId === sessionId && agent.launchKey !== key) {
        agent.launchKey = key;
        this.chatSender.refreshSendable();
      }
    }
  }

  adoptLaunchedSession(sessionId: string, cwd: string): void {
    for (const agent of this.store.values()) {
      // launchKey: the agent moved to a new transcript (/clear) but is still this run.
      if (agent.sessionId === sessionId || agent.launchKey === sessionId) return;
      // Team discovery may already track this transcript under another session id.
      if (agent.jsonlFile && path.basename(agent.jsonlFile, '.jsonl') === sessionId) return;
    }
    const sessionDir = this.provider.getSessionDirs?.(cwd)[0];
    if (!sessionDir) return; // brand-new project: the dir appears with the first prompt
    const transcriptPath = path.join(sessionDir, `${sessionId}.jsonl`);
    console.log(`[Pixel Agents] Launcher: adopting session ${sessionId.slice(0, 8)}...`);
    adoptExternalSessionFromHook(
      sessionId,
      transcriptPath,
      cwd,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      (agent) => {
        agent.cwd = cwd;
        this.registerAgent(agent.sessionId, agent.id);
      },
    );
    this.chatSender.refreshSendable();
  }

  // ── Whiteboard ──

  /** The shared whiteboard. Created (and its file read and watched) on first use,
   *  so a runtime that never shows the office never touches board.json. Every
   *  change is broadcast to all clients as `boardLoaded`. */
  get board(): BoardStore {
    this.boardStore ??= new BoardStore(
      (pins) => {
        this.store.broadcast({ type: 'boardLoaded', pins });
        // A file's "pinned" flag in Files follows the board.
        if (this.officeFiles) this.publishFiles();
      },
      undefined,
      (agentId) => {
        const agent = this.store.get(agentId);
        return agent?.displayName ?? agent?.agentName ?? `agent #${agentId}`;
      },
    );
    return this.boardStore;
  }

  /** "Show me" requests from agents (`pixel-office show`); created on first use. */
  get focus(): FocusRequests {
    this.focusRequests ??= new FocusRequests(
      this.store,
      () => this.board,
      (id, text) => this.chatSender.send(id, text),
    );
    return this.focusRequests;
  }

  /** Changes agents suggested to files, waiting for review (`pixel-office propose`). */
  get proposals(): Proposals {
    this.proposalStore ??= new Proposals(
      this.store,
      (id, text) => this.chatSender.send(id, text),
      undefined,
      suggestionsFilePath(),
      (filePath) => this.fileWritten(filePath),
    );
    return this.proposalStore;
  }

  /** Edits to office documents (viewer saves, agents' `pixel-office doc edit`). */
  get docs(): DocEdits {
    this.docEditor ??= new DocEdits(
      this.store,
      () => this.proposals,
      undefined,
      undefined,
      undefined,
      (filePath) => this.fileWritten(filePath),
    );
    return this.docEditor;
  }

  /** Files: the documents the office opened (not the whiteboard); created on first use. */
  get files(): OfficeFiles {
    this.officeFiles ??= new OfficeFiles(
      () => this.publishFiles(),
      () => this.board.getPins(),
    );
    return this.officeFiles;
  }

  /**
   * Transcripts of sessions that ended with the previous office: kept from
   * being re-adopted as external sessions (see endedSessions.ts).
   */
  dismissEndedSessions(sessions: Array<{ file: string; at: number }>): void {
    for (const s of sessions) this.dismissalTracker.dismiss(s.file, s.at);
  }

  /** Broadcast Files (filesLoaded) — after anything that changes it outside the store. */
  publishFiles(): void {
    this.store.broadcast({ ...this.files.snapshot() });
  }

  /** The office wrote to a file: note it in Files, keep backups within bounds. */
  private fileWritten(filePath: string): void {
    pruneBackups();
    this.files.markEdited(filePath);
    this.publishFiles();
  }

  /** Saved workflows (~/.pixel-agents/workflows/*.md); read and watched on first use. */
  get workflows(): WorkflowStore {
    this.workflowStore ??= new WorkflowStore((workflows) =>
      this.store.broadcast({ type: 'workflowsLoaded', workflows }),
    );
    return this.workflowStore;
  }

  /** Workflows handed to agents in this office (in memory). */
  get runs(): WorkflowRuns {
    this.workflowRuns ??= new WorkflowRuns(this.store);
    return this.workflowRuns;
  }

  /** Saved team presets (~/.pixel-agents/teams/*.json). */
  get teams(): TeamStore {
    this.teamStore ??= new TeamStore((teams) =>
      this.store.broadcast({ type: 'teamsLoaded', teams }),
    );
    return this.teamStore;
  }

  /** Teams started from presets in this office. */
  get crews(): TeamRuns {
    this.teamRuns ??= new TeamRuns(this.store, () => this.agentStarter, {
      workflowIntro: (workflowId) => {
        const path = this.workflows.get(workflowId)?.path;
        if (!path) return undefined;
        const runId = newRunId();
        return { runId, text: attachMessage({ runId }, path) };
      },
      attachWorkflow: (agentId, workflowId, runId) => {
        const result = this.attachWorkflow(agentId, workflowId, runId);
        if (!result.ok) console.warn(`[Pixel Agents] Team workflow not attached: ${result.error}`);
      },
      setRelay: (enabled) => this.relay.setEnabled(enabled),
    });
    return this.teamRuns;
  }

  /**
   * Give a workflow to an agent: start a run and type a short message naming
   * the workflow FILE — the agent reads the steps itself. With `toldRunId`
   * the agent already has that message (in its first prompt): only the run starts.
   */
  attachWorkflow(
    agentId: unknown,
    workflowId: unknown,
    toldRunId?: string,
  ): { ok: true } | { ok: false; error: string } {
    if (typeof agentId !== 'number' || !this.store.get(agentId)) {
      return { ok: false, error: 'No such agent.' };
    }
    const workflow = this.workflows.get(workflowId);
    if (!workflow?.path) return { ok: false, error: 'No such workflow.' };
    if (toldRunId) {
      this.runs.start(agentId, workflow, toldRunId);
      return { ok: true };
    }
    if (!this.chatSender.canSend(agentId)) {
      return {
        ok: false,
        error:
          'The office cannot type to this agent. Start it from + Agent (or with pixel-office claude) to give it workflows.',
      };
    }
    const run = this.runs.start(agentId, workflow);
    this.chatSender.send(agentId, attachMessage(run, workflow.path));
    return { ok: true };
  }

  // ── Task desk ──

  /** The task desk. Like the whiteboard, created on first use: a runtime that
   *  never shows the office never reads tasks.json or hands out a card. */
  get desk(): TaskDesk {
    this.taskDesk ??= new TaskDesk({
      store: this.store,
      chatSender: this.chatSender,
      defaultPickup: (agentId) => this.deskDefaultPickup(agentId),
    });
    return this.taskDesk;
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. Called on shutdown. */
  dispose(): void {
    this.hookEventHandler.dispose();
    this.subagentWatch.dispose();
    this.hookChat.dispose();
    this.chatSender.dispose();
    this.permissions.dispose();
    this.contextClear.dispose();
    clearInterval(this.tokenBurnTimer);
    this.launchers.dispose();
    this.boardStore?.dispose();
    this.focusRequests?.dispose();
    this.proposalStore?.dispose();
    this.officeFiles?.dispose();
    this.workflowStore?.dispose();
    this.workflowRuns?.dispose();
    this.teamStore?.dispose();
    this.teamRuns?.dispose();
    this.taskDesk?.dispose();

    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
    if (this.externalScanTimer) {
      clearInterval(this.externalScanTimer);
      this.externalScanTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }
}
