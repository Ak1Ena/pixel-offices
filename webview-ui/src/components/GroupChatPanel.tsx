import { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatEntry } from '../../../core/src/messages.js';
import { GROUP_CHAT_WIDTH_PX } from '../constants.js';
import { canSendChatFiles, dragHasFiles, pastedFiles, withFileMentions } from '../fileUpload.js';
import { useFileAttachments } from '../hooks/useFileAttachments.js';
import type { ChatChannel } from '../officeChat.js';
import {
  addressedMembers,
  completeMention,
  defaultRecipients,
  formatTokens,
  groupNote,
  mentionHandle,
  mentionQuery,
  mergeTimeline,
  teamUsage,
} from '../officeChat.js';
import { AttachFileButton, FileChips, MessageText } from './FileAttachments.js';
import { Button } from './ui/Button.js';

interface GroupChatPanelProps {
  channels: ChatChannel[];
  chats: Record<number, ChatEntry[]>;
  labelOf: (agentId: number) => string;
  /** Per-agent token use, for the channel's total. */
  usage?: Record<number, { totalTokens: number; burnPerMinute: number } | undefined>;
  sendable: Record<number, boolean>;
  relayEnabled: boolean;
  /** Absent when this connection may not change it. */
  onSetRelay?: (enabled: boolean) => void;
  onSend: (agentId: number, text: string) => void;
  onPin: (text: string, scope: number[]) => void;
  onOpenAgent: (agentId: number) => void;
  onClose: () => void;
  /** Channel to open on (the Messenger's room list opens a room directly). */
  initialChannelId?: string;
}

/** Agents already told about the team chat and the shared docs this session. */
const introduced = new Set<number>();

/**
 * Group chat: `# everyone` and one channel per team. The conversation is the
 * members' own chats merged by time. A message goes to the members it
 * @mentions, else to the ticked ones — a team channel ticks only its lead.
 */
export function GroupChatPanel({
  channels,
  chats,
  labelOf,
  usage,
  sendable,
  relayEnabled,
  onSetRelay,
  onSend,
  onPin,
  onOpenAgent,
  onClose,
  initialChannelId,
}: GroupChatPanelProps) {
  const [channelId, setChannelId] = useState(initialChannelId ?? 'everyone');
  const [draft, setDraft] = useState('');
  /** Ticks the user changed in this channel; the rest follow `defaultRecipients`. */
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isFileDropTarget, setIsFileDropTarget] = useState(false);
  const attachments = useFileAttachments();
  const filesEnabled = canSendChatFiles();
  const threadRef = useRef<HTMLDivElement>(null);

  const channel = channels.find((c) => c.id === channelId) ?? channels[0];
  const timeline = useMemo(
    () => (channel ? mergeTimeline(chats, channel.members) : []),
    [chats, channel],
  );
  const last = timeline[timeline.length - 1];
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.length, last?.key, channelId]);

  if (!channel) return null;
  const reachable = channel.members.filter((id) => sendable[id]);
  const channelUse = usage ? teamUsage(channel.members, usage) : null;
  // `@Name` in the draft sends to just those agents, whatever is ticked.
  const addressed = addressedMembers(draft, reachable, labelOf);
  const defaults = defaultRecipients(channel, reachable);
  const isTicked = (id: number) => picked[id] ?? defaults.includes(id);
  const targets = addressed.length > 0 ? addressed : reachable.filter(isTicked);
  const query = mentionQuery(draft)?.toLowerCase();
  const suggestions =
    query === undefined
      ? []
      : channel.members.filter((id) => {
          const label = labelOf(id).toLowerCase();
          return label.startsWith(query) || mentionHandle(label).startsWith(query);
        });
  const pickMention = (id: number) => {
    setDraft((d) => completeMention(d, labelOf(id)));
    inputRef.current?.focus();
  };

  const hasContent = draft.trim().length > 0 || attachments.files.length > 0;
  const canSubmit = hasContent && targets.length > 0 && !attachments.uploading;
  const send = async () => {
    if (!canSubmit) return;
    const typed = draft;
    // Uploaded once; every ticked member gets the same paths.
    const paths = await attachments.upload();
    if (!paths) return; // error shown; draft and files kept
    const text = withFileMentions(paths, typed.trim());
    for (const id of targets) {
      let message = text;
      if (!introduced.has(id)) {
        introduced.add(id);
        const teammates = channel.members.filter((m) => m !== id).map(labelOf);
        message += groupNote(teammates, relayEnabled);
      }
      onSend(id, message);
    }
    setDraft((current) => (current === typed ? '' : current));
  };
  const acceptsFiles = (e: React.DragEvent) =>
    filesEnabled && reachable.length > 0 && dragHasFiles(e);

  return (
    <aside
      aria-label="Group chat"
      className="absolute right-0 top-0 bottom-0 z-35 flex flex-col pixel-panel max-w-full"
      style={{ width: GROUP_CHAT_WIDTH_PX }}
      data-testid="group-chat"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-stretch bg-bg-dark border-b-2 border-border">
        <div role="tablist" className="flex flex-1 min-w-0 overflow-x-auto">
          {channels.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={c.id === channel.id}
              onClick={() => {
                setChannelId(c.id);
                setPicked({});
              }}
              className={`px-10 py-6 text-sm whitespace-nowrap border-0 border-b-4 rounded-none cursor-pointer ${
                c.id === channel.id
                  ? 'bg-bg text-text border-accent'
                  : 'bg-bg-dark text-text-muted border-transparent'
              }`}
              data-testid="group-channel"
            >
              # {c.name}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close group chat">
          ×
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-8 px-10 py-4 border-b-2 border-bg-thumb text-2xs">
        {channel.members.map((id) => (
          <button
            key={id}
            onClick={() => onOpenAgent(id)}
            className="bg-transparent border-0 p-0 text-text underline cursor-pointer text-2xs"
            title="Open this agent's own chat"
          >
            {labelOf(id)}
          </button>
        ))}
        {channel.members.length === 0 && <span className="text-text-muted">No agents yet.</span>}
        {channelUse && (
          <span
            className="ml-auto text-text-muted"
            title={channelUse.members
              .map((m) => `${labelOf(m.id)}: ${formatTokens(m.totalTokens)}`)
              .join('\n')}
            data-testid="group-usage"
          >
            {formatTokens(channelUse.totalTokens)} tokens · {formatTokens(channelUse.burnPerMinute)}
            /min
          </span>
        )}
      </div>

      <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 p-10">
        {timeline.length === 0 && (
          <div className="text-sm text-text-muted text-center my-auto">Nothing said here yet.</div>
        )}
        {timeline.map((item) => {
          const mine = item.agentId === null;
          return (
            <div
              key={item.key}
              className={`group flex flex-col gap-2 max-w-[88%] ${mine ? 'self-end items-end' : 'self-start'}`}
              data-testid={mine ? 'group-mine' : 'group-reply'}
            >
              <div className="flex gap-6 text-2xs text-text-muted">
                <span className={mine ? '' : 'text-text'}>
                  {mine
                    ? `you → ${item.recipients.length === 1 ? labelOf(item.recipients[0]) : `${item.recipients.length} agents`}`
                    : labelOf(item.agentId!)}
                </span>
                <button
                  onClick={() => onPin(item.text, channel.id === 'everyone' ? [] : channel.members)}
                  className="bg-transparent border-0 p-0 underline text-text-muted cursor-pointer text-2xs"
                >
                  Pin
                </button>
              </div>
              <div
                className={`px-8 py-4 border-2 text-sm whitespace-pre-wrap break-words ${
                  mine ? 'bg-chat-office border-accent' : 'bg-bg-dark border-bg-thumb'
                }`}
              >
                {mine ? <MessageText text={item.text} /> : item.text}
              </div>
            </div>
          );
        })}
      </div>

      <div
        className={`flex flex-col gap-4 p-8 border-t-2 bg-bg-dark ${
          isFileDropTarget ? 'border-dashed border-accent' : 'border-border'
        }`}
        onDragOver={(e) => {
          if (!acceptsFiles(e)) return;
          e.preventDefault();
          setIsFileDropTarget(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsFileDropTarget(false);
        }}
        onDrop={(e) => {
          setIsFileDropTarget(false);
          if (!acceptsFiles(e)) return;
          e.preventDefault();
          attachments.add(e.dataTransfer.files);
        }}
      >
        {onSetRelay && (
          <label className="flex items-center gap-6 text-2xs text-text-muted">
            <input
              type="checkbox"
              checked={relayEnabled}
              onChange={(e) => onSetRelay(e.target.checked)}
              data-testid="group-relay"
            />
            Agents can message each other with @Name (uses tokens; limited to a few per 10 min)
          </label>
        )}
        {reachable.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-8 text-2xs">
              <span className="text-text-muted">Send to</span>
              {addressed.length > 0 && (
                <span className="text-text" data-testid="group-addressed">
                  only {addressed.map(labelOf).join(', ')} (@mentioned)
                </span>
              )}
              {addressed.length === 0 &&
                reachable.map((id) => (
                  <label key={id} className="flex items-center gap-4">
                    <input
                      type="checkbox"
                      checked={isTicked(id)}
                      onChange={(e) => setPicked((p) => ({ ...p, [id]: e.target.checked }))}
                    />
                    {labelOf(id)}
                  </label>
                ))}
            </div>
            {addressed.length === 0 && reachable.length > 1 && (
              <div className="text-2xs text-text-muted">Type @ to call one agent by name.</div>
            )}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-4" data-testid="group-mention-suggestions">
                {suggestions.map((id) => (
                  <button
                    key={id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickMention(id)}
                    className="px-6 py-2 text-2xs bg-bg border-2 border-border text-text cursor-pointer rounded-none hover:border-accent"
                  >
                    @{mentionHandle(labelOf(id))}
                  </button>
                ))}
              </div>
            )}
            {filesEnabled && <FileChips attachments={attachments} />}
            <label htmlFor="group-input" className="sr-only">
              Message #{channel.name}
            </label>
            <div className="flex gap-6 items-end">
              <textarea
                onPaste={(e) => {
                  if (!filesEnabled) return;
                  const pasted = pastedFiles(e.clipboardData);
                  if (pasted.length === 0) return;
                  e.preventDefault();
                  attachments.add(pasted);
                }}
                id="group-input"
                ref={inputRef}
                rows={2}
                value={draft}
                placeholder={`Message #${channel.name}`}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Tab' && suggestions.length > 0) {
                    e.preventDefault();
                    pickMention(suggestions[0]);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="flex-1 min-w-0 resize-none p-6 bg-bg text-text text-sm border-2 border-border rounded-none outline-none focus:border-accent"
                data-testid="group-input"
              />
              {filesEnabled && <AttachFileButton attachments={attachments} />}
              <Button
                variant={canSubmit ? 'accent' : 'disabled'}
                size="md"
                disabled={!canSubmit}
                onClick={() => void send()}
                data-testid="group-send"
              >
                {attachments.uploading ? 'Uploading' : `Send to ${targets.length}`}
              </Button>
            </div>
          </>
        ) : (
          <span className="text-xs text-text-muted">
            None of these agents can be sent to from here. Start them with + Agent or pixel-office
            claude.
          </span>
        )}
      </div>
    </aside>
  );
}
