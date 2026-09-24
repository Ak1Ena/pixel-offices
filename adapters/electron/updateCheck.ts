/**
 * macOS update check. Windows/Linux use `electron-updater` (see
 * `updater.ts`) because Squirrel.Mac -- the mechanism electron-updater uses
 * on macOS -- requires a signed app, and ours is ad-hoc only. Instead this
 * just asks GitHub what the latest release is, compares it to the running
 * version, and hands back enough to render a banner; it never downloads or
 * replaces anything.
 *
 * The decision logic (`parseVersionTag`, `compareVersions`,
 * `evaluateLatestRelease`) is pure and electron-free, unit-tested directly.
 * `fetchLatestRelease` is the one impure bit (a real HTTPS call) and is
 * injected into callers the same way `widenPath.ts`'s
 * `readLoginShellPath` is.
 */

const RELEASES_LATEST_URL = 'https://api.github.com/repos/Ak1Ena/pixel-offices/releases/latest';
const FETCH_TIMEOUT_MS = 5_000;

export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
}

export interface UpdateAvailable {
  updateAvailable: true;
  version: string;
  url: string;
}

/** `v2.4.0` / `2.4.0` -> `2.4.0`. Rejects anything that isn't a plain
 *  MAJOR.MINOR.PATCH -- pre-release/build-metadata tags are handled
 *  upstream by `release.prerelease`/`release.draft` already, so a tag that
 *  still doesn't match here (a typo, a non-version tag) is just ignored
 *  rather than guessed at. */
export function parseVersionTag(tag: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

/** True if `candidate` (MAJOR.MINOR.PATCH) is newer than `current`. Both
 *  must already be in that shape -- callers pass `parseVersionTag`'s output
 *  and `app.getVersion()` (this project's version is always plain
 *  MAJOR.MINOR.PATCH; a fuller semver comparator isn't needed here). */
export function compareVersions(candidate: string, current: string): number {
  const c = candidate.split('.').map(Number);
  const k = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (c[i] ?? 0) - (k[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Decides whether `release` represents an update over `currentVersion`.
 * Ignores drafts and pre-releases (only ever look at what GitHub itself
 * calls "latest", but double-check anyway -- `/releases/latest` already
 * excludes both, this is a second line of defense against a malformed or
 * mocked response). Returns undefined for "nothing to show": no release,
 * an unparseable tag, or a version that isn't actually newer.
 */
export function evaluateLatestRelease(
  release: GithubRelease | undefined,
  currentVersion: string,
): UpdateAvailable | undefined {
  if (!release || release.draft || release.prerelease) return undefined;
  const version = parseVersionTag(release.tag_name);
  if (!version) return undefined;
  if (compareVersions(version, currentVersion) <= 0) return undefined;
  return { updateAvailable: true, version, url: release.html_url };
}

/**
 * Real GitHub API call. Never throws: a timeout, an offline machine, a
 * rate-limited response (403/429), or a malformed body all just resolve to
 * undefined -- an update check must never be able to interrupt startup or
 * put an error dialog in front of the user.
 */
export async function fetchLatestRelease(
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<GithubRelease | undefined> {
  try {
    const res = await fetch(RELEASES_LATEST_URL, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<GithubRelease> | null;
    if (
      !body ||
      typeof body.tag_name !== 'string' ||
      typeof body.html_url !== 'string' ||
      typeof body.draft !== 'boolean' ||
      typeof body.prerelease !== 'boolean'
    ) {
      return undefined;
    }
    return body as GithubRelease;
  } catch {
    return undefined;
  }
}
