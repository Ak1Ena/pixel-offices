import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { GIT_ROOT_CACHE_MS, GIT_ROOT_TIMEOUT_MS } from './constants.js';

/**
 * Where a folder's work belongs: the git top-level folder and current branch,
 * or the folder itself outside a git project. This is what the task desk
 * matches cards and agents on, so an agent sitting in `repo/server` takes a
 * `repo` card, and a worktree (its own top-level) counts as its own folder.
 */
export interface FolderRoot {
  /** Real path of the git top-level folder, or of the folder itself. */
  root: string;
  name: string;
  isGit: boolean;
  branch?: string;
  /** `folder` relative to `root`, when it is inside it. */
  subPath?: string;
}

type GitRunner = (cwd: string, args: string[]) => Promise<string | null>;

const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_ROOT_TIMEOUT_MS, windowsHide: true }, (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    );
  });

const cache = new Map<string, { at: number; value: FolderRoot | null }>();

/** Compare two roots the way the filesystem would on macOS and Windows. */
export function sameRoot(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  const [x, y] = [norm(a), norm(b)];
  if (x === y) return true;
  return process.platform !== 'linux' && x.toLowerCase() === y.toLowerCase();
}

/**
 * Resolve `folder`. Null when it isn't a readable directory. Cached briefly:
 * the desk asks for every agent on every tick, and a branch switch should
 * still show up within a few seconds.
 */
export async function resolveFolderRoot(
  folder: string,
  git: GitRunner = runGit,
  now: () => number = Date.now,
): Promise<FolderRoot | null> {
  const hit = cache.get(folder);
  if (hit && now() - hit.at < GIT_ROOT_CACHE_MS) return hit.value;

  let value: FolderRoot | null = null;
  try {
    const real = fs.realpathSync(folder);
    if (fs.statSync(real).isDirectory()) {
      const top = await git(real, ['rev-parse', '--show-toplevel']);
      if (top) {
        const root = fs.realpathSync(top);
        const branch = await git(real, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const sub = path.relative(root, real);
        value = {
          root,
          name: path.basename(root),
          isGit: true,
          ...(branch && branch !== 'HEAD' ? { branch } : {}),
          ...(sub && !sub.startsWith('..') ? { subPath: sub.split(path.sep).join('/') } : {}),
        };
      } else {
        value = { root: real, name: path.basename(real) || real, isGit: false };
      }
    }
  } catch {
    value = null;
  }
  cache.set(folder, { at: now(), value });
  return value;
}

/** Test seam. */
export function clearFolderRootCache(): void {
  cache.clear();
}
