import type { BoardPin, ChatEntry } from '../../core/src/messages.js';
import {
  BURN_FIRE_PER_MIN,
  BURN_WARM_PER_MIN,
  CHAT_CLIENT_HISTORY_LIMIT,
  CHAT_PEEK_MAX_CHARS,
} from './constants.js';

/**
 * Pure helpers for the office chat and whiteboard (DOM-free, Node-testable).
 */

/** How a pin reads when attached to a message: what the agent actually receives. */
export function formatPinForPrompt(pin: BoardPin): string {
  switch (pin.kind) {
    case 'file':
      return `@${pin.value.trim()}`;
    case 'link':
      return `${pin.title}: ${pin.value.trim()}`;
    case 'snippet':
      return `${pin.title}:\n\`\`\`\n${pin.value}\n\`\`\``;
    case 'note':
      return `Note — ${pin.title}${pin.value.trim() ? `: ${pin.value.trim()}` : ''}`;
  }
}

/** The text typed into the terminal: attached pins first, then the message. */
export function composeMessage(text: string, pins: BoardPin[]): string {
  const parts = pins.map(formatPinForPrompt);
  if (text.trim()) parts.push(text.trim());
  return parts.join('\n\n');
}

/** Upsert entries by id, keeping order of first appearance and the history cap. */
export function mergeChatEntries(current: ChatEntry[], incoming: ChatEntry[]): ChatEntry[] {
  const next = current.slice();
  for (const entry of incoming) {
    const index = next.findIndex((e) => e.entryId === entry.entryId);
    if (index === -1) next.push(entry);
    else next[index] = entry;
  }
  return next.length > CHAT_CLIENT_HISTORY_LIMIT
    ? next.slice(next.length - CHAT_CLIENT_HISTORY_LIMIT)
    : next;
}

/** One-line preview of the agent's latest reply, for the bubble above it. */
export function chatPreview(entries: ChatEntry[] | undefined): string | null {
  if (!entries) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role !== 'assistant') continue;
    const line = entry.text.replace(/\s+/g, ' ').trim();
    return line.length > CHAT_PEEK_MAX_CHARS ? `${line.slice(0, CHAT_PEEK_MAX_CHARS)}…` : line;
  }
  return null;
}

/** Pins visible to one agent: board-wide ones plus those scoped to it. */
export function pinsForAgent(pins: BoardPin[], agentId: number | null): BoardPin[] {
  return pins.filter(
    (pin) => pin.scope.length === 0 || (agentId !== null && pin.scope.includes(agentId)),
  );
}

/** A fresh pin id (matches the server's [A-Za-z0-9_-]{1,64} rule). */
export function newPinId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2);
  return `pin_${random}`.slice(0, 64);
}

/** Compact token count: 950, 12.4k, 3.8M. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Burn level from new tokens per minute: 0 normal, 1 warm, 2 on fire. */
export function burnLevelFor(burnPerMinute: number): 0 | 1 | 2 {
  if (burnPerMinute >= BURN_FIRE_PER_MIN) return 2;
  if (burnPerMinute >= BURN_WARM_PER_MIN) return 1;
  return 0;
}
