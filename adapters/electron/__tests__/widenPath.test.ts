import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureUsablePath, findOnPath, mergePath } from '../widenPath.js';

let tmpBase: string;
let binDir: string;

function makeExecutable(dir: string, name: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\necho hi\n');
  fs.chmodSync(file, 0o755);
}

describe('findOnPath', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-widenpath-test-'));
    binDir = path.join(tmpBase, 'bin');
    fs.mkdirSync(binDir);
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('finds an executable on the path', () => {
    makeExecutable(binDir, 'claude');
    expect(findOnPath('claude', binDir)).toBe(true);
  });

  it('does not find a binary that is not on any path entry', () => {
    expect(findOnPath('claude', binDir)).toBe(false);
  });

  it('does not treat a non-executable file as found', () => {
    const file = path.join(binDir, 'claude');
    fs.writeFileSync(file, 'not executable');
    fs.chmodSync(file, 0o644);
    expect(findOnPath('claude', binDir)).toBe(false);
  });

  it('checks every path entry, not just the first', () => {
    const otherDir = path.join(tmpBase, 'other');
    fs.mkdirSync(otherDir);
    makeExecutable(otherDir, 'git');
    const pathEnv = [binDir, otherDir].join(path.delimiter);
    expect(findOnPath('git', pathEnv)).toBe(true);
  });

  it('tolerates empty entries in PATH', () => {
    const pathEnv = ['', binDir, ''].join(path.delimiter);
    expect(findOnPath('claude', pathEnv)).toBe(false); // still not there, but must not throw
  });
});

describe('mergePath', () => {
  it('puts the login shell PATH entries first', () => {
    const merged = mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/local/bin');
    expect(merged.split(path.delimiter)).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]);
  });

  it('dedupes entries present in both, keeping the shell PATH copy', () => {
    const merged = mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin');
    expect(merged.split(path.delimiter)).toEqual(['/opt/homebrew/bin', '/usr/bin', '/bin']);
  });

  it('drops empty segments', () => {
    const merged = mergePath('/usr/bin::/bin', ':/opt/homebrew/bin:');
    expect(merged.split(path.delimiter)).toEqual(['/opt/homebrew/bin', '/usr/bin', '/bin']);
  });
});

describe('ensureUsablePath', () => {
  it('is a no-op (never calls the shell) when every required binary already resolves', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-widenpath-test-'));
    binDir = path.join(tmpBase, 'bin');
    fs.mkdirSync(binDir);
    makeExecutable(binDir, 'claude');

    const env: NodeJS.ProcessEnv = { PATH: binDir };
    const getLoginShellPath = vi.fn(() => '/should/not/be/used');
    const log = vi.fn();

    ensureUsablePath({ required: ['claude'], env, getLoginShellPath, log });

    expect(env.PATH).toBe(binDir);
    expect(getLoginShellPath).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('merges in the login shell PATH and logs once when a required binary is missing', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-widenpath-test-'));
    const minimalBin = path.join(tmpBase, 'minimal-bin'); // stands in for /usr/bin:/bin -- has neither
    const shellBin = path.join(tmpBase, 'shell-bin'); // stands in for the login shell's extra PATH
    fs.mkdirSync(minimalBin);
    fs.mkdirSync(shellBin);
    makeExecutable(shellBin, 'claude');
    makeExecutable(shellBin, 'git');

    const env: NodeJS.ProcessEnv = { PATH: minimalBin };
    const getLoginShellPath = vi.fn(() => shellBin);
    const log = vi.fn();

    ensureUsablePath({ required: ['claude', 'git'], env, getLoginShellPath, log });

    expect(env.PATH).toBe([shellBin, minimalBin].join(path.delimiter));
    expect(getLoginShellPath).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('claude, git');

    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('tolerates a login shell PATH read that fails, leaving PATH untouched', () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-widenpath-test-'));
    const minimalBin = path.join(tmpBase, 'minimal-bin');
    fs.mkdirSync(minimalBin);

    const env: NodeJS.ProcessEnv = { PATH: minimalBin };
    const getLoginShellPath = vi.fn(() => undefined);
    const log = vi.fn();

    ensureUsablePath({ required: ['claude'], env, getLoginShellPath, log });

    expect(env.PATH).toBe(minimalBin);
    expect(log).not.toHaveBeenCalled();

    fs.rmSync(tmpBase, { recursive: true, force: true });
  });
});
