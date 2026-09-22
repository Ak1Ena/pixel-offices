import * as path from 'path';

import type { AgentStateStore } from './agentStateStore.js';

/** One agent as `pixel-office agents` reports it. */
export interface RosterEntry {
  id: number;
  name: string;
  /** Hook provider id: claude, antigravity, codex, gemini, generic. */
  provider: string;
  status: 'working' | 'idle' | 'asking';
  /** What it is doing right now (the latest tool status), if anything. */
  doing?: string;
  folder?: string;
  /** Name of the agent that leads it (Claude teams), if any. */
  lead?: string;
  /** The agent asking: its session matched the caller's (see agentsCli). */
  you?: true;
}

/** The label the office shows (same order as the webview's agentLabel). */
function labelOf(agent: {
  id: number;
  displayName?: string;
  agentName?: string;
  folderName?: string;
}): string {
  return (
    agent.displayName ||
    agent.agentName ||
    (agent.folderName ? `${agent.folderName} #${agent.id}` : `Agent #${agent.id}`)
  );
}

/**
 * Every agent in this office, whatever CLI runs it — what an agent needs to
 * answer "who is online?" (Claude's own agent list knows Claude sessions only).
 */
export function officeRoster(store: AgentStateStore, askingSession?: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const [id, agent] of store) {
    const you =
      !!askingSession &&
      (agent.sessionId === askingSession ||
        agent.launchKey === askingSession ||
        (!!agent.jsonlFile && path.basename(agent.jsonlFile, '.jsonl') === askingSession));
    const doing = [...agent.activeToolStatuses.values()].pop();
    const lead = agent.leadAgentId !== undefined ? store.get(agent.leadAgentId) : undefined;
    out.push({
      id,
      name: labelOf({ ...agent, id }),
      provider: agent.providerId ?? 'claude',
      status: agent.permissionSent ? 'asking' : agent.isWaiting ? 'idle' : 'working',
      ...(doing ? { doing } : {}),
      ...(agent.cwd || agent.folderName ? { folder: agent.cwd ?? agent.folderName } : {}),
      ...(lead ? { lead: labelOf({ ...lead, id: agent.leadAgentId! }) } : {}),
      ...(you ? { you: true as const } : {}),
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Plain text for the CLI and for agents to read. */
export function describeRoster(entries: RosterEntry[]): string {
  if (entries.length === 0) return 'No agents in the office.';
  const lines = entries.map((e) => {
    const extra = [e.doing, e.lead ? `led by ${e.lead}` : '', e.folder].filter(Boolean).join(' · ');
    return `#${e.id} ${e.name}${e.you ? ' (you)' : ''} (${e.provider}) — ${e.status}${extra ? ` · ${extra}` : ''}`;
  });
  return `${entries.length} agent${entries.length === 1 ? '' : 's'} in the office:\n${lines.join('\n')}`;
}
