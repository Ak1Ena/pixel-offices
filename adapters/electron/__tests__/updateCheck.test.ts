import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  evaluateLatestRelease,
  type GithubRelease,
  parseVersionTag,
} from '../updateCheck.js';

describe('parseVersionTag', () => {
  it('parses a v-prefixed tag', () => {
    expect(parseVersionTag('v2.4.0')).toBe('2.4.0');
  });

  it('parses a bare version tag', () => {
    expect(parseVersionTag('2.4.0')).toBe('2.4.0');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseVersionTag('  v2.4.0  ')).toBe('2.4.0');
  });

  it('rejects a pre-release tag', () => {
    expect(parseVersionTag('v2.4.0-beta.1')).toBeUndefined();
  });

  it('rejects a non-version tag', () => {
    expect(parseVersionTag('latest')).toBeUndefined();
    expect(parseVersionTag('vNext')).toBeUndefined();
  });

  it('rejects a partial version', () => {
    expect(parseVersionTag('v2.4')).toBeUndefined();
  });
});

describe('compareVersions', () => {
  it('returns 1 when candidate is newer (patch)', () => {
    expect(compareVersions('2.3.2', '2.3.1')).toBe(1);
  });

  it('returns 1 when candidate is newer (minor)', () => {
    expect(compareVersions('2.4.0', '2.3.9')).toBe(1);
  });

  it('returns 1 when candidate is newer (major)', () => {
    expect(compareVersions('3.0.0', '2.9.9')).toBe(1);
  });

  it('returns -1 when candidate is older', () => {
    expect(compareVersions('2.3.0', '2.3.1')).toBe(-1);
  });

  it('returns 0 when equal', () => {
    expect(compareVersions('2.3.1', '2.3.1')).toBe(0);
  });
});

function release(overrides: Partial<GithubRelease> = {}): GithubRelease {
  return {
    tag_name: 'v2.4.0',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/pixel-agents-hq/pixel-agents/releases/tag/v2.4.0',
    ...overrides,
  };
}

describe('evaluateLatestRelease', () => {
  it('reports an available update for a newer release', () => {
    const result = evaluateLatestRelease(release(), '2.3.1');
    expect(result).toEqual({
      updateAvailable: true,
      version: '2.4.0',
      url: 'https://github.com/pixel-agents-hq/pixel-agents/releases/tag/v2.4.0',
    });
  });

  it('returns undefined when there is no release', () => {
    expect(evaluateLatestRelease(undefined, '2.3.1')).toBeUndefined();
  });

  it('returns undefined for a draft release', () => {
    expect(evaluateLatestRelease(release({ draft: true }), '2.3.1')).toBeUndefined();
  });

  it('returns undefined for a pre-release', () => {
    expect(evaluateLatestRelease(release({ prerelease: true }), '2.3.1')).toBeUndefined();
  });

  it('returns undefined when the tag does not parse', () => {
    expect(evaluateLatestRelease(release({ tag_name: 'latest' }), '2.3.1')).toBeUndefined();
  });

  it('returns undefined when the release is not newer than the current version', () => {
    expect(evaluateLatestRelease(release({ tag_name: 'v2.3.1' }), '2.3.1')).toBeUndefined();
  });

  it('returns undefined when the release is older than the current version', () => {
    expect(evaluateLatestRelease(release({ tag_name: 'v2.0.0' }), '2.3.1')).toBeUndefined();
  });
});
