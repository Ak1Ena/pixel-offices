import * as fs from 'fs';

import type { ChatEntry } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { applyChatDelta } from './chatLog.js';
import { CHAT_SEED_TAIL_BYTES, HOOK_CHAT_POLL_MS } from './constants.js';

interface Watch {
  file: string;
  offset: number;
  buffer: string;
  read: (line: string) => { entries: ChatEntry[]; doneToolIds: string[] };
  timer: ReturnType<typeof setInterval>;
}

/**
 * Chat for hooks-only agents whose CLI keeps its own transcript
 * (HookProvider.chatTranscript — agy today). The first event that names the
 * file starts a watch for that agent: the tail written so far is seeded as
 * history (never relayed), then new lines are polled and folded in live.
 * One watch per agent; a new file (a new conversation) replaces it.
 */
export class HookChatWatch {
  private readonly watches = new Map<number, Watch>();

  constructor(private readonly store: AgentStateStore) {
    store.on('agentRemoved', this.onAgentRemoved);
  }

  /** Called for every hook event of an agent the event resolved to. */
  observe(agentId: number, provider: HookProvider, event: Record<string, unknown>): void {
    const spec = provider.chatTranscript;
    if (!spec) return;
    const file = spec.pathFromEvent(event);
    if (!file) return;
    const current = this.watches.get(agentId);
    if (current?.file === file) {
      this.poll(agentId); // an event means the file likely moved: read now
      return;
    }
    if (current) this.stop(agentId);
    const watch: Watch = {
      file,
      offset: 0,
      buffer: '',
      read: spec.createReader(),
      timer: setInterval(() => this.poll(agentId), HOOK_CHAT_POLL_MS),
    };
    watch.timer.unref?.();
    this.watches.set(agentId, watch);
    this.seed(agentId, watch);
  }

  dispose(): void {
    this.store.off('agentRemoved', this.onAgentRemoved);
    for (const id of [...this.watches.keys()]) this.stop(id);
  }

  private seed(agentId: number, watch: Watch): void {
    let size: number;
    try {
      size = fs.statSync(watch.file).size;
    } catch {
      return; // not written yet: the poll picks it up
    }
    watch.offset = Math.max(0, size - CHAT_SEED_TAIL_BYTES);
    const skipPartial = watch.offset > 0;
    this.readNew(agentId, watch, false, skipPartial);
  }

  private poll(agentId: number): void {
    const watch = this.watches.get(agentId);
    if (watch) this.readNew(agentId, watch, true, false);
  }

  private readNew(agentId: number, watch: Watch, live: boolean, skipPartial: boolean): void {
    const agent = this.store.get(agentId);
    if (!agent) return;
    let text: string;
    try {
      const size = fs.statSync(watch.file).size;
      if (size < watch.offset) {
        watch.offset = 0; // rewritten from scratch
        watch.buffer = '';
      }
      if (size === watch.offset) return;
      const fd = fs.openSync(watch.file, 'r');
      try {
        const buf = Buffer.alloc(size - watch.offset);
        fs.readSync(fd, buf, 0, buf.length, watch.offset);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      watch.offset = size;
    } catch {
      return;
    }
    const lines = (watch.buffer + text).split('\n');
    watch.buffer = lines.pop() ?? '';
    if (skipPartial) lines.shift();
    for (const line of lines) {
      if (!line.trim()) continue;
      const delta = watch.read(line);
      if (delta.entries.length === 0 && delta.doneToolIds.length === 0) continue;
      applyChatDelta(agentId, agent, this.store, delta, live);
    }
  }

  private stop(agentId: number): void {
    const watch = this.watches.get(agentId);
    if (!watch) return;
    clearInterval(watch.timer);
    this.watches.delete(agentId);
  }

  private readonly onAgentRemoved = (agentId: number): void => this.stop(agentId);
}
