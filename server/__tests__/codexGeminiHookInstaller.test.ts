import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const codex = await import('../src/providers/hook/codex/codexHookInstaller.js');
const gemini = await import('../src/providers/hook/gemini/geminiHookInstaller.js');
const { CODEX_HOOK_EVENTS } = await import('../src/providers/hook/codex/constants.js');
const { GEMINI_HOOK_EVENTS } = await import('../src/providers/hook/gemini/constants.js');
const { PERMISSION_HOOK_TIMEOUT_S } = await import('../src/constants.js');
const { SETTINGS_BACKUP_SUFFIX } = await import('../src/providers/hook/constants.js');

/**
 * The Codex and Gemini installers run on the shared hookSettingsInstaller, so
 * these pin what is provider-specific (path, events, entry shape, timeouts)
 * plus the safety rules on each real file — never the user's real HOME.
 */

type Hooks = Record<string, Array<{ matcher: string; hooks: Array<Record<string, unknown>> }>>;

let savedCodexHome: string | undefined;
let savedGeminiHome: string | undefined;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-codex-gemini-'));
  savedCodexHome = process.env['CODEX_HOME'];
  savedGeminiHome = process.env['GEMINI_CLI_HOME'];
  delete process.env['CODEX_HOME'];
  delete process.env['GEMINI_CLI_HOME'];
});

afterEach(() => {
  if (savedCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = savedCodexHome;
  if (savedGeminiHome === undefined) delete process.env['GEMINI_CLI_HOME'];
  else process.env['GEMINI_CLI_HOME'] = savedGeminiHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('codexHookInstaller', () => {
  const hooksPath = () => path.join(tmpBase, '.codex', 'hooks.json');
  const read = () => JSON.parse(fs.readFileSync(hooksPath(), 'utf-8')) as { hooks: Hooks };
  const ourCommand = () =>
    `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'codex-hook.js')}"`;

  it('installs one entry per event in ~/.codex/hooks.json with second timeouts', async () => {
    await codex.installHooks();
    const { hooks } = read();
    expect(Object.keys(hooks).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    expect(hooks.UserPromptSubmit).toBeUndefined();
    expect(hooks.Stop[0]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: ourCommand(), timeout: 5 }],
    });
    expect(hooks.PermissionRequest[0].hooks[0].timeout).toBe(PERMISSION_HOOK_TIMEOUT_S);
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBe(3);
    expect(codex.areHooksInstalled()).toBe(true);
  });

  it('is idempotent and keeps third-party hooks; uninstall removes only ours', async () => {
    fs.mkdirSync(path.join(tmpBase, '.codex'));
    const theirs = { matcher: '', hooks: [{ type: 'command', command: '/usr/bin/notify' }] };
    fs.writeFileSync(hooksPath(), JSON.stringify({ hooks: { Stop: [theirs] } }));
    await codex.installHooks();
    await codex.installHooks();
    expect(read().hooks.Stop).toHaveLength(2);
    // The user's file existed: it was backed up once before our first write.
    expect(fs.existsSync(hooksPath() + SETTINGS_BACKUP_SUFFIX)).toBe(true);
    await codex.uninstallHooks();
    expect(read()).toEqual({ hooks: { Stop: [theirs] } });
    expect(codex.areHooksInstalled()).toBe(false);
  });

  it('never rewrites an unparseable hooks.json', async () => {
    fs.mkdirSync(path.join(tmpBase, '.codex'));
    fs.writeFileSync(hooksPath(), '{ not json');
    await expect(codex.installHooks()).rejects.toThrow(/Couldn't parse ~\/\.codex\/hooks\.json/);
    expect(fs.readFileSync(hooksPath(), 'utf-8')).toBe('{ not json');
  });

  it('refuses a non-array event it would install into', async () => {
    fs.mkdirSync(path.join(tmpBase, '.codex'));
    fs.writeFileSync(hooksPath(), JSON.stringify({ hooks: { Stop: 'mine' } }));
    await expect(codex.installHooks()).rejects.toThrow(/hooks\.Stop .* not an array/);
  });

  it('honors $CODEX_HOME', async () => {
    const alt = path.join(tmpBase, 'alt-codex');
    process.env['CODEX_HOME'] = alt;
    await codex.installHooks();
    expect(fs.existsSync(path.join(alt, 'hooks.json'))).toBe(true);
    expect(fs.existsSync(hooksPath())).toBe(false);
  });

  it('does not claim a lookalike command as ours', async () => {
    fs.mkdirSync(path.join(tmpBase, '.codex'));
    const lookalike = {
      matcher: '',
      hooks: [{ type: 'command', command: 'node /opt/evil.pixel-agents/hooks/codex-hook.js' }],
    };
    fs.writeFileSync(hooksPath(), JSON.stringify({ hooks: { Stop: [lookalike] } }));
    expect(codex.areHooksInstalled()).toBe(false);
    await codex.uninstallHooks();
    expect(read().hooks.Stop).toEqual([lookalike]);
  });
});

describe('geminiHookInstaller', () => {
  const settingsPath = () => path.join(tmpBase, '.gemini', 'settings.json');
  const read = () =>
    JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as { hooks?: Hooks; [k: string]: unknown };

  it('merges into settings.json, keeping every other setting, with ms timeouts and a name', async () => {
    fs.mkdirSync(path.join(tmpBase, '.gemini'));
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ theme: 'Dracula', general: { vimMode: true } }, null, 2),
    );
    fs.chmodSync(settingsPath(), 0o600);
    await gemini.installHooks();
    const settings = read();
    expect(settings.theme).toBe('Dracula');
    expect(settings.general).toEqual({ vimMode: true });
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual([...GEMINI_HOOK_EVENTS].sort());
    expect(settings.hooks?.BeforeTool[0].hooks[0]).toEqual({
      type: 'command',
      name: 'pixel-agents',
      command: `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'gemini-hook.js')}"`,
      timeout: 5000,
    });
    expect(fs.statSync(settingsPath()).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(settingsPath() + SETTINGS_BACKUP_SUFFIX)).toBe(true);
    expect(gemini.areHooksInstalled()).toBe(true);

    await gemini.uninstallHooks();
    expect(read()).toEqual({ theme: 'Dracula', general: { vimMode: true } });
  });

  it('refuses a settings.json with comments (JSONC) instead of rewriting it', async () => {
    fs.mkdirSync(path.join(tmpBase, '.gemini'));
    const jsonc = '{\n  // my theme\n  "theme": "Dracula"\n}\n';
    fs.writeFileSync(settingsPath(), jsonc);
    await expect(gemini.installHooks()).rejects.toThrow(/hooks not installed/);
    expect(fs.readFileSync(settingsPath(), 'utf-8')).toBe(jsonc);
  });

  it('refuses a hooks value that is not an object', async () => {
    fs.mkdirSync(path.join(tmpBase, '.gemini'));
    fs.writeFileSync(settingsPath(), JSON.stringify({ hooks: [] }));
    await expect(gemini.installHooks()).rejects.toThrow(/hooks in ~\/\.gemini\/settings\.json/);
  });
});
