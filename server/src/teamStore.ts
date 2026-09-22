import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TeamPreset } from '../../core/src/messages.js';
import {
  LAYOUT_FILE_DIR,
  LAYOUT_FILE_POLL_INTERVAL_MS,
  TEAM_DIR_NAME,
  TEAM_MAX_TEAMS,
} from './constants.js';
import { sanitizeTeam } from './teamFile.js';
import { slugify } from './workflowFile.js';

/**
 * Team presets: ~/.pixel-agents/teams/<id>.json, one file each, polled like
 * the workflows folder so edits from another window (or by hand) show up.
 */

function teamDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, TEAM_DIR_NAME);
}

export class TeamStore {
  private teams: TeamPreset[] = [];
  private loaded = false;
  private signature = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: (teams: TeamPreset[]) => void,
    private readonly dir: string = teamDir(),
  ) {}

  list(): TeamPreset[] {
    this.ensureLoaded();
    return structuredClone(this.teams);
  }

  get(id: unknown): TeamPreset | undefined {
    this.ensureLoaded();
    const found = this.teams.find((t) => t.id === id);
    return found ? structuredClone(found) : undefined;
  }

  save(raw: unknown): { ok: true; team: TeamPreset } | { ok: false; error: string } {
    this.ensureLoaded();
    const team = sanitizeTeam(raw);
    if (!team) return { ok: false, error: 'A team needs a name and at least one member.' };
    if (!team.id || !this.teams.some((t) => t.id === team.id)) {
      if (this.teams.length >= TEAM_MAX_TEAMS) {
        return { ok: false, error: `The office keeps at most ${TEAM_MAX_TEAMS} teams.` };
      }
      const base = slugify(team.title);
      let id = base;
      for (let n = 2; this.teams.some((t) => t.id === id); n++) id = `${base}-${n}`;
      team.id = id;
    }
    const filePath = path.join(this.dir, `${team.id}.json`);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(team, null, 2)}\n`, 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write team preset:', err);
      return { ok: false, error: 'Could not save the team file.' };
    }
    this.readFromDisk();
    this.onChange(this.list());
    return { ok: true, team: structuredClone(team) };
  }

  remove(id: unknown): boolean {
    this.ensureLoaded();
    if (typeof id !== 'string' || !this.teams.some((t) => t.id === id)) return false;
    try {
      fs.unlinkSync(path.join(this.dir, `${id}.json`));
    } catch {
      return false;
    }
    this.readFromDisk();
    this.onChange(this.list());
    return true;
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.readFromDisk();
    this.pollTimer = setInterval(() => {
      if (this.readFromDisk()) this.onChange(this.list());
    }, LAYOUT_FILE_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private readFromDisk(): boolean {
    let names: string[];
    try {
      names = fs
        .readdirSync(this.dir)
        .filter((n) => /^[a-z0-9-]{1,64}\.json$/.test(n))
        .sort()
        .slice(0, TEAM_MAX_TEAMS);
    } catch {
      names = [];
    }
    const signature = names
      .map((name) => {
        try {
          const st = fs.statSync(path.join(this.dir, name));
          return `${name}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${name}:gone`;
        }
      })
      .join('|');
    if (signature === this.signature) return false;
    this.signature = signature;
    const teams: TeamPreset[] = [];
    for (const name of names) {
      try {
        const team = sanitizeTeam(JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf-8')));
        if (team) teams.push({ ...team, id: name.slice(0, -5) });
      } catch {
        /* unreadable file: skipped until it changes */
      }
    }
    this.teams = teams;
    return true;
  }
}
