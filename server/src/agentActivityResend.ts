import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { prefsMessage } from './contextClear.js';
import { hasPromotedBackgroundAgent } from './teamUtils.js';
import { tokenUsageMessage } from './tokenUsage.js';

/**
 * Replay an agent's active state to a connecting client.
 *
 * Order matters:
 * 1. Team info first — webview needs team context before tool messages
 * 2. Regular tools
 * 3. Background tools with runInBackground + isTeammateSpawn flags, skipping promoted spawns
 * 4. Waiting status
 * 5. Context usage
 * 6. Name + token usage
 * 7. Session chat
 */
export function resendAgentActivity(
  send: (message: Record<string, unknown>) => void,
  store: AgentStateStore,
): void {
  for (const [id, agent] of store) {
    // 1. Team metadata first — webview uses this to route tool messages correctly.
    // Derived teams (named background spawns) have a name and a lead link but NO
    // teamName, so gate on any team field.
    if (agent.teamName || agent.agentName || agent.isTeamLead) {
      send({
        type: 'agentTeamInfo',
        id,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
      });
    }

    // 2. Regular (non-background) tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      // Skip background tools here — they're sent separately below with proper flags
      if (agent.backgroundAgentToolIds.has(toolId)) continue;

      const toolName = agent.activeToolNames.get(toolId) ?? '';
      send({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName,
      });
    }

    // 3. Background tools with runInBackground flag. Skip promoted spawns to prevent
    // ghost Subtask characters alongside the real teammate character.
    for (const toolId of agent.backgroundAgentToolIds) {
      if (hasPromotedBackgroundAgent(id, toolId, store)) continue;

      const status = agent.activeToolStatuses.get(toolId);
      if (!status) continue;

      const toolName = agent.activeToolNames.get(toolId);
      send({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName,
        runInBackground: true,
        isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
      });
    }

    // 3b. A pending permission prompt / on-screen question
    if (agent.permissionSent) send({ type: 'agentToolPermission', id });

    // 4. Waiting status
    if (agent.isWaiting) {
      send({
        type: 'agentStatus',
        id,
        status: 'waiting',
        // A replay, not a turn that just ended: no bubble, no chime.
        seeded: true,
      });
    }

    // 5. Context usage
    if (agent.contextTokens > 0) {
      send({
        type: 'agentContextUsage',
        id,
        contextTokens: agent.contextTokens,
        maxContextTokens: agent.maxContextTokens,
      });
    }

    // 6. Name + token usage
    if (agent.displayName) send({ type: 'agentRenamed', id, name: agent.displayName });
    if (agent.look) send({ type: 'agentLook', id, look: agent.look });
    // Only what the human changed: the client's defaults cover the rest.
    if (agent.clearPolicy || agent.docEditMode) send(prefsMessage(id, agent));
    const usage = tokenUsageMessage(id, agent);
    if (usage) send(usage);

    // 7. Session chat
    if (agent.chatLog && agent.chatLog.length > 0) {
      send({
        type: 'agentChatHistory',
        id,
        entries: agent.chatLog.map((e) => ({ ...e })),
      });
    }
  }
}

/** Whiteboard pins and queued office messages, for a connecting client.
 *  Both surfaces call this at the end of their handshake. */
export function sendOfficeChatState(
  send: (message: Record<string, unknown>) => void,
  runtime: AgentRuntime,
): void {
  send({ type: 'boardLoaded', pins: runtime.board.getPins() });
  send({ ...runtime.focus.snapshot() });
  send({ ...runtime.proposals.snapshot() });
  send({ type: 'workflowsLoaded', workflows: runtime.workflows.list() });
  send({ ...runtime.runs.snapshot() });
  send({ type: 'teamsLoaded', teams: runtime.teams.list() });
  send({ ...runtime.crews.snapshot() });
  send({ ...runtime.desk.snapshot() });
  void runtime.desk.tick(); // agents' folders resolve asynchronously; this broadcasts them
  send({ type: 'agentRelayState', enabled: runtime.relay.enabled });
  send({ ...runtime.contextClear.snapshot() });
  send({ ...runtime.docs.snapshot() });
  send({ ...runtime.files.snapshot() });
  send({ type: 'docEditDefault', mode: runtime.docs.defaultMode });
  send({ ...runtime.laya.snapshot() });
  if (runtime.desk.autopilot) send(runtime.desk.autopilot.snapshot());
  for (const ask of runtime.permissions.snapshot()) send(ask);
  for (const id of runtime.chatSender.sendableSnapshot()) {
    send({ type: 'agentChatSendable', id, sendable: true });
  }
  for (const { id, queued } of runtime.chatSender.snapshot()) {
    send({ type: 'agentChatQueue', id, queued });
  }
}
