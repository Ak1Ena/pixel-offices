import type { TeamPreset, Workflow } from '../../core/src/messages.js';

/**
 * Pure helpers for team presets in the office: the export bundle (a file or a
 * share code) and reading one back. The server re-validates everything it is
 * sent, so these only need to get the shape right.
 */

export interface TeamBundle {
  format: 'pixel-team';
  version: 1;
  team: TeamPreset;
  workflows: Workflow[];
}

const CODE_PREFIX = 'PXT1-';

/** The bundle for a team: its workflows ride along, commands only when asked. */
export function exportBundle(
  team: TeamPreset,
  allWorkflows: Workflow[],
  opts: { includeCommands: boolean; includeWorkflows: boolean },
): TeamBundle {
  const used = new Set(team.members.map((m) => m.workflowId).filter(Boolean));
  const workflows = opts.includeWorkflows
    ? allWorkflows
        .filter((w) => used.has(w.id))
        .map(({ id, title, steps }) => ({ id, title, steps }))
    : [];
  return {
    format: 'pixel-team',
    version: 1,
    team: {
      ...team,
      id: '',
      members: team.members.map((m) => {
        const next = { ...m, command: opts.includeCommands ? m.command : '' };
        if (!opts.includeWorkflows) delete next.workflowId;
        return next;
      }),
    },
    workflows,
  };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeShareCode(bundle: TeamBundle): string {
  return CODE_PREFIX + toBase64Url(JSON.stringify(bundle));
}

/** A bundle from a pasted share code or a .pixelteam file's text; null when it isn't one. */
export function readBundle(text: string): TeamBundle | null {
  const trimmed = text.trim();
  let json: string;
  try {
    json = trimmed.startsWith(CODE_PREFIX)
      ? fromBase64Url(trimmed.slice(CODE_PREFIX.length))
      : trimmed;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(json) as Partial<TeamBundle>;
    if (data.format !== 'pixel-team' || !data.team || !Array.isArray(data.team.members))
      return null;
    return {
      format: 'pixel-team',
      version: 1,
      team: data.team,
      workflows: Array.isArray(data.workflows) ? data.workflows : [],
    };
  } catch {
    return null;
  }
}

/** A file-name-safe name for an export: "Feature squad" → "feature-squad". */
export function fileSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'team'
  );
}
