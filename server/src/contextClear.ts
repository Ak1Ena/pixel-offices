import type { AgentClearRequest } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { ChatSender } from './chatSender.js';
import { CLEAR_REASON_MAX_CHARS } from './constants.js';
import type { AgentState } from './types.js';

export type ClearMode = 'clear' | 'compact';
export type ClearPolicy = NonNullable<AgentState['clearPolicy']>;
export type DocEditMode = NonNullable<AgentState['docEditMode']>;

const CLEAR_POLICIES: readonly ClearPolicy[] = ['ask', 'allow', 'never'];
const DOC_EDIT_MODES: readonly DocEditMode[] = ['ask', 'auto', 'off'];

/** What `pixel-office clear` gets back. */
export type SelfClearResult =
  | { ok: true; status: 'scheduled' | 'asked'; agentId: number }
  | { ok: false; status: 'unknown' | 'refused' | 'unreachable'; error: string };

const COMMAND: Record<ClearMode, string> = { clear: '/clear', compact: '/compact' };

/**
 * Clearing an agent's context from the office. Nothing new is typed after the
 * command — the agent starts blank. The command goes through ChatSender, so it
 * waits for the agent's turn to end and never lands on a permission prompt;
 * the runtime already follows /clear onto the new transcript (hooks: SessionEnd
 * + SessionStart; without hooks: content detection), keeping the character.
 *
 * An agent may ask for its own clear (`pixel-office clear`). What happens then
 * is the human's call per agent (`clearPolicy`): ask (default), allow, never.
 */
export class ContextClear {
  /** agent id → its open request, oldest first by insertion. */
  private readonly requests = new Map<number, AgentClearRequest>();

  constructor(
    private readonly store: AgentStateStore,
    private readonly chat: Pick<ChatSender, 'canSend' | 'send'>,
  ) {
    store.on('agentRemoved', this.onAgentRemoved);
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.requests.clear();
  }

  /** The human clears (or compacts) an agent. Returns an error to show, or null. */
  clear(agentId: unknown, mode: unknown = 'clear'): string | null {
    if (typeof agentId !== 'number' || !this.store.get(agentId)) return 'No such agent.';
    if (mode !== 'clear' && mode !== 'compact') return 'Unknown clear mode.';
    if (!this.chat.canSend(agentId))
      return 'The office cannot type into this agent’s terminal, so it cannot clear it.';
    this.chat.send(agentId, COMMAND[mode]);
    this.drop(agentId);
    return null;
  }

  /** An agent asks to have its own context cleared. */
  requestFromAgent(session: unknown, rawReason: unknown): SelfClearResult {
    const agentId = typeof session === 'string' ? this.agentForSession(session) : undefined;
    if (agentId === undefined) {
      return { ok: false, status: 'unknown', error: 'This session is not in this office.' };
    }
    const agent = this.store.get(agentId)!;
    const policy = agent.clearPolicy ?? 'ask';
    if (policy === 'never') {
      return {
        ok: false,
        status: 'refused',
        error: 'The human has turned off self-clearing for this agent.',
      };
    }
    if (!this.chat.canSend(agentId)) {
      return {
        ok: false,
        status: 'unreachable',
        error: 'The office cannot type into this terminal, so it cannot clear it.',
      };
    }
    if (policy === 'allow') {
      this.clear(agentId, 'clear');
      return { ok: true, status: 'scheduled', agentId };
    }
    const reason =
      typeof rawReason === 'string'
        ? rawReason
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .trim()
            .slice(0, CLEAR_REASON_MAX_CHARS)
        : '';
    this.requests.set(agentId, {
      agentId,
      at: new Date().toISOString(),
      ...(reason ? { reason } : {}),
    });
    this.publish();
    return { ok: true, status: 'asked', agentId };
  }

  /** The human answers an agent's request. */
  answer(agentId: unknown, allow: unknown): void {
    if (typeof agentId !== 'number' || !this.requests.has(agentId)) return;
    if (allow === true) this.clear(agentId, 'clear');
    else this.drop(agentId);
  }

  /** Per-agent settings the human picks: self-clear policy and document edit mode. */
  setPrefs(agentId: unknown, clearPolicy: unknown, docEditMode: unknown): void {
    if (typeof agentId !== 'number') return;
    const agent = this.store.get(agentId);
    if (!agent) return;
    let changed = false;
    if (CLEAR_POLICIES.includes(clearPolicy as ClearPolicy)) {
      agent.clearPolicy = clearPolicy as ClearPolicy;
      changed = true;
      if (clearPolicy === 'never') this.drop(agentId);
    }
    if (DOC_EDIT_MODES.includes(docEditMode as DocEditMode)) {
      agent.docEditMode = docEditMode as DocEditMode;
      changed = true;
    }
    if (!changed) return;
    this.store.persist();
    this.store.broadcast(prefsMessage(agentId, agent));
  }

  snapshot(): { type: 'agentClearRequests'; requests: AgentClearRequest[] } {
    return {
      type: 'agentClearRequests',
      requests: [...this.requests.values()].map((r) => ({ ...r })),
    };
  }

  private agentForSession(session: string): number | undefined {
    for (const [id, agent] of this.store) {
      if (sessionMatches(agent, session)) return id;
    }
    return undefined;
  }

  private drop(agentId: number): void {
    if (this.requests.delete(agentId)) this.publish();
  }

  private publish(): void {
    this.store.broadcast(this.snapshot());
  }

  private readonly onAgentRemoved = (id: number): void => this.drop(id);
}

/** An agent is known by its session id, the id its terminal was started with, or its transcript name. */
export function sessionMatches(agent: AgentState, session: string): boolean {
  if (!session) return false;
  if (agent.sessionId === session || agent.launchKey === session) return true;
  const base = agent.jsonlFile
    ?.split(/[\\/]/)
    .pop()
    ?.replace(/\.jsonl$/, '');
  return base === session;
}

/** `agentPrefs` for one agent, with the defaults filled in. */
export function prefsMessage(
  id: number,
  agent: Pick<AgentState, 'clearPolicy' | 'docEditMode'>,
): Record<string, unknown> {
  return {
    type: 'agentPrefs',
    id,
    clearPolicy: agent.clearPolicy ?? 'ask',
    ...(agent.docEditMode ? { docEditMode: agent.docEditMode } : {}),
  };
}
