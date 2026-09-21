/**
 * Constants shared by every provider's hook installer (hookSettingsInstaller.ts).
 * Provider-specific values (event lists, script names, settings paths) live in
 * each provider's own `constants.ts`.
 */

/** Suffix of the one-time pre-modification backup of a CLI's settings file.
 *  Brand-named rather than a generic `.backup`, which collides with other
 *  tools' backup convention: a foreign `.backup` sitting next to the file must
 *  not make us believe we already saved the user's original. */
export const SETTINGS_BACKUP_SUFFIX = '.pixel-agents.backup';

/** Suffix of the temp file used for the atomic tmp-write + rename. */
export const SETTINGS_TMP_SUFFIX = '.pixel-agents-tmp';

/** Mode for a settings file we create ourselves. An existing file's mode is
 *  preserved instead; this is only the fresh-file default, and it is the
 *  restrictive one because such files hold the user's permission rules. */
export const SETTINGS_FRESH_FILE_MODE = 0o600;

/** Attempts for the settings-file read-modify-write cycle. The CLI writes the
 *  same file and does not coordinate with us, so the cycle re-reads the file
 *  immediately before committing and retries when it changed. The verify sits
 *  after mkdir/backup/tmp-write, so the residual lost-update window is one read
 *  plus one rename — narrowed, NOT eliminated. A lockfile would not help (the
 *  CLI would not honor it, and stale locks add failure modes worse than the
 *  race). */
export const SETTINGS_MUTATE_ATTEMPTS = 3;
/** Delay between settings-file mutation attempts (lets a concurrent writer finish). */
export const SETTINGS_MUTATE_RETRY_DELAY_MS = 100;

/** Name every Pixel Agents hook entry carries where the CLI supports one
 *  (Gemini's `name`, used by its `/hooks` UI and `hooksConfig.disabled`). */
export const PIXEL_AGENTS_HOOK_NAME = 'pixel-agents';
