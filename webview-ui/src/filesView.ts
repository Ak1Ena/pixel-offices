import type { OfficeFile } from '../../core/src/messages.js';

/** Pure helpers for the Files rail (DOM-free). */

export type FilesTab = 'recent' | 'review' | 'uploads' | 'backups';

/** The files a tab lists (Review and Backups list other things). */
export function filesTab(files: OfficeFile[], tab: FilesTab): OfficeFile[] {
  if (tab === 'uploads') return files.filter((f) => f.source === 'upload');
  if (tab === 'recent') return files;
  return [];
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
