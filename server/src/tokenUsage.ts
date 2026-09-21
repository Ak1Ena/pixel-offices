import * as fs from 'fs';

import type { TokenUsage } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { TOKEN_BURN_WINDOW_MS, TOKEN_DEDUPE_MESSAGES, TOKEN_SEED_MAX_BYTES } from './constants.js';
import type { AgentState } from './types.js';

/**
 * Token usage per agent: session totals and a burn rate, from the `usage`
 * block the transcript carries on assistant records.
 *
 * Unlike the context gauge (a snapshot of the newest request), these are
 * sums, so each request must be counted ONCE: Claude Code writes one request
 * as several records (one per content block) that repeat the same
 * `message.id` and usage, with the output count growing as it streams. So
 * usage is folded per message id as a delta against what that id already
 * contributed.
 *
 * Sidechain records count too: a sub-agent's tokens are spent by the session
 * that spawned it, and that is what the "on fire" effect is about.
 */

export interface TokenMeter {
  totalTokens: number;
  outputTokens: number;
  requests: number;
  /** True when the transcript was too big to total from the start. */
  partial: boolean;
  /** Usage already counted per message id (recent ids only, oldest first). */
  counted: Map<string, TokenUsage>;
  /** New tokens per request inside the burn window, oldest first. */
  recent: Array<{ at: number; fresh: number }>;
  /** Last burn rate broadcast, so the ticker only re-sends changes. */
  lastBurn: number;
}

interface UsageRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** A record's token usage, or null when it reports none (synthetic records report all zeros). */
export function usageOf(record: unknown): TokenUsage | null {
  const usage = (record as UsageRecord | null)?.message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const result = {
    input: count(usage.input_tokens),
    output: count(usage.output_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheCreation: count(usage.cache_creation_input_tokens),
  };
  return result.input + result.output + result.cacheRead + result.cacheCreation > 0 ? result : null;
}

export function newTokenMeter(): TokenMeter {
  return {
    totalTokens: 0,
    outputTokens: 0,
    requests: 0,
    partial: false,
    counted: new Map(),
    recent: [],
    lastBurn: 0,
  };
}

/** Fold one record into the meter. Returns true when the totals moved. */
export function foldUsage(meter: TokenMeter, record: unknown, now = Date.now()): boolean {
  const r = record as UsageRecord | null;
  if (r?.type !== 'assistant') return false;
  const usage = usageOf(record);
  if (!usage) return false;
  const key = r.message?.id ?? r.uuid;
  if (!key) return false;

  const before = meter.counted.get(key);
  const delta = {
    input: Math.max(0, usage.input - (before?.input ?? 0)),
    output: Math.max(0, usage.output - (before?.output ?? 0)),
    cacheRead: Math.max(0, usage.cacheRead - (before?.cacheRead ?? 0)),
    cacheCreation: Math.max(0, usage.cacheCreation - (before?.cacheCreation ?? 0)),
  };
  const added = delta.input + delta.output + delta.cacheRead + delta.cacheCreation;
  if (added === 0 && before) return false;

  meter.counted.delete(key); // re-insert: keeps the map ordered by recency
  meter.counted.set(key, {
    input: Math.max(usage.input, before?.input ?? 0),
    output: Math.max(usage.output, before?.output ?? 0),
    cacheRead: Math.max(usage.cacheRead, before?.cacheRead ?? 0),
    cacheCreation: Math.max(usage.cacheCreation, before?.cacheCreation ?? 0),
  });
  while (meter.counted.size > TOKEN_DEDUPE_MESSAGES) {
    meter.counted.delete(meter.counted.keys().next().value as string);
  }

  if (!before) meter.requests++;
  meter.totalTokens += added;
  meter.outputTokens += delta.output;
  const at = Date.parse(r.timestamp ?? '');
  const fresh = delta.input + delta.cacheCreation + delta.output;
  if (fresh > 0) meter.recent.push({ at: Number.isFinite(at) ? at : now, fresh });
  return true;
}

/** New tokens per minute over the burn window ending `now`. */
export function burnPerMinute(meter: TokenMeter, now = Date.now()): number {
  const since = now - TOKEN_BURN_WINDOW_MS;
  while (meter.recent.length > 0 && meter.recent[0].at < since) meter.recent.shift();
  const sum = meter.recent.reduce((acc, r) => acc + r.fresh, 0);
  return Math.round(sum / (TOKEN_BURN_WINDOW_MS / 60_000));
}

function broadcastUsage(
  agentId: number,
  meter: TokenMeter,
  agents: AgentStateStore,
  now = Date.now(),
): void {
  meter.lastBurn = burnPerMinute(meter, now);
  agents.broadcast({
    type: 'agentTokenUsage',
    id: agentId,
    totalTokens: meter.totalTokens,
    outputTokens: meter.outputTokens,
    requests: meter.requests,
    burnPerMinute: meter.lastBurn,
    ...(meter.partial ? { partial: true } : {}),
  });
}

/** Called for every parsed transcript line. */
export function recordTokenUsage(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  record: unknown,
): void {
  const meter = (agent.tokenMeter ??= newTokenMeter());
  if (foldUsage(meter, record)) broadcastUsage(agentId, meter, agents);
}

/**
 * Total what the transcript used BEFORE the read offset (what streams after
 * it is counted as it arrives). Runs once per agent, from startFileWatching.
 * A transcript over TOKEN_SEED_MAX_BYTES is totalled from its tail only.
 */
export function seedTokenUsage(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent || agent.tokenMeter || !agent.jsonlFile) return;
  const meter = (agent.tokenMeter = newTokenMeter());
  const end = agent.fileOffset;
  if (end <= 0) return;

  const start = Math.max(0, end - TOKEN_SEED_MAX_BYTES);
  meter.partial = start > 0;
  let text: string;
  try {
    const fd = fs.openSync(agent.jsonlFile, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    // Cheap pre-filter: most records carry no usage at all.
    if (!line.includes('"usage"')) continue;
    try {
      foldUsage(meter, JSON.parse(line));
    } catch {
      /* malformed line */
    }
  }
  if (meter.requests > 0) broadcastUsage(agentId, meter, agents);
}

/**
 * Burn decays with time, not just with records: re-send any agent whose
 * rate moved since its last broadcast. The runtime calls this on a timer.
 */
export function tickTokenBurn(agents: AgentStateStore, now = Date.now()): void {
  for (const [id, agent] of agents) {
    const meter = agent.tokenMeter;
    if (!meter || (meter.lastBurn === 0 && meter.recent.length === 0)) continue;
    if (burnPerMinute(meter, now) !== meter.lastBurn) broadcastUsage(id, meter, agents, now);
  }
}

/** Current usage for a connecting client. */
export function tokenUsageMessage(
  agentId: number,
  agent: AgentState,
): Record<string, unknown> | null {
  const meter = agent.tokenMeter;
  if (!meter || meter.requests === 0) return null;
  return {
    type: 'agentTokenUsage',
    id: agentId,
    totalTokens: meter.totalTokens,
    outputTokens: meter.outputTokens,
    requests: meter.requests,
    burnPerMinute: burnPerMinute(meter),
    ...(meter.partial ? { partial: true } : {}),
  };
}
