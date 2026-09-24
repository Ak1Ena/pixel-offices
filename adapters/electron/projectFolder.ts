/**
 * Which project folder the Electron shell should watch for terminal-run
 * Claude sessions (the `projectDir` `startStandaloneOffice`/`attachOrStartOffice`
 * pass to `HookProvider.getSessionDirs`). Pure and electron-free so it is
 * unit-testable without a running app: `main.ts` supplies the real
 * `fs.existsSync` and `os.homedir()`.
 *
 * Unlike the CLI, a Dock/tray-launched GUI app has no meaningful cwd (it is
 * usually "/" or the user's home directory), so `process.cwd()` is only
 * trusted when it looks like an actual project folder.
 */

export interface ResolveProjectFolderInput {
  /** A folder passed on the command line (`electron . /path/to/project`), if any. */
  cliFolder?: string;
  /** The folder saved from a previous run/pick (`folder.json`), if any. */
  savedFolder?: string;
  cwd: string;
  homeDir: string;
  /** Injected so the function stays pure (no direct `fs` access). */
  exists: (candidate: string) => boolean;
}

export type ResolveProjectFolderResult = { folder: string } | { needsPick: true };

/** A folder is unusable as a project root if it's the filesystem root, the
 *  user's home directory (both signs of "no real folder was chosen"), or no
 *  longer exists on disk. */
function isUsableFolder(
  candidate: string | undefined,
  homeDir: string,
  exists: (candidate: string) => boolean,
): candidate is string {
  if (!candidate) return false;
  if (candidate === '/') return false;
  if (candidate === homeDir) return false;
  return exists(candidate);
}

/** Order: CLI argument, then the saved folder, then the process's own cwd
 *  (rejected when it's "/" or home -- a Dock launch), then a pick. */
export function resolveProjectFolder(input: ResolveProjectFolderInput): ResolveProjectFolderResult {
  const { cliFolder, savedFolder, cwd, homeDir, exists } = input;
  if (isUsableFolder(cliFolder, homeDir, exists)) return { folder: cliFolder };
  if (isUsableFolder(savedFolder, homeDir, exists)) return { folder: savedFolder };
  if (isUsableFolder(cwd, homeDir, exists)) return { folder: cwd };
  return { needsPick: true };
}
