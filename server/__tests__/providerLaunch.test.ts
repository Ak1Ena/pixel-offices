import { describe, expect, it } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import { antigravityProvider } from '../src/providers/hook/antigravity/antigravity.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { launcherFor } from '../src/providers/index.js';

/**
 * ProviderLaunch: how `pixel-office <program>` / +Agent picks and plans a
 * CLI. The registry loop (launcherFor) is the only caller of `claims` — a new
 * CLI is a provider entry here, never an if-branch (see item 5 below).
 */

describe('claudeProvider.launch', () => {
  it('claims claude, and a wrapped caffeinate -i claude', () => {
    expect(claudeProvider.launch?.claims('claude', [])).toBe(true);
    expect(claudeProvider.launch?.claims('/usr/local/bin/claude', [])).toBe(true);
    expect(claudeProvider.launch?.claims('caffeinate', ['-i', 'claude'])).toBe(true);
    expect(claudeProvider.launch?.claims('codex', [])).toBe(false);
  });

  it('plan() mints --session-id <uuid> and returns it as sessionKey', () => {
    const plan = claudeProvider.launch?.plan('claude', [], { newId: () => 'minted-id' });
    expect(plan).toEqual({
      program: 'claude',
      args: ['--session-id', 'minted-id'],
      sessionKey: 'minted-id',
      interactive: true,
    });
  });

  it('appends the firstMessage as a positional arg', () => {
    const plan = claudeProvider.launch?.plan('claude', [], {
      firstMessage: 'hello there',
      newId: () => 'minted-id',
    });
    expect(plan?.args).toEqual(['--session-id', 'minted-id', 'hello there']);
  });

  it('appends --resume <id> when resume is given', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const plan = claudeProvider.launch?.plan('claude', [], { resume: id });
    expect(plan).toEqual({
      program: 'claude',
      args: ['--resume', id],
      sessionKey: id,
      interactive: true,
    });
  });

  it('returns null for a non-UUID resume id', () => {
    expect(claudeProvider.launch?.plan('claude', [], { resume: 'not-a-uuid' })).toBeNull();
  });

  it('returns null for print mode (-p)', () => {
    expect(claudeProvider.launch?.plan('claude', ['-p', 'hi'], {})).toBeNull();
  });

  it('can resume, and is adopted by transcript', () => {
    expect(claudeProvider.launch?.canResume).toBe(true);
    expect(claudeProvider.launch?.adoption).toBe('transcript');
  });
});

describe('antigravityProvider.launch', () => {
  it('claims agy', () => {
    expect(antigravityProvider.launch?.claims('agy', [])).toBe(true);
    expect(antigravityProvider.launch?.claims('caffeinate', ['-i', 'agy'])).toBe(true);
    expect(antigravityProvider.launch?.claims('claude', [])).toBe(false);
  });

  it('plan() passes the firstMessage as -i <msg>', () => {
    const plan = antigravityProvider.launch?.plan('agy', [], {
      firstMessage: 'hi there',
      newId: () => 'x1',
    });
    expect(plan).toEqual({
      program: 'agy',
      args: ['-i', 'hi there'],
      sessionKey: 'agy-x1',
      interactive: true,
    });
  });

  it('cannot resume, and is adopted by pid', () => {
    expect(antigravityProvider.launch?.canResume).toBe(false);
    expect(antigravityProvider.launch?.adoption).toBe('pid');
  });
});

describe('launcherFor', () => {
  const providers = [claudeProvider, antigravityProvider];

  it('a command no provider claims finds no launcher', () => {
    expect(launcherFor(providers, 'ls', ['-la'])).toBeUndefined();
  });

  it('picks the provider that claims the command', () => {
    expect(launcherFor(providers, 'claude', [])?.id).toBe('claude');
    expect(launcherFor(providers, 'agy', [])?.id).toBe('antigravity');
  });

  it('a fake provider with its own launch is claimed and planned by the same generic loop', () => {
    const fakeProvider: HookProvider = {
      kind: 'hook',
      id: 'fake',
      displayName: 'Fake CLI',
      protocolVersion: 1,
      normalizeHookEvent: () => null,
      installHooks: async () => {},
      uninstallHooks: async () => {},
      areHooksInstalled: async () => false,
      consentDisclosure: () => ({ headline: 'Fake', disclosure: 'Fake.' }),
      formatToolStatus: () => '',
      permissionExemptTools: new Set(),
      subagentToolNames: new Set(),
      readingTools: new Set(),
      launch: {
        claims: (program) => program === 'fake-cli',
        plan: (program, args) => ({ program, args, sessionKey: 'fake-session', interactive: true }),
        canResume: false,
        adoption: 'pid',
      },
    };

    const found = launcherFor([...providers, fakeProvider], 'fake-cli', ['--flag']);
    expect(found?.id).toBe('fake');
    expect(found?.launch.plan('fake-cli', ['--flag'], {})).toEqual({
      program: 'fake-cli',
      args: ['--flag'],
      sessionKey: 'fake-session',
      interactive: true,
    });
    // Not claimed by the real providers, and not registered globally.
    expect(launcherFor(providers, 'fake-cli', [])).toBeUndefined();
  });
});
