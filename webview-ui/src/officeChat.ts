import type { BoardPin, ChatEntry } from '../../core/src/messages.js';
import {
  BOARD_POST_COMMAND,
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
  const body = formatPinBody(pin);
  return pin.detail?.trim() ? `${body}\n(${pin.detail.trim()})` : body;
}

function formatPinBody(pin: BoardPin): string {
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

/**
 * Whiteboard search: every word of the query must appear somewhere in the pin
 * (title, value, detail, type, or the names of the agents it is for).
 */
export function filterPins(
  pins: BoardPin[],
  query: string,
  labelOf: (agentId: number) => string = () => '',
): BoardPin[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return pins;
  return pins.filter((pin) => {
    const hay = [pin.title, pin.value, pin.detail ?? '', pin.kind, ...pin.scope.map(labelOf)]
      .join('\n')
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
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

// ── Group chat ──────────────────────────────────────────────

export interface ChannelMember {
  id: number;
  label: string;
  /** The member's lead (its own id when it leads a team); undefined for solo agents. */
  leadId?: number;
  /** Team room the member's team holds, if any. */
  room?: string | null;
}

export interface ChatChannel {
  id: string;
  name: string;
  members: number[];
  /** A team channel's lead; undefined for `# everyone`. */
  leadId?: number;
}

/** `# everyone` plus one channel per team (named after its room, else its lead). */
export function buildChannels(members: ChannelMember[]): ChatChannel[] {
  const channels: ChatChannel[] = [
    { id: 'everyone', name: 'everyone', members: members.map((m) => m.id) },
  ];
  const teams = new Map<number, ChannelMember[]>();
  for (const m of members) {
    if (m.leadId === undefined) continue;
    teams.set(m.leadId, [...(teams.get(m.leadId) ?? []), m]);
  }
  for (const [leadId, team] of teams) {
    if (team.length < 2) continue;
    const lead = team.find((m) => m.id === leadId);
    const room = team.find((m) => m.room)?.room;
    channels.push({
      id: `team-${leadId}`,
      name: room ?? `${lead?.label ?? `#${leadId}`}'s team`,
      members: team.map((m) => m.id),
      leadId,
    });
  }
  return channels;
}

/** Marks a message the office passed from one agent to another; hidden from group timelines. */
const RELAYED_RE = /^Message from .+ \(teammate, via the office\): /;
/** One-time note the office appends to a group message; stripped for display. */
const GROUP_NOTE_RE = / \(Team chat via Pixel Office\..*\)$/s;
/** Group sends to several agents land within this window and collapse into one line. */
const GROUP_SEND_WINDOW_MS = 90_000;

/**
 * Members a message addresses as `@Label` (or `@agent<id>`), matched whole-name
 * like the server's relay (mentionRelay.ts). Empty = no one in particular.
 */
export function addressedMembers(
  text: string,
  members: number[],
  labelOf: (agentId: number) => string,
): number[] {
  const lower = text.toLowerCase();
  const says = (alias: string) => {
    const needle = `@${alias.toLowerCase()}`;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      const next = lower[at + needle.length];
      if (next === undefined || !/[a-z0-9_-]/.test(next)) return true;
    }
    return false;
  };
  return members.filter((id) => {
    const label = labelOf(id);
    return [label, mentionHandle(label), `agent${id}`, `agent-${id}`].some(says);
  });
}

/** How to write a member as one `@word`: the label with its spaces turned into dashes. */
export function mentionHandle(label: string): string {
  return label.trim().replace(/\s+/g, '-');
}

/** The `@name` being typed at the end of a draft (without the `@`), else null. */
export function mentionQuery(draft: string): string | null {
  const m = /(?:^|\s)@([^\s@]*)$/.exec(draft);
  return m ? m[1] : null;
}

/** Replaces the `@name` being typed at the end of a draft with a member's handle. */
export function completeMention(draft: string, label: string): string {
  return draft.replace(/@[^\s@]*$/, `@${mentionHandle(label)} `);
}

/**
 * Who a message with no `@Name` goes to: a team channel talks to its lead (who
 * hands work out), `# everyone` to everyone. The lead unreachable = everyone.
 */
export function defaultRecipients(channel: ChatChannel, reachable: number[]): number[] {
  if (channel.leadId !== undefined && reachable.includes(channel.leadId)) return [channel.leadId];
  return reachable;
}

export function groupNote(teammates: string[], relayEnabled: boolean): string {
  const others = teammates.length > 0 ? ` Teammates: ${teammates.join(', ')}.` : '';
  const mention = relayEnabled ? ' To message a teammate, write @Name in your reply.' : '';
  return ` (Team chat via Pixel Office.${others} Shared docs and notes: ~/.pixel-agents/board.md. To post one yourself: ${BOARD_POST_COMMAND} "text".${mention})`;
}

export interface TimelineItem {
  key: string;
  /** null = you. */
  agentId: number | null;
  text: string;
  timestamp?: string;
  /** For your messages: the agents that received it. */
  recipients: number[];
}

/** One conversation out of several agents' chats: prompts you sent and agents' replies, by time. */
export function mergeTimeline(
  chats: Record<number, ChatEntry[] | undefined>,
  memberIds: number[],
): TimelineItem[] {
  const items: Array<TimelineItem & { at: number; order: number }> = [];
  let order = 0;
  for (const id of memberIds) {
    for (const entry of chats[id] ?? []) {
      if (entry.role === 'tool') continue;
      if (entry.role === 'user' && RELAYED_RE.test(entry.text)) continue;
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      items.push({
        key: `${id}:${entry.entryId}`,
        agentId: entry.role === 'user' ? null : id,
        text: entry.role === 'user' ? entry.text.replace(GROUP_NOTE_RE, '') : entry.text,
        timestamp: entry.timestamp,
        recipients: entry.role === 'user' ? [id] : [],
        at: Number.isFinite(at) ? at : 0,
        order: order++,
      });
    }
  }
  items.sort((a, b) => a.at - b.at || a.order - b.order);

  const merged: TimelineItem[] = [];
  for (const item of items) {
    const same =
      item.agentId === null
        ? [...merged]
            .reverse()
            .find(
              (m) =>
                m.agentId === null &&
                m.text === item.text &&
                Math.abs((m.timestamp ? Date.parse(m.timestamp) : 0) - item.at) <=
                  GROUP_SEND_WINDOW_MS,
            )
        : undefined;
    if (same) same.recipients.push(...item.recipients);
    else merged.push({ ...item, recipients: [...item.recipients] });
  }
  return merged;
}
