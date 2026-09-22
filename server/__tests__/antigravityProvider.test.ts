import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const installer = await import('../src/providers/hook/antigravity/antigravityHookInstaller.js');
const { antigravityProvider, formatToolStatus } =
  await import('../src/providers/hook/antigravity/antigravity.js');
const { SETTINGS_BACKUP_SUFFIX } = await import('../src/providers/hook/constants.js');
const { planAgyLaunch } = await import('../src/launcher.js');

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-agy-'));
});
afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const hooksPath = () => path.join(tmpBase, '.gemini', 'config', 'hooks.json');
const read = () => JSON.parse(fs.readFileSync(hooksPath(), 'utf-8')) as Record<string, unknown>;
const writeRaw = (text: string) => {
  fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
  fs.writeFileSync(hooksPath(), text);
};

describe('antigravity hook install', () => {
  it('writes one named spec, never PreToolUse (any reply there decides the prompt)', async () => {
    await installer.installHooks();
    const spec = read()['pixel-agents'] as Record<string, unknown>;
    expect(Object.keys(spec).sort()).toEqual(['PostToolUse', 'PreInvocation', 'Stop']);
    expect(spec.PostToolUse).toEqual([
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: `node "${path.join(tmpBase, '.pixel-agents', 'hooks', 'antigravity-hook.js')}" PostToolUse`,
            timeout: 5,
          },
        ],
      },
    ]);
    expect((spec.Stop as Array<{ command: string }>)[0].command).toMatch(
      /antigravity-hook\.js" Stop$/,
    );
    expect(installer.areHooksInstalled()).toBe(true);
  });

  it('keeps other hooks, backs the file up once, and uninstalls only its own key', async () => {
    writeRaw(
      JSON.stringify({ lint: { PostToolUse: [{ matcher: '*', hooks: [{ command: 'lint' }] }] } }),
    );
    await installer.installHooks();
    expect(Object.keys(read()).sort()).toEqual(['lint', 'pixel-agents']);
    expect(fs.existsSync(hooksPath() + SETTINGS_BACKUP_SUFFIX)).toBe(true);
    await installer.uninstallHooks();
    expect(Object.keys(read())).toEqual(['lint']);
    expect(installer.areHooksInstalled()).toBe(false);
  });

  it('refuses a file it cannot parse and a pixel-agents key it did not write', async () => {
    writeRaw('{ nope');
    await expect(installer.installHooks()).rejects.toThrow(/Couldn't parse/);
    expect(fs.readFileSync(hooksPath(), 'utf-8')).toBe('{ nope');
    writeRaw(JSON.stringify({ 'pixel-agents': { Stop: [{ command: 'someone-else.sh' }] } }));
    await expect(installer.installHooks()).rejects.toThrow(/did not write/);
    await installer.uninstallHooks();
    expect(read()['pixel-agents']).toBeDefined();
  });
});

describe('antigravity events', () => {
  const norm = (raw: Record<string, unknown>) => antigravityProvider.normalizeHookEvent(raw);

  it('shows a tool from PostToolUse until the next model call, and ends the turn on Stop', () => {
    expect(norm({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo' })).toEqual({
      sessionId: 's1',
      event: { kind: 'sessionStart', cwd: '/repo' },
    });
    expect(norm({ hook_event_name: 'PreInvocation', session_id: 's1' })).toBeNull();
    const post = {
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    };
    const started = norm(post);
    expect(started?.event).toMatchObject({ kind: 'toolStart', toolName: 'run_command' });
    // Re-normalizing the same payload must not open a second tool.
    expect(norm(post)).toBe(started);
    const toolId = (started?.event as { toolId: string }).toolId;
    expect(norm({ hook_event_name: 'PreInvocation', session_id: 's1' })?.event).toEqual({
      kind: 'toolEnd',
      toolId,
    });
    expect(norm({ hook_event_name: 'Stop', session_id: 's1' })?.event).toEqual({ kind: 'turnEnd' });
  });

  it('says what the tool does', () => {
    expect(formatToolStatus('run_command', { CommandLine: 'npm test' })).toBe('Running: npm test');
    expect(formatToolStatus('view_file', { AbsolutePath: '/a/b/note.txt' })).toBe(
      'Reading note.txt',
    );
    expect(formatToolStatus('manage_task', { toolAction: 'Checking search task' })).toBe(
      'Checking search task',
    );
  });
});

describe('starting agy from the office', () => {
  const id = () => 'x1';
  it('follows an interactive agy run, direct or wrapped, under a key the office picks', () => {
    expect(planAgyLaunch('agy', ['-i', 'hi'], id)).toEqual({
      program: 'agy',
      args: ['-i', 'hi'],
      key: 'agy-x1',
    });
    expect(planAgyLaunch('caffeinate', ['-i', 'agy'], id)?.key).toBe('agy-x1');
    expect(planAgyLaunch('C:\\tools\\agy.exe', [], id)?.key).toBe('agy-x1');
  });

  it('leaves print mode and other programs alone', () => {
    expect(planAgyLaunch('agy', ['-p', 'hi'], id)).toBeNull();
    expect(planAgyLaunch('agy', ['--print', 'hi'], id)).toBeNull();
    expect(planAgyLaunch('claude', [], id)).toBeNull();
  });
});
