import { describe, expect, it } from 'vitest';

import { resolveProjectFolder } from '../projectFolder.js';

const HOME = '/Users/dock-launch';

function exists(known: string[]): (candidate: string) => boolean {
  return (candidate) => known.includes(candidate);
}

describe('resolveProjectFolder', () => {
  it('CLI argument wins over everything else', () => {
    const result = resolveProjectFolder({
      cliFolder: '/repo/cli',
      savedFolder: '/repo/saved',
      cwd: '/repo/cwd',
      homeDir: HOME,
      exists: exists(['/repo/cli', '/repo/saved', '/repo/cwd']),
    });
    expect(result).toEqual({ folder: '/repo/cli' });
  });

  it('saved folder wins when there is no CLI argument', () => {
    const result = resolveProjectFolder({
      savedFolder: '/repo/saved',
      cwd: '/repo/cwd',
      homeDir: HOME,
      exists: exists(['/repo/saved', '/repo/cwd']),
    });
    expect(result).toEqual({ folder: '/repo/saved' });
  });

  it('an invalid CLI argument falls through to the saved folder', () => {
    const result = resolveProjectFolder({
      cliFolder: '/does/not/exist',
      savedFolder: '/repo/saved',
      cwd: '/repo/cwd',
      homeDir: HOME,
      exists: exists(['/repo/saved', '/repo/cwd']),
    });
    expect(result).toEqual({ folder: '/repo/saved' });
  });

  it('a missing saved folder falls through to a usable cwd', () => {
    const result = resolveProjectFolder({
      savedFolder: '/gone',
      cwd: '/repo/cwd',
      homeDir: HOME,
      exists: exists(['/repo/cwd']),
    });
    expect(result).toEqual({ folder: '/repo/cwd' });
  });

  it('needs a pick when nothing is usable (Dock launch, cwd is home)', () => {
    const result = resolveProjectFolder({
      cwd: HOME,
      homeDir: HOME,
      exists: exists([HOME]),
    });
    expect(result).toEqual({ needsPick: true });
  });

  it('needs a pick when cwd is the filesystem root', () => {
    const result = resolveProjectFolder({
      cwd: '/',
      homeDir: HOME,
      exists: exists(['/']),
    });
    expect(result).toEqual({ needsPick: true });
  });

  it('rejects "/" and the home folder even when explicitly passed as saved', () => {
    const rootResult = resolveProjectFolder({
      savedFolder: '/',
      cwd: '/',
      homeDir: HOME,
      exists: exists(['/']),
    });
    expect(rootResult).toEqual({ needsPick: true });

    const homeResult = resolveProjectFolder({
      savedFolder: HOME,
      cwd: HOME,
      homeDir: HOME,
      exists: exists([HOME]),
    });
    expect(homeResult).toEqual({ needsPick: true });
  });

  it('rejects a saved folder that no longer exists on disk', () => {
    const result = resolveProjectFolder({
      savedFolder: '/repo/deleted',
      cwd: HOME,
      homeDir: HOME,
      exists: exists([HOME]),
    });
    expect(result).toEqual({ needsPick: true });
  });
});
