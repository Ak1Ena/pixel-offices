import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ModelCatalog, parseModelOptions, sameModelLabel } from '../src/modelOptions.js';
import { parseScreenQuestion } from '../src/officeSessions.js';

// Claude Code's /model picker, as the office's headless terminal reads it.
const SCREEN = [
  '   Select model',
  '   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,',
  '   specify with --model.',
  '',
  '     1. Default (recommended)  Opus 5.5 with 1M context · Best for everyday, complex tasks',
  '   ❯ 2. Opus (1M context) ✔    Opus 5.5 with 1M context · Best for everyday, complex tasks',
  '     3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks',
  '     4. Sonnet                 Sonnet 5 · Efficient for routine tasks',
  '     5. Haiku                  Haiku 4.5 · Fastest for quick answers',
  '',
  '   ◐ Medium effort (default) ←/→ to adjust',
  '',
  '   Enter to set as default · s to use this session only · Esc to cancel',
];

let dir: string | null = null;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('model options from the CLI picker', () => {
  it('reads name, detail and the in-use mark off the picker', () => {
    const question = parseScreenQuestion(SCREEN);
    expect(question).not.toBeNull();
    expect(question!.selected).toBe(1);
    const options = parseModelOptions(question!);
    expect(options.map((o) => o.label)).toEqual([
      'Default (recommended)',
      'Opus (1M context)',
      'Fable',
      'Sonnet',
      'Haiku',
    ]);
    expect(options[1]).toMatchObject({
      number: 2,
      current: true,
      detail: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    });
    expect(options.filter((o) => o.current)).toHaveLength(1);
  });

  it('matches labels without case or spacing differences', () => {
    expect(sameModelLabel(' sonnet ', 'Sonnet')).toBe(true);
    expect(sameModelLabel('Opus  (1M context)', 'opus (1m context)')).toBe(true);
    expect(sameModelLabel('Opus', 'Sonnet')).toBe(false);
  });

  it('remembers each provider list on disk, without the per-session mark', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-models-'));
    const file = path.join(dir, 'model-options.json');
    const catalog = new ModelCatalog(file);
    const options = parseModelOptions(parseScreenQuestion(SCREEN)!);
    expect(catalog.set('claude', options)).toBe(true);
    expect(catalog.set('claude', options)).toBe(false);
    const reloaded = new ModelCatalog(file);
    expect(reloaded.get('claude').map((o) => o.label)).toContain('Sonnet');
    expect(reloaded.get('claude').some((o) => o.current)).toBe(false);
    expect(reloaded.messages()).toEqual([
      expect.objectContaining({ type: 'modelOptions', providerId: 'claude' }),
    ]);
  });
});
