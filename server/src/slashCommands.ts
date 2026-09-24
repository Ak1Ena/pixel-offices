import type { HookProvider } from '../../core/src/provider.js';
import { SLASH_COMMANDS_CACHE_MS } from './constants.js';

/**
 * The slash commands an agent's CLI accepts, for the chat's `/` menu. The
 * provider asks its own CLI (Claude: a headless run's init message), so the
 * office keeps no list of its own. Cached per provider + folder: project
 * commands differ by folder, and asking costs a CLI start-up.
 */
export class SlashCommands {
  private readonly cache = new Map<string, { at: number; commands: string[] }>();
  private readonly inflight = new Map<string, Promise<string[]>>();

  async list(provider: HookProvider | undefined, cwd: string | undefined): Promise<string[]> {
    if (!provider?.listSlashCommands) {
      throw new Error('The office cannot list this CLI’s commands.');
    }
    if (!cwd) throw new Error('The agent’s folder is not known yet.');
    const key = `${provider.id}\n${cwd}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < SLASH_COMMANDS_CACHE_MS) return cached.commands;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = provider.listSlashCommands(cwd).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const commands = await pending;
    this.cache.set(key, { at: Date.now(), commands });
    return commands;
  }
}
