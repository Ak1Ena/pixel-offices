/** Agent status for the roster chips and the 3D name tags (DOM-free). */

import { OFFICE3D_PALETTES } from './constants.js';
import type { OfficeState } from './office/engine/officeState.js';
import type { ToolActivity } from './office/types.js';

export type Status = { cls: 'work' | 'perm' | 'done' | 'idle'; text: string };

/** What an agent is doing, as a chip: the office's four states. */
export function agentStatus(
  os: OfficeState,
  id: number,
  tools: Record<number, ToolActivity[]>,
): Status {
  const ch = os.characters.get(id);
  if (!ch) return { cls: 'idle', text: 'Idle' };
  if (ch.bubbleType === 'permission' || tools[id]?.some((t) => t.permissionWait && !t.done)) {
    return { cls: 'perm', text: 'Needs you' };
  }
  if (ch.isActive) return { cls: 'work', text: 'Working' };
  if (ch.bubbleType === 'waiting') return { cls: 'done', text: 'Done' };
  return { cls: 'idle', text: 'Idle' };
}

export const STATUS_CHIP: Record<Status['cls'], string> = {
  work: 'bg-status-active/15 text-status-active',
  perm: 'bg-status-permission/20 text-status-permission',
  done: 'bg-status-success/15 text-status-success',
  idle: 'bg-bg-thumb text-text-muted',
};

/** The shirt colour an agent wears (its look, else its palette). */
export function agentColor(os: OfficeState, id: number): string {
  const ch = os.characters.get(id);
  if (!ch) return OFFICE3D_PALETTES[0].shirt;
  return ch.look?.shirt ?? OFFICE3D_PALETTES[((ch.palette % 6) + 6) % 6].shirt;
}
