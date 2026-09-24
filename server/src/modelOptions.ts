import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ModelOption, ScreenQuestion } from '../../core/src/messages.js';
import {
  LAYOUT_FILE_DIR,
  MODEL_DETAIL_MAX_CHARS,
  MODEL_LABEL_MAX_CHARS,
  MODEL_OPTIONS_FILE_NAME,
} from './constants.js';

/**
 * Model choices as a CLI's own picker shows them. The office keeps no model
 * list of its own: OfficeSessions opens the picker (`/model`) in an agent's
 * terminal, and the options on screen are the list.
 */

/** The picker's "in use" mark (Claude: "2. Opus (1M context) ✔"). */
const CURRENT_MARK_RE = /\s*[✔✓]\s*/;

/**
 * A picker's options: the name column is the label, the rest of the line the
 * detail. Claude: "Sonnet                 Sonnet 5 · Efficient for routine tasks".
 */
export function parseModelOptions(question: Pick<ScreenQuestion, 'options'>): ModelOption[] {
  return question.options.map((o) => {
    const current = CURRENT_MARK_RE.test(o.label);
    const [name, ...rest] = o.label
      .replace(CURRENT_MARK_RE, '  ')
      .trim()
      .split(/\s{2,}/);
    const detail = rest.join(' ').trim().slice(0, MODEL_DETAIL_MAX_CHARS);
    return {
      number: o.number,
      label: name.slice(0, MODEL_LABEL_MAX_CHARS),
      ...(detail ? { detail } : {}),
      ...(current ? { current: true } : {}),
    };
  });
}

/** Labels compare without case or spacing differences. */
export function sameModelLabel(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

function sanitizeOptions(raw: unknown): ModelOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelOption[] = [];
  for (const item of raw.slice(0, 20)) {
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o.label !== 'string' || !Number.isInteger(o.number)) continue;
    const label = o.label.trim().slice(0, MODEL_LABEL_MAX_CHARS);
    if (!label) continue;
    const detail = typeof o.detail === 'string' ? o.detail.slice(0, MODEL_DETAIL_MAX_CHARS) : '';
    out.push({ number: o.number as number, label, ...(detail ? { detail } : {}) });
  }
  return out;
}

/**
 * The last options each provider's picker showed, kept at
 * ~/.pixel-agents/model-options.json so start forms can offer them before
 * any agent of that provider runs. Without a `current` mark: that belongs to
 * one session.
 */
export class ModelCatalog {
  private byProvider: Record<string, ModelOption[]> | null = null;

  constructor(
    private readonly filePath: string = path.join(
      os.homedir(),
      LAYOUT_FILE_DIR,
      MODEL_OPTIONS_FILE_NAME,
    ),
  ) {}

  get(providerId: string): ModelOption[] {
    return this.load()[providerId] ?? [];
  }

  /** Remember a picker's options. Returns true when they changed. */
  set(providerId: string, options: ModelOption[]): boolean {
    const clean = sanitizeOptions(options);
    const all = this.load();
    if (JSON.stringify(all[providerId] ?? []) === JSON.stringify(clean)) return false;
    all[providerId] = clean;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to save model options:', err);
    }
    return true;
  }

  /** `modelOptions` messages, one per provider with a known list. */
  messages(): Array<{ type: 'modelOptions'; providerId: string; options: ModelOption[] }> {
    return Object.entries(this.load()).map(([providerId, options]) => ({
      type: 'modelOptions',
      providerId,
      options: structuredClone(options),
    }));
  }

  private load(): Record<string, ModelOption[]> {
    if (this.byProvider) return this.byProvider;
    this.byProvider = {};
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>;
      for (const [id, options] of Object.entries(data)) {
        if (/^[a-z0-9-]{1,32}$/.test(id)) this.byProvider[id] = sanitizeOptions(options);
      }
    } catch {
      /* nothing saved yet */
    }
    return this.byProvider;
  }
}
