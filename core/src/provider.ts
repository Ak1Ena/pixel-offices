/**
 * Provider abstraction for AI agent tools.
 *
 * Only HookProvider ships today (Claude Code). Transcript-polling and push-based
 * provider types will be added when a real second provider (Codex, Goose,
 * Discord, etc.) actually lands, derived from that provider's needs rather than
 * speculation.
 */

import type { ChatEdit, ChatEntry } from './messages.js';
import type { TeamProvider } from './teamProvider.js';

// ── Normalized Events (all provider types produce these) ──────

export type AgentEvent =
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      input?: unknown;
      /** True when the tool was spawned to run in the background (e.g. Claude's
       *  `run_in_background` on Agent/Task). Handlers use this to suppress ghost
       *  sub-agent characters for teammate spawns. */
      runInBackground?: boolean;
    }
  | { kind: 'toolEnd'; toolId: string }
  | {
      kind: 'turnEnd';
      /** True when the turn ended because the agent went idle waiting on the
       *  user (Claude's Notification(idle_prompt)) rather than simply finishing
       *  its response (Stop). Drives the "Waiting for input" vs "Done" label.
       *  Absent/false = the agent finished its turn (Done). */
      awaitingInput?: boolean;
    }
  | {
      kind: 'subagentStart';
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: 'subagentEnd'; parentToolId: string; toolId: string }
  | {
      kind: 'subagentTurnEnd';
      parentToolId: string;
      /** 'idle' = subagent is idle and ready for more work; 'completed' = subagent
       *  reported its task done. Some providers emit only one; both route to the
       *  same handler but with different downstream cleanup. */
      reason: 'idle' | 'completed';
    }
  | { kind: 'progress'; toolId: string; data: unknown }
  | { kind: 'permissionRequest' }
  | {
      kind: 'sessionStart';
      source?: string;
      /** For external-session adoption: path to the session's transcript file
       *  (if the provider uses one). Undefined for providers without transcripts. */
      transcriptPath?: string;
      /** Working directory the session was started in. Used to match pending
       *  external sessions against known workspace folders. */
      cwd?: string;
    }
  | { kind: 'sessionEnd'; reason?: string };

// ── Hook-based Provider (CLIs with hooks APIs) ────────────────

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;
  /** Protocol version. Server refuses to dispatch events from a provider whose
   *  version it doesn't understand. Bump on every breaking change to AgentEvent
   *  / TeamProvider / HookProvider. Start at 1. */
  readonly protocolVersion: number;

  /** Normalize a raw hook event payload into an AgentEvent.
   *  Each CLI sends different JSON (Claude: snake_case, Copilot: camelCase, etc.)
   *  The provider translates to the common AgentEvent format.
   *  Return null for events we should ignore. */
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;

  /** Install hook scripts that POST to our server. */
  installHooks(serverUrl: string, authToken: string): Promise<void>;
  /** Remove installed hook scripts. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;
  /** First-run consent copy for THIS provider's hook install: the headline titles the ask, the disclosure is its body
   *  (what is written, what data moves, how to undo; paragraphs split on blank lines). Required, not optional — a
   *  provider that installs anything must state its terms, and the gate ships these verbatim so no client copy can
   *  drift. */
  consentDisclosure(): { headline: string; disclosure: string };

  /** When `raw` is a permission prompt this provider's hook script holds open
   *  while the office decides (answerPermission), what it asks for. Return null
   *  for every other event, or when the CLI cannot take a decision from a hook.
   *  The hook script marks such events with `pixel_request_id`. */
  describePermissionRequest?(
    raw: Record<string, unknown>,
  ): { toolName: string; detail?: string } | null;

  /** A display name the event carries for its agent (e.g. the Generic HTTP
   *  provider's `agent_name`). Applied only while the character has none, so
   *  a user's rename always wins. */
  agentNameFromEvent?(raw: Record<string, unknown>): string | undefined;

  /** A hooks-only CLI that keeps its OWN transcript (not Claude JSONL): where
   *  an event says it is, and a reader that turns its lines into chat. The
   *  runtime tails the file per agent; each reader is stateful (a tool row is
   *  marked done when its result line arrives). */
  chatTranscript?: {
    pathFromEvent(raw: Record<string, unknown>): string | undefined;
    createReader(): (line: string) => { entries: ChatEntry[]; doneToolIds: string[] };
  };

  /** Format tool status for display (e.g., "Read" -> "Reading foo.ts") */
  formatToolStatus(toolName: string, input?: unknown): string;
  /** What a file-editing tool call changes, for the chat's diff view; null for
   *  tools that don't edit files. Unclipped — the runtime bounds it. */
  describeEdit?(toolName: string, input?: unknown): ChatEdit | null;
  /** Tools that don't trigger permission timers */
  readonly permissionExemptTools: ReadonlySet<string>;
  /** Tools that spawn sub-agent characters */
  readonly subagentToolNames: ReadonlySet<string>;
  /** Tools that should show the "reading" character animation instead of "typing".
   *  The provider classifies tools as read-like or write-like; the webview renders
   *  the animation. Allows new providers to override without webview edits. */
  readonly readingTools: ReadonlySet<string>;
  /** Terminal name prefix used when launching this CLI. Used by the extension to
   *  match VS Code terminals to agents for heuristic adoption. */
  readonly terminalNamePrefix?: string;

  /** Context window, in tokens, for a model id this CLI reports in its
   *  transcripts. Transcripts state token usage but never the limit it counts
   *  against, so only the provider can say — and getting it wrong is visible:
   *  the office renders usage/window as a context gauge over every character.
   *  Return undefined for an unrecognized model; the runtime then keeps its
   *  previous estimate and widens it if a context ever exceeds it. */
  contextWindowForModel?(model: string | undefined): number | undefined;

  /** The CLI's own model picker, typed into an agent's terminal (Claude:
   *  `/model`). The office never keeps a model list of its own: it opens this
   *  picker, reads the options off the screen and chooses one. `sessionKey`
   *  is the key that applies the highlighted option to this session only
   *  (Claude: `s`); without it Enter is pressed. Absent = the office cannot
   *  switch this CLI's model. */
  readonly modelPicker?: ModelPicker;

  /** The slash commands the CLI accepts in `cwd` (built-ins, skills, plugin
   *  and project commands), as the CLI itself reports them — names without
   *  the leading `/`. Absent = the office cannot list them. */
  listSlashCommands?(cwd: string): Promise<string[]>;

  /** How to launch and address this CLI from `pixel-office <program>` and the
   *  office's own +Agent (see ProviderLaunch). Absent = the office can only
   *  adopt this CLI's sessions (hooks/heuristics), never start or track one
   *  it launches itself. */
  readonly launch?: ProviderLaunch;

  // ── Optional file fallback (heuristic mode) ──

  /** Session directories to scan. Undefined = no file fallback. */
  getSessionDirs?(workspacePath: string): string[];
  /** Root directories containing every session this provider may have started
   *  (across all workspaces). Used by global session discovery / "Watch All
   *  Sessions". Each returned dir contains subdirs whose entries are session
   *  transcript files. Undefined = this provider doesn't support global scan. */
  getAllSessionRoots?(): string[];
  /** Glob pattern for session files (e.g., '*.jsonl'). */
  readonly sessionFilePattern?: string;
  /** Parse one line of a transcript file into an AgentEvent. */
  parseTranscriptLine?(line: string): AgentEvent | null;
  /** Build CLI launch command for +Agent button. */
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  // ── Optional team/subagent extension (Agent Teams on Claude; empty for single-agent CLIs) ──

  /** Optional reference to a TeamProvider. When set, the hook handler registers team-aware
   *  branches (subagent routing, teammate discovery, permission forwarding, etc.). */
  readonly team?: TeamProvider;
}

// TODO(provider type taxonomy): FileProvider (polling-only CLIs) and StreamProvider
// (push-based external services) will be added alongside the first real second provider

/** How to drive a CLI's interactive model picker (see HookProvider.modelPicker). */
export interface ModelPicker {
  /** What to type to open it, e.g. `/model`. */
  command: string;
  /** Key that applies the highlighted option to this session only; absent = Enter. */
  sessionKey?: string;
}

/** A planned launch of a CLI: what to spawn, and the id the office will know
 *  the session by (see HookProvider.launch). */
export interface ProviderLaunchPlan {
  program: string;
  args: string[];
  /** The id the office addresses this session by. */
  sessionKey: string;
  interactive: boolean;
}

/** How to launch and address a CLI from a `pixel-office <program>` command
 *  line (see HookProvider.launch). */
export interface ProviderLaunch {
  /** Does this command run this CLI (as the program, or wrapped by another)? */
  claims(program: string, args: string[]): boolean;
  /** Plan the run, or null when the office cannot address it (bad flags, an
   *  unresumable/unaddressable combination, an invalid resume id). */
  plan(
    program: string,
    args: string[],
    opts: { firstMessage?: string; resume?: string; newId?: () => string },
  ): ProviderLaunchPlan | null;
  /** Whether `plan`'s `resume` option is supported. */
  canResume: boolean;
  /** Non-null = refuse the start with this message (the CLI needs a
   *  prerequisite, e.g. its hooks, before the office can address it). */
  requiresHooks?(): string | null;
  /** How a started session is adopted: 'transcript' = poll for the session's
   *  own transcript to appear; 'pid' = link the run's process id to the
   *  hooks it fires (CLIs with no transcript of their own). */
  adoption: 'transcript' | 'pid';
}
