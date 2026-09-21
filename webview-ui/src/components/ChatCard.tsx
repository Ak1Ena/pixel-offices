import { useEffect, useRef, useState } from 'react';

import type { AgentTokenUsage, BoardPin, ChatEntry } from '../../../core/src/messages.js';
import {
  AGENT_NAME_INPUT_MAX_CHARS,
  CHAT_CARD_EDGE_MARGIN_PX,
  CHAT_CARD_GAP_PX,
  CHAT_CARD_HEIGHT_PX,
  CHAT_CARD_WIDTH_PX,
  PIN_DRAG_MIME,
} from '../constants.js';
import type { ChatQueueState } from '../hooks/useOfficeChat.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';
import { burnLevelFor, formatTokens } from '../officeChat.js';
import { PinKindTag } from './PinKindTag.js';
import { Button } from './ui/Button.js';

interface ChatCardProps {
  agentId: number;
  title: string;
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  entries: ChatEntry[];
  queue: ChatQueueState | undefined;
  /** Why this session can't be typed into from here; null when it can. */
  readOnlyReason: string | null;
  needsApproval: boolean;
  attachedPins: BoardPin[];
  onAttachPin: (pinId: string) => void;
  onDetachPin: (pinId: string) => void;
  onSend: (text: string) => void;
  onCancel: (queueId: string) => void;
  onClose: () => void;
  /** Present only where a terminal can be shown (VS Code). */
  onOpenTerminal?: () => void;
  usage: AgentTokenUsage | undefined;
  /** The user-given name, '' when none (then `title` is the default label). */
  customName: string;
  onRename: (name: string) => void;
}

function timeLabel(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ChatRow({ entry }: { entry: ChatEntry }) {
  if (entry.role === 'tool') {
    return (
      <div
        className="flex gap-6 items-center px-6 py-1 bg-chat-tool text-xs"
        data-testid="chat-tool"
      >
        <span className={entry.toolDone ? 'text-status-success' : 'text-status-active'}>
          {entry.toolDone ? '✓' : '▶'}
        </span>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{entry.text}</span>
      </div>
    );
  }
  const isUser = entry.role === 'user';
  const fromOffice = entry.source === 'office';
  return (
    <div
      className={`flex flex-col gap-2 max-w-[85%] ${isUser ? 'self-end items-end' : 'self-start'}`}
      data-testid={isUser ? 'chat-user' : 'chat-assistant'}
    >
      <div className="flex gap-6 text-2xs text-text-muted">
        {isUser && (
          <span className={`px-4 border ${fromOffice ? 'border-accent' : 'border-border'}`}>
            {fromOffice ? 'OFFICE' : 'TERMINAL'}
          </span>
        )}
        <span>
          {isUser ? 'you' : 'claude'} {timeLabel(entry.timestamp)}
        </span>
      </div>
      <div
        className={`px-8 py-4 border-2 text-sm whitespace-pre-wrap break-words ${
          isUser
            ? fromOffice
              ? 'bg-chat-office border-accent'
              : 'bg-bg-thumb border-border'
            : 'bg-bg-dark border-bg-thumb'
        }`}
      >
        {entry.text}
      </div>
      {entry.usage && (
        <div className="flex gap-8 text-2xs text-text-muted" data-testid="chat-usage">
          <span>in {formatTokens(entry.usage.input + entry.usage.cacheCreation)}</span>
          <span>out {formatTokens(entry.usage.output)}</span>
          <span>cached {formatTokens(entry.usage.cacheRead)}</span>
          <span className="text-text">
            ={' '}
            {formatTokens(
              entry.usage.input +
                entry.usage.cacheCreation +
                entry.usage.cacheRead +
                entry.usage.output,
            )}
          </span>
        </div>
      )}
    </div>
  );
}

/** Context meter color by how full the window is. */
function contextColor(ratio: number): string {
  if (ratio >= 0.9) return 'var(--color-danger)';
  if (ratio >= 0.75) return 'var(--color-warning)';
  if (ratio >= 0.5) return 'var(--color-status-permission)';
  return 'var(--color-status-active)';
}

/**
 * The chat card anchored next to a character: its session's conversation
 * (read from the transcript) and a composer that types into its terminal.
 */
export function ChatCard({
  agentId,
  title,
  officeState,
  containerRef,
  zoom,
  panRef,
  entries,
  queue,
  readOnlyReason,
  needsApproval,
  attachedPins,
  onAttachPin,
  onDetachPin,
  onSend,
  onCancel,
  onClose,
  onOpenTerminal,
  usage,
  customName,
  onRename,
}: ChatCardProps) {
  const [draft, setDraft] = useState('');
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Follow the character as it walks and the camera pans.
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Keep the newest message in view.
  const lastEntry = entries[entries.length - 1];
  const queuedCount = queue?.queued.length ?? 0;
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, lastEntry?.entryId, lastEntry?.toolDone, queuedCount]);

  useEffect(() => {
    if (!readOnlyReason) inputRef.current?.focus();
  }, [agentId, readOnlyReason, attachedPins.length]);

  const container = containerRef.current;
  const ch = officeState.characters.get(agentId);
  if (!container || !ch) return null;
  const rect = container.getBoundingClientRect();
  const project = overlayProjection(
    officeState.getLayout(),
    rect,
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );
  const charX = project.toScreenX(ch.x);
  const charY = project.toScreenY(ch.y);
  const width = Math.min(CHAT_CARD_WIDTH_PX, rect.width - CHAT_CARD_EDGE_MARGIN_PX * 2);
  const height = Math.min(CHAT_CARD_HEIGHT_PX, rect.height - CHAT_CARD_EDGE_MARGIN_PX * 2);
  const fitsRight = charX + CHAT_CARD_GAP_PX + width <= rect.width - CHAT_CARD_EDGE_MARGIN_PX;
  const rawLeft = fitsRight ? charX + CHAT_CARD_GAP_PX : charX - CHAT_CARD_GAP_PX - width;
  const left = Math.max(
    CHAT_CARD_EDGE_MARGIN_PX,
    Math.min(rawLeft, rect.width - width - CHAT_CARD_EDGE_MARGIN_PX),
  );
  const top = Math.max(
    CHAT_CARD_EDGE_MARGIN_PX,
    Math.min(charY - height / 2, rect.height - height - CHAT_CARD_EDGE_MARGIN_PX),
  );
  const tailTop = Math.max(16, Math.min(charY - top - 12, height - 40));
  const showTail = left === rawLeft;

  const canSend = readOnlyReason === null;
  const hasContent = draft.trim().length > 0 || attachedPins.length > 0;
  const submit = () => {
    if (!canSend || !hasContent) return;
    onSend(draft);
    setDraft('');
  };

  const acceptsPin = (e: React.DragEvent) =>
    canSend && e.dataTransfer.types.includes(PIN_DRAG_MIME);

  return (
    <div
      role="dialog"
      aria-label={`Chat with ${title}`}
      className="absolute z-45 flex flex-col pixel-panel"
      style={{ left, top, width, height }}
      data-testid="chat-card"
      data-agent-id={agentId}
      onKeyDown={(e) => {
        // Keep typing out of the office's own shortcuts (editor keys, Escape chain).
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {showTail && (
        <div
          className="absolute w-0 h-0"
          style={{
            top: tailTop,
            ...(fitsRight
              ? {
                  left: -14,
                  borderTop: '12px solid transparent',
                  borderBottom: '12px solid transparent',
                  borderRight: '12px solid var(--color-border)',
                }
              : {
                  right: -14,
                  borderTop: '12px solid transparent',
                  borderBottom: '12px solid transparent',
                  borderLeft: '12px solid var(--color-border)',
                }),
          }}
        />
      )}

      <div className="flex items-center gap-8 px-10 py-4 border-b-2 border-bg-thumb">
        <span
          className="w-8 h-8 shrink-0"
          style={{
            background: needsApproval
              ? 'var(--color-status-permission)'
              : ch.isActive
                ? 'var(--color-status-active)'
                : 'var(--color-status-success)',
          }}
        />
        {nameDraft === null ? (
          <>
            <span
              className="text-base overflow-hidden text-ellipsis whitespace-nowrap"
              onDoubleClick={() => setNameDraft(customName || title)}
              data-testid="chat-title"
            >
              {title}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setNameDraft(customName || title)}
              aria-label="Rename character"
              title="Rename"
              data-testid="chat-rename"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M2 12 L2 9 L9 2 L12 5 L5 12 Z" />
              </svg>
            </Button>
          </>
        ) : (
          <form
            className="flex items-center gap-4 min-w-0"
            onSubmit={(e) => {
              e.preventDefault();
              onRename(nameDraft);
              setNameDraft(null);
            }}
          >
            <label htmlFor={`rename-${agentId}`} className="sr-only">
              Character name
            </label>
            <input
              id={`rename-${agentId}`}
              autoFocus
              value={nameDraft}
              maxLength={AGENT_NAME_INPUT_MAX_CHARS}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setNameDraft(null);
                }
              }}
              onBlur={() => setNameDraft(null)}
              className="min-w-0 w-160 px-4 bg-bg text-text text-base border-2 border-accent rounded-none outline-none"
              data-testid="chat-rename-input"
            />
          </form>
        )}
        {readOnlyReason && (
          <span className="text-2xs px-4 border border-border text-text-muted shrink-0">
            READ-ONLY
          </span>
        )}
        <span className="flex-1" />
        {onOpenTerminal && (
          <Button size="sm" onClick={onOpenTerminal} title="Show this session's terminal">
            Terminal
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close chat" title="Close">
          ×
        </Button>
      </div>

      <div
        className="grid grid-cols-3 gap-8 px-10 py-4 bg-bg-dark border-b-2 border-bg-thumb text-2xs"
        data-testid="chat-stats"
      >
        <div className="flex flex-col gap-2 min-w-0">
          <span className="text-xs">CONTEXT</span>
          {ch.contextTokens > 0 ? (
            <>
              <div
                role="meter"
                aria-label="Context used"
                aria-valuenow={Math.round((ch.contextTokens / ch.maxContextTokens) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-6 bg-bg border border-border"
              >
                <div
                  className="h-full"
                  style={{
                    width: `${Math.min(100, (ch.contextTokens / ch.maxContextTokens) * 100)}%`,
                    background: contextColor(ch.contextTokens / ch.maxContextTokens),
                  }}
                />
              </div>
              <span className="text-text-muted">
                {formatTokens(ch.contextTokens)} / {formatTokens(ch.maxContextTokens)}
              </span>
            </>
          ) : (
            <span className="text-text-muted">no turn yet</span>
          )}
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          <span className="text-xs">SESSION</span>
          <span className="text-sm">
            {usage ? `${formatTokens(usage.totalTokens)} tokens` : '—'}
          </span>
          <span className="text-text-muted">
            {usage
              ? `${usage.requests} requests · out ${formatTokens(usage.outputTokens)}${usage.partial ? ' · recent only' : ''}`
              : 'no usage yet'}
          </span>
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          <span
            className={`text-xs ${burnLevelFor(usage?.burnPerMinute ?? 0) === 2 ? 'text-danger' : burnLevelFor(usage?.burnPerMinute ?? 0) === 1 ? 'text-warning' : ''}`}
          >
            {burnLevelFor(usage?.burnPerMinute ?? 0) === 2 ? 'ON FIRE' : 'BURN'}
          </span>
          <span className="text-sm">{formatTokens(usage?.burnPerMinute ?? 0)} tok/min</span>
          <span className="text-text-muted">new tokens, last 5 min</span>
        </div>
      </div>

      <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 p-10">
        {entries.length === 0 && (
          <div className="text-sm text-text-muted text-center my-auto">
            No messages yet. They appear here as the session runs.
          </div>
        )}
        {entries.map((entry) => (
          <ChatRow key={entry.entryId} entry={entry} />
        ))}
        {needsApproval && (
          <div
            className="flex flex-col gap-4 p-8 bg-chat-permission border-2 border-status-permission"
            data-testid="chat-permission"
          >
            <span className="text-xs text-status-permission">Permission needed</span>
            <span className="text-sm">Claude is waiting for your answer in the terminal.</span>
            {onOpenTerminal && (
              <Button size="sm" className="self-start" onClick={onOpenTerminal}>
                Open terminal
              </Button>
            )}
          </div>
        )}
        {queue?.queued.map((message) => (
          <div
            key={message.queueId}
            className="self-end flex flex-col items-end gap-2 max-w-[85%]"
            data-testid="chat-queued"
          >
            <div className="px-8 py-4 border-2 border-dashed border-accent-bright text-sm text-text-muted whitespace-pre-wrap break-words">
              {message.text}
            </div>
            <div className="flex gap-8 text-2xs text-text-muted">
              <span>queued · sends when the turn ends</span>
              <button
                className="bg-transparent border-0 p-0 underline text-text cursor-pointer text-2xs"
                onClick={() => onCancel(message.queueId)}
              >
                Cancel
              </button>
            </div>
          </div>
        ))}
      </div>

      {canSend ? (
        <div
          className="flex flex-col gap-4 p-8 border-t-2 border-border bg-bg-dark"
          onDragOver={(e) => {
            if (!acceptsPin(e)) return;
            e.preventDefault();
            setIsDropTarget(true);
          }}
          onDragLeave={() => setIsDropTarget(false)}
          onDrop={(e) => {
            setIsDropTarget(false);
            const pinId = e.dataTransfer.getData(PIN_DRAG_MIME);
            if (!pinId || !canSend) return;
            e.preventDefault();
            onAttachPin(pinId);
          }}
        >
          {attachedPins.length > 0 && (
            <div className="flex flex-wrap gap-4">
              {attachedPins.map((pin) => (
                <span
                  key={pin.id}
                  className="flex items-center gap-4 px-4 border border-border bg-bg text-2xs max-w-full"
                  data-testid="chat-attached-pin"
                >
                  <PinKindTag kind={pin.kind} />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                    {pin.title}
                  </span>
                  <button
                    className="bg-transparent border-0 p-0 text-text-muted cursor-pointer"
                    aria-label={`Remove ${pin.title}`}
                    onClick={() => onDetachPin(pin.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {queue?.error && <div className="text-2xs text-danger">{queue.error}</div>}
          <label htmlFor={`chat-input-${agentId}`} className="text-2xs text-text-muted">
            Message {title} · Enter sends, Shift+Enter new line · drop a pin to attach
          </label>
          <div className="flex gap-6 items-end">
            <textarea
              id={`chat-input-${agentId}`}
              ref={inputRef}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              className={`flex-1 min-w-0 resize-none p-6 bg-bg text-text text-sm border-2 rounded-none outline-none ${
                isDropTarget ? 'border-dashed border-pin-note' : 'border-border focus:border-accent'
              }`}
              data-testid="chat-input"
            />
            <Button
              variant={hasContent ? 'accent' : 'disabled'}
              size="md"
              disabled={!hasContent}
              onClick={submit}
              data-testid="chat-send"
            >
              {ch.isActive || needsApproval ? 'Queue' : 'Send'}
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="flex flex-col gap-2 p-10 border-t-2 border-border bg-bg-dark"
          data-testid="chat-read-only"
        >
          <span className="text-sm">The office can't type into this session.</span>
          <span className="text-xs text-text-muted">{readOnlyReason}</span>
        </div>
      )}
    </div>
  );
}
