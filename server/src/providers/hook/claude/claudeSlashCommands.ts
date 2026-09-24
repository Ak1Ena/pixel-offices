import { spawn } from 'child_process';

import {
  HOOK_PROBE_ENV,
  SLASH_COMMANDS_MAX,
  SLASH_COMMANDS_TIMEOUT_MS,
} from '../../../constants.js';

/**
 * Claude's slash commands in `cwd`, as Claude reports them: a headless run's
 * first `system/init` message lists `slash_commands` (built-ins, skills,
 * plugin and project commands). The run is killed as soon as that message
 * arrives — before any model request — keeps no transcript
 * (`--no-session-persistence`), and our own hook stays silent for it
 * (HOOK_PROBE_ENV), so it never shows up as an agent.
 */
export function listClaudeSlashCommands(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
      { cwd, env: { ...process.env, [HOOK_PROBE_ENV]: '1' }, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let buffer = '';
    let settled = false;
    const finish = (result: string[] | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error('Claude did not report its commands in time.')),
      SLASH_COMMANDS_TIMEOUT_MS,
    );
    child.on('error', (err) => finish(new Error(`Could not run claude: ${err.message}`)));
    child.on('close', () => finish(new Error('Claude exited before reporting its commands.')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let record: { type?: unknown; subtype?: unknown; slash_commands?: unknown };
        try {
          record = JSON.parse(line) as typeof record;
        } catch {
          continue;
        }
        if (record.type !== 'system' || record.subtype !== 'init') continue;
        const names = Array.isArray(record.slash_commands) ? record.slash_commands : [];
        finish(
          [
            ...new Set(
              names.filter(
                (n): n is string =>
                  typeof n === 'string' &&
                  /^[\w:.-]{1,80}$/.test(n) &&
                  // Internal commands the CLI lists but a person never types.
                  !n.startsWith('__'),
              ),
            ),
          ].slice(0, SLASH_COMMANDS_MAX),
        );
        return;
      }
    });
    // Headless mode reads the prompt from stdin; it is never sent (killed at init).
    child.stdin.end('.');
  });
}
