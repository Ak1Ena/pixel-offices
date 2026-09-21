import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cwdFromRecord, seedAgentCwd } from '../src/agentCwd.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { clearFolderRootCache, resolveFolderRoot, sameRoot } from '../src/gitRoot.js';
import type { AgentState } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-root-')));
  clearFolderRootCache();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('resolveFolderRoot', () => {
  it('resolves a sub-folder to its project root, branch and sub-path', async () => {
    const sub = path.join(dir, 'server', 'src');
    fs.mkdirSync(sub, { recursive: true });
    const git = async (_cwd: string, args: string[]) =>
      args.includes('--show-toplevel') ? dir : 'feat/x';
    expect(await resolveFolderRoot(sub, git)).toEqual({
      root: dir,
      name: path.basename(dir),
      isGit: true,
      branch: 'feat/x',
      subPath: 'server/src',
    });
  });

  it('a folder outside git is its own root; a missing folder is null; a detached HEAD has no branch', async () => {
    const noGit = async () => null;
    expect(await resolveFolderRoot(dir, noGit)).toEqual({
      root: dir,
      name: path.basename(dir),
      isGit: false,
    });
    expect(await resolveFolderRoot(path.join(dir, 'nope'), noGit)).toBeNull();
    clearFolderRootCache();
    const detached = async (_c: string, a: string[]) =>
      a.includes('--show-toplevel') ? dir : 'HEAD';
    expect((await resolveFolderRoot(dir, detached))?.branch).toBeUndefined();
  });

  it('caches briefly', async () => {
    let calls = 0;
    const git = async () => (calls++, null);
    let now = 1000;
    await resolveFolderRoot(dir, git, () => now);
    await resolveFolderRoot(dir, git, () => now);
    expect(calls).toBe(1);
    now += 60_000;
    await resolveFolderRoot(dir, git, () => now);
    expect(calls).toBe(2);
  });

  it('sameRoot ignores trailing separators and never matches an unknown root', () => {
    expect(sameRoot('/a/b/', '/a/b')).toBe(true);
    expect(sameRoot('/a/b', '/a/bc')).toBe(false);
    expect(sameRoot(undefined, '/a')).toBe(false);
  });
});

describe('agent cwd', () => {
  it('reads cwd from a record, and seeds it from the newest transcript record', () => {
    expect(cwdFromRecord({ cwd: '/x' })).toBe('/x');
    expect(cwdFromRecord({ cwd: 5 })).toBeUndefined();
    expect(cwdFromRecord(null)).toBeUndefined();

    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(
      file,
      [{ type: 'user', cwd: '/old' }, { type: 'summary' }, { type: 'assistant', cwd: '/new' }]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    const store = new AgentStateStore();
    store.set(1, { id: 1, jsonlFile: file } as unknown as AgentState);
    seedAgentCwd(1, store);
    expect(store.get(1)?.cwd).toBe('/new');
  });
});
