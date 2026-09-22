import type { TeamMember, TeamPreset } from '../../core/src/messages.js';
import {
  TEAM_COMMAND_MAX_CHARS,
  TEAM_MAX_MEMBERS,
  TEAM_NAME_MAX_CHARS,
  TEAM_TEXT_MAX_CHARS,
  WORKFLOW_TITLE_MAX_CHARS,
} from './constants.js';

/** Team presets: validation, and the first messages a started team's members get. */

function clean(value: unknown, max: number, oneLine = false): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return (oneLine ? text.replace(/\s+/g, ' ') : text).trim().slice(0, max);
}

/** A client-sent (or imported, or AI-drafted) team, bounded and cleaned; null when unusable. */
export function sanitizeTeam(raw: unknown): TeamPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const title = clean(t.title, WORKFLOW_TITLE_MAX_CHARS, true);
  if (!title || !Array.isArray(t.members)) return null;
  const members: TeamMember[] = [];
  const names = new Set<string>();
  for (const m of t.members.slice(0, TEAM_MAX_MEMBERS)) {
    if (!m || typeof m !== 'object') continue;
    const member = m as Record<string, unknown>;
    let name = clean(member.name, TEAM_NAME_MAX_CHARS, true).replace(/[@\s]+/g, '-');
    if (!name) continue;
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${name}-${n}`;
    names.add(name.toLowerCase());
    const workflowId =
      typeof member.workflowId === 'string' && /^[a-z0-9-]{1,64}$/.test(member.workflowId)
        ? member.workflowId
        : '';
    const palette =
      Number.isInteger(member.palette) && (member.palette as number) >= 0
        ? (member.palette as number)
        : undefined;
    members.push({
      name,
      role: clean(member.role, TEAM_NAME_MAX_CHARS * 2, true) || name,
      ...(member.lead === true ? { lead: true } : {}),
      instructions: clean(member.instructions, TEAM_TEXT_MAX_CHARS),
      command: clean(member.command, TEAM_COMMAND_MAX_CHARS, true),
      ...(palette !== undefined ? { palette } : {}),
      ...(workflowId ? { workflowId } : {}),
    });
  }
  if (members.length === 0) return null;
  // Exactly one lead at most: the first one marked wins.
  let seenLead = false;
  for (const m of members) {
    if (m.lead && seenLead) delete m.lead;
    if (m.lead) seenLead = true;
  }
  const id = typeof t.id === 'string' && /^[a-z0-9-]{1,64}$/.test(t.id) ? t.id : '';
  return {
    id,
    title,
    description: clean(t.description, TEAM_TEXT_MAX_CHARS),
    goalTemplate: clean(t.goalTemplate, TEAM_TEXT_MAX_CHARS),
    relay: t.relay === true,
    members,
  };
}

/** The member that leads: the one marked, else the first. */
export function leadOf(team: TeamPreset): TeamMember {
  return team.members.find((m) => m.lead) ?? team.members[0];
}

/** "{goal}" in the template replaced by what the user typed (appended when absent). */
export function fillGoal(template: string | undefined, goal: string): string {
  const t = (template ?? '').trim();
  if (!t) return goal;
  return t.includes('{goal}') ? t.split('{goal}').join(goal) : `${t}\n\nGoal: ${goal}`;
}

/**
 * The first message each member starts with (it rides the command line). The
 * lead gets the goal; everyone gets their role, the roster, and how to reach
 * a teammate (@name in a reply — the office passes it on when relay is on).
 */
export function firstMessage(team: TeamPreset, member: TeamMember, goal: string): string {
  const lead = leadOf(team);
  const roster = team.members.map((m) => `@${m.name} (${m.role})`).join(', ');
  const talk = team.relay
    ? 'To message a teammate, write @their-name in your reply; the Pixel Office passes it on.'
    : 'Teammates cannot hear you directly; the user passes messages on.';
  const lines =
    member === lead
      ? [
          fillGoal(team.goalTemplate, goal),
          '',
          `You lead the team "${team.title}" in the Pixel Office: ${roster}.`,
          member.instructions ? `Your role: ${member.instructions}` : `Your role: ${member.role}.`,
          talk,
        ]
      : [
          `You are @${member.name}, the ${member.role} in the team "${team.title}", led by @${lead.name}.`,
          member.instructions ? `Your role: ${member.instructions}` : '',
          `Team: ${roster}.`,
          `Wait for instructions from @${lead.name} before you start. ${talk}`,
        ];
  return lines.filter((l, i) => l || i === 1).join('\n');
}
