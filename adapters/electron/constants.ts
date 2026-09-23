/** Electron-shell-only constants. */

/** How long the CLI gets to print its office URL before the shell gives up. */
export const ELECTRON_SERVER_START_TIMEOUT_MS = 30_000;
/** How long the CLI gets to shut down cleanly on quit before it is killed. */
export const ELECTRON_CHILD_STOP_TIMEOUT_MS = 5_000;

export const ELECTRON_WINDOW_WIDTH = 1400;
export const ELECTRON_WINDOW_HEIGHT = 900;

/** The CLI's startup line (server/src/cli.ts keeps its wording for tests; so does this). */
export const OFFICE_URL_PATTERN = /Pixel Agents server running at (http\S+)/;

/** Remembers "Skip this version", in Electron's userData folder. */
export const ELECTRON_UPDATE_PREFS_FILE = 'update-prefs.json';
