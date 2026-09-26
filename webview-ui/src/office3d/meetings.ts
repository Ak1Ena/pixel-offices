/**
 * Meetings in the 3D office. Two kinds:
 *
 * - Team: when every member of a team (a lead and its teammates) is free at
 *   the same time, they gather at a table (their team room's first) for a
 *   short catch-up. It is a picture of the team pausing together, driven by
 *   the agents' real states — nothing is sent to the agents.
 * - Stand-up: now and then, a few free agents with no team meet anyway.
 *
 * Both happen by themselves only while `auto` is on (off by default — per
 * viewer, OFFICE3D_AUTO_MEET_KEY); the Meeting panel starts one any time.
 *
 * A meeting only ever moves free agents (not working, not asking), and ends
 * the moment any attendee gets work: `OfficeState` walks them to their desk.
 */

import {
  OFFICE3D_AUTO_MEET_KEY,
  OFFICE3D_MEET_EVERY_SEC,
  OFFICE3D_MEET_LENGTH_SEC,
  OFFICE3D_MEET_SPEAK_SEC,
  OFFICE3D_TEAM_MEET_AFTER_SEC,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { isWalkable } from '../office/layout/tileMap.js';
import type { Character } from '../office/types.js';
import { CharacterState, Direction } from '../office/types.js';
import type { OfficeMeshes } from './build.js';

export const MEETING_LENGTH_SEC = OFFICE3D_MEET_LENGTH_SEC;

export interface Meeting {
  kind: 'team' | 'standup';
  title: string;
  table: OfficeMeshes['tables'][number];
  ids: number[];
  /** Who is talking now (a small talk bubble shows over them). */
  speaker: number | null;
  t: number;
}

function free(ch: Character): boolean {
  return (
    !ch.isSubagent &&
    !ch.isActive &&
    ch.bubbleType !== 'permission' &&
    !ch.matrixEffect &&
    !ch.isGreeter
  );
}

function loadAutoMeetings(): boolean {
  try {
    return localStorage.getItem(OFFICE3D_AUTO_MEET_KEY) === '1';
  } catch {
    return false;
  }
}

export class MeetingDirector {
  meeting: Meeting | null = null;
  private freeSince = new Map<string, number>();
  private lastTeamMeet = new Map<string, number>();
  private nextStandup = OFFICE3D_MEET_EVERY_SEC * 0.5;
  private time = 0;
  /** Hold meetings by themselves. */
  auto = loadAutoMeetings();
  /** e2e: one stand-up at the next tick, even with `auto` off. */
  private forceStandup = false;

  private readonly os: OfficeState;

  constructor(os: OfficeState) {
    this.os = os;
  }

  private office: OfficeMeshes | null = null;

  /** Start a meeting now with these agents (the free ones walk to a table).
   *  Returns why it could not start, or null. */
  startWith(title: string, ids: number[]): string | null {
    if (this.meeting) return 'A meeting is already on.';
    const tables = this.office?.tables ?? [];
    if (!tables.length) return 'There is no table big enough to meet at. Add a 2×2 desk or table.';
    const who = ids
      .map((id) => this.os.characters.get(id))
      .filter((c): c is Character => !!c && free(c));
    if (who.length < 2) return 'Pick at least two agents who are free right now.';
    const room = this.os.getTeamRoom(who[0].leadAgentId ?? who[0].id);
    const table =
      tables.find((t) => t.room && t.room === room) ?? tables.find((t) => t.room) ?? tables[0];
    return this.start('standup', title, table, who) ? null : 'Nobody could reach the table.';
  }

  update(dt: number, office: OfficeMeshes | null, leaving: Set<number>): void {
    this.time += dt;
    this.office = office;
    const m = this.meeting;
    if (m) {
      this.run(m, dt, leaving);
      return;
    }
    if (!office || office.tables.length === 0) return;
    if (!this.auto && !this.forceStandup) return;
    const chars = [...this.os.characters.values()].filter((c) => !leaving.has(c.id));

    // Team meetings: every member free for a while, not met recently.
    const teams = new Map<string, Character[]>();
    for (const c of chars)
      if (c.teamName && !c.isSubagent) teams.set(c.teamName, [...(teams.get(c.teamName) ?? []), c]);
    for (const [team, members] of teams) {
      if (members.length < 2 || !members.every(free)) {
        this.freeSince.delete(team);
        continue;
      }
      const since = this.freeSince.get(team) ?? this.time;
      this.freeSince.set(team, since);
      const last = this.lastTeamMeet.get(team) ?? -Infinity;
      if (
        this.time - since < OFFICE3D_TEAM_MEET_AFTER_SEC ||
        this.time - last < OFFICE3D_MEET_EVERY_SEC
      )
        continue;
      const room = this.os.getTeamRoom(members[0].leadAgentId ?? members[0].id);
      const table = office.tables.find((t) => t.room && t.room === room) ?? office.tables[0];
      if (this.start('team', `Team catch-up · ${team}`, table, members)) {
        this.lastTeamMeet.set(team, this.time);
        return;
      }
    }

    // Stand-ups: free agents with no team, now and then.
    if (this.time < this.nextStandup && !this.forceStandup) return;
    this.forceStandup = false;
    this.nextStandup = this.time + OFFICE3D_MEET_EVERY_SEC * (0.8 + Math.random() * 0.6);
    const loose = chars.filter((c) => free(c) && !c.teamName);
    if (loose.length < 2) return;
    const table = office.tables.find((t) => !t.room) ?? office.tables[0];
    this.start('standup', 'Stand-up', table, loose.slice(0, 6));
  }

  /** Walks the attendees to the free tiles around the table. */
  private start(
    kind: Meeting['kind'],
    title: string,
    table: Meeting['table'],
    who: Character[],
  ): boolean {
    const spots: Array<{ col: number; row: number; dir: Direction }> = [];
    for (let c = table.col; c < table.col + table.w; c++) {
      spots.push({ col: c, row: table.row - 1, dir: Direction.DOWN });
      spots.push({ col: c, row: table.row + table.h, dir: Direction.UP });
    }
    for (let r = table.row; r < table.row + table.h; r++) {
      spots.push({ col: table.col - 1, row: r, dir: Direction.RIGHT });
      spots.push({ col: table.col + table.w, row: r, dir: Direction.LEFT });
    }
    const open = spots.filter((s) =>
      isWalkable(s.col, s.row, this.os.tileMap, this.os.blockedTiles),
    );
    const ids: number[] = [];
    for (const ch of who) {
      // Try spots until one is reachable (some sit behind the table or in a closed corner).
      while (open.length) {
        const s = open.shift()!;
        if (this.os.walkToTile(ch.id, s.col, s.row)) {
          ids.push(ch.id);
          this.facing.set(ch.id, s.dir);
          break;
        }
      }
    }
    if (ids.length < 2) {
      for (const id of ids) this.os.sendToSeat(id);
      return false;
    }
    this.meeting = { kind, title, table, ids, speaker: null, t: 0 };
    return true;
  }

  private facing = new Map<number, Direction>();

  private run(m: Meeting, dt: number, leaving: Set<number>): void {
    m.t += dt;
    m.ids = m.ids.filter((id) => this.os.characters.has(id) && !leaving.has(id));
    const gone = m.ids.some((id) => {
      const ch = this.os.characters.get(id);
      return !ch || ch.isActive || ch.bubbleType === 'permission';
    });
    if (gone || m.ids.length < 2 || m.t > OFFICE3D_MEET_LENGTH_SEC) {
      this.end();
      return;
    }
    // Hold everyone at the table, facing it; take turns speaking.
    let seated = 0;
    for (const id of m.ids) {
      const ch = this.os.characters.get(id);
      if (!ch || ch.state !== CharacterState.IDLE) continue;
      ch.wanderTimer = Number.MAX_SAFE_INTEGER;
      ch.dir = this.facing.get(id) ?? ch.dir;
      seated++;
    }
    if (seated === m.ids.length) {
      const turn = Math.floor(m.t / OFFICE3D_MEET_SPEAK_SEC);
      m.speaker = m.ids[turn % m.ids.length];
    }
  }

  /** Seconds until the next stand-up is due; null while they are off. */
  nextIn(): number | null {
    return this.auto ? Math.max(0, this.nextStandup - this.time) : null;
  }

  /** Turn automatic meetings on or off (remembered for this viewer). Turning it on waits a full interval. */
  setAuto(on: boolean): void {
    this.auto = on;
    if (on) this.nextStandup = this.time + OFFICE3D_MEET_EVERY_SEC;
    try {
      localStorage.setItem(OFFICE3D_AUTO_MEET_KEY, on ? '1' : '0');
    } catch {
      /* remembered only when storage is available */
    }
  }

  /** e2e: hold a stand-up at the next tick. */
  standupNow(): void {
    this.forceStandup = true;
  }

  end(): void {
    const m = this.meeting;
    this.meeting = null;
    if (!m) return;
    for (const id of m.ids) {
      const ch = this.os.characters.get(id);
      if (!ch) continue;
      ch.wanderTimer = 0;
      if (!ch.isActive) this.os.sendToSeat(id);
    }
    this.facing.clear();
  }
}
