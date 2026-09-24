import { useEffect, useRef, useState } from 'react';

import type {
  AgentClearPolicy,
  AgentClearRequest,
  AgentKey,
  AgentModels,
  AgentTokenUsage,
  BoardPin,
  ChatEntry,
  ClearMode,
  DocEditMode,
  ScreenQuestion,
  WorkflowRun,
} from '../../../core/src/messages.js';
import {
  AGENT_NAME_INPUT_MAX_CHARS,
  CHAT_CARD_EDGE_MARGIN_PX,
  CHAT_CARD_GAP_PX,
  MOBILE_BREAKPOINT_PX,
  PIN_DRAG_MIME,
} from '../constants.js';
import type { DocRef } from '../docViewer.js';
import { refLabel } from '../docViewer.js';
import { canSendChatFiles, dragHasFiles, pastedFiles, withFileMentions } from '../fileUpload.js';
import { useFileAttachments } from '../hooks/useFileAttachments.js';
import type { ChatQueueState } from '../hooks/useOfficeChat.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { overlayProjection } from '../office/projection.js';
import { burnLevelFor, formatTokens } from '../officeChat.js';
import { tunable } from '../tunableStore.js';
import { AttachFileButton, FileChips, MessageText } from './FileAttachments.js';
import { PinKindTag } from './PinKindTag.js';
import { Button } from './ui/Button.js';
import { WorkflowRunSteps } from './WorkflowRunSteps.js';

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
  /** Places picked in the document viewer, sent as references with the next message. */
  docRefs?: DocRef[];
  onRemoveDocRef?: (index: number) => void;
  onAttachPin: (pinId: string) => void;
  onDetachPin: (pinId: string) => void;
  onSend: (text: string) => void;
  onCancel: (queueId: string) => void;
  onClose: () => void;
  /** Present only where a terminal can be shown (VS Code). */
  onOpenTerminal?: () => void;
  /** Open this chat in the Messenger, for reading long replies. */
  onExpand?: () => void;
  /** Saved workflows this agent can be given; absent when it can't be. */
  workflows?: Array<{ id: string; title: string; steps: number }>;
  onAttachWorkflow?: (workflowId: string) => void;
  /** The workflow this agent is working through, if any. */
  run?: WorkflowRun;
  onStopRun?: () => void;
  usage: AgentTokenUsage | undefined;
  /** The user-given name, '' when none (then `title` is the default label). */
  customName: string;
  onRename: (name: string) => void;
  /** Terminal screen of an agent the office runs itself; undefined for every other agent. */
  screen?: string[];
  onKeys?: (keys: AgentKey[]) => void;
  /** Interrupt the agent's current turn (Esc in its terminal). Shown while it works. */
  onStop?: () => void;
  /** Take this agent out of the office. An agent the office runs is stopped too. */
  onRemove?: () => void;
  /** Clear (or compact) the agent's context. Absent when the office can't type into it. */
  onClearContext?: (mode: ClearMode) => void;
  /** What happens when this agent asks to clear its own context. */
  clearPolicy?: AgentClearPolicy;
  onSetClearPolicy?: (policy: AgentClearPolicy) => void;
  /** The agent's own open request to be cleared, if any. */
  clearRequest?: AgentClearRequest;
  onAnswerClear?: (allow: boolean) => void;
  /** This agent's own document edit mode (absent = the office default, `docEditDefault`). */
  docEditMode?: DocEditMode;
  docEditDefault?: DocEditMode;
  onSetDocEditMode?: (mode: DocEditMode) => void;
  /** A question on this agent's screen, and how to bring its dialog back (it may be hidden). */
  question?: ScreenQuestion;
  onShowQuestion?: () => void;
  /** The agent's model picker as last read; absent until read. */
  models?: AgentModels;
  /** Read / switch through the agent's own model picker. Absent when the office can't. */
  onLoadModels?: () => void;
  onSetModel?: (label: string) => void;
}

/**
 * The agent's model, from its CLI's own picker: the office reads the options
 * off the agent's screen (nothing hard-coded) and picks one for this session.
 */
function ModelRow({
  agentId,
  models,
  onLoad,
  onSet,
}: {
  agentId: number;
  models?: AgentModels;
  onLoad: () => void;
  onSet: (label: string) => void;
}) {
  const busy = models?.state === 'loading' || models?.state === 'switching';
  const options = models?.options ?? [];
  const current = options.find((o) => o.current);
  return (
    <div className="flex flex-col gap-2" data-testid="chat-model-row">
      <label className="flex items-center gap-8 flex-wrap" htmlFor={`model-${agentId}`}>
        <span className="flex-1 min-w-0">Model (this session)</span>
        {options.length > 0 && (
          <select
            id={`model-${agentId}`}
            value={current?.label ?? ''}
            disabled={busy}
            onChange={(e) => e.target.value && onSet(e.target.value)}
            className="bg-bg text-text border-2 border-border rounded-none px-2 max-w-[60%]"
            data-testid="chat-model-select"
          >
            {!current && <option value="">Choose…</option>}
            {options.map((o) => (
              <option key={o.number} value={o.label} title={o.detail}>
                {o.label}
                {o.detail ? ` — ${o.detail}` : ''}
              </option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          variant={busy ? 'disabled' : 'default'}
          disabled={busy}
          onClick={onLoad}
          title="Open the agent's own model picker and read its choices"
          data-testid="chat-model-load"
        >
          {models?.state === 'loading'
            ? 'Reading…'
            : models?.state === 'switching'
              ? 'Switching…'
              : options.length > 0
                ? '↻'
                : 'Show models'}
        </Button>
      </label>
      {models?.error && <span className="text-2xs text-danger">{models.error}</span>}
    </div>
  );
}

const DOC_EDIT_LABEL: Record<DocEditMode, string> = {
  ask: 'Ask before applying',
  auto: 'Auto-accept',
  off: 'Read only',
};

const SCREEN_KEYS: Array<{ label: string; keys: AgentKey[] }> = [
  { label: 'Enter', keys: ['enter'] },
  { label: '1', keys: ['1'] },
  { label: '2', keys: ['2'] },
  { label: '3', keys: ['3'] },
  { label: '↑', keys: ['up'] },
  { label: '↓', keys: ['down'] },
  { label: 'Esc', keys: ['escape'] },
];

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
        className={`px-8 py-4 border-2 font-reading text-read leading-snug whitespace-pre-wrap break-words ${
          isUser
            ? fromOffice
              ? 'bg-chat-office border-accent'
              : 'bg-bg-thumb border-border'
            : 'bg-bg-dark border-bg-thumb'
        }`}
      >
        {isUser ? <MessageText text={entry.text} /> : entry.text}
      </div>
      {entry.usage && (
        <div className="flex gap-8 text-2xs text-text-muted" data-testid="chat-usage">
          <span>{formatTokens(entry.usage.output)} tokens out</span>
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
  docRefs = [],
  onRemoveDocRef,
  onAttachPin,
  onDetachPin,
  onSend,
  onCancel,
  onClose,
  onOpenTerminal,
  onExpand,
  workflows,
  onAttachWorkflow,
  run,
  onStopRun,
  usage,
  customName,
  onRename,
  screen,
  onKeys,
  onStop,
  onRemove,
  onClearContext,
  clearPolicy = 'ask',
  onSetClearPolicy,
  clearRequest,
  onAnswerClear,
  docEditMode,
  docEditDefault = 'ask',
  onSetDocEditMode,
  question,
  onShowQuestion,
  models,
  onLoadModels,
  onSetModel,
}: ChatCardProps) {
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [showScreen, setShowScreen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showClear, setShowClear] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [clearMode, setClearMode] = useState<ClearMode>('clear');
  const [draft, setDraft] = useState('');
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isFileDropTarget, setIsFileDropTarget] = useState(false);
  const attachments = useFileAttachments();
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

  // Less-used actions live in the ⋯ menu so the header keeps room for the name.
  const menuItems: Array<{
    id: string;
    icon: string;
    label: string;
    onClick: () => void;
    on?: boolean;
    danger?: boolean;
  }> = [
    ...(onSetClearPolicy || onSetDocEditMode || onSetModel
      ? [
          {
            id: 'chat-prefs',
            icon: '⚙',
            label: 'Agent settings',
            onClick: () => setShowPrefs((v) => !v),
            on: showPrefs,
          },
        ]
      : []),
    ...(onClearContext
      ? [
          {
            id: 'chat-clear',
            icon: '↺',
            label: 'Clear context…',
            onClick: () => setShowClear((v) => !v),
            on: showClear,
          },
        ]
      : []),
    ...(screen
      ? [
          {
            id: 'chat-screen-toggle',
            icon: '▤',
            label: 'Terminal screen',
            onClick: () => setShowScreen((v) => !v),
            on: showScreen,
          },
        ]
      : []),
    ...(onOpenTerminal
      ? [{ id: 'chat-terminal', icon: '>', label: 'Show terminal', onClick: onOpenTerminal }]
      : []),
    ...(onRemove
      ? [
          {
            id: 'chat-remove',
            icon: '×',
            label: 'Remove agent…',
            onClick: () => setConfirmRemove((v) => !v),
            danger: true,
          },
        ]
      : []),
  ];

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
  const width = Math.min(tunable('chatCardWidthPx'), rect.width - CHAT_CARD_EDGE_MARGIN_PX * 2);
  const height = Math.min(tunable('chatCardHeightPx'), rect.height - CHAT_CARD_EDGE_MARGIN_PX * 2);
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
  // Small screens: a bottom sheet across the whole panel, no anchoring.
  const sheetFraction = tunable('chatSheetHeightFraction');
  const isSheet = rect.width < MOBILE_BREAKPOINT_PX;
  const frame = isSheet
    ? {
        left: 0,
        top: Math.round(rect.height * (1 - sheetFraction)),
        width: rect.width,
        height: Math.round(rect.height * sheetFraction),
      }
    : { left, top, width, height };
  const showTail = !isSheet && left === rawLeft;

  const canSend = readOnlyReason === null;
  const filesEnabled = canSend && canSendChatFiles();
  const hasContent =
    draft.trim().length > 0 ||
    attachedPins.length > 0 ||
    docRefs.length > 0 ||
    attachments.files.length > 0;
  const submit = async () => {
    if (!canSend || !hasContent || attachments.uploading) return;
    const text = draft;
    const paths = await attachments.upload();
    if (!paths) return; // error shown; draft and files kept
    onSend(withFileMentions(paths, text));
    setDraft((current) => (current === text ? '' : current));
  };
  const acceptsFiles = (e: React.DragEvent) => filesEnabled && dragHasFiles(e);

  const acceptsPin = (e: React.DragEvent) =>
    canSend && e.dataTransfer.types.includes(PIN_DRAG_MIME);

  return (
    <div
      role="dialog"
      aria-label={`Chat with ${title}`}
      className="absolute z-45 flex flex-col pixel-panel"
      style={frame}
      data-testid="chat-card"
      data-agent-id={agentId}
      onKeyDown={(e) => {
        // Keep typing out of the office's own shortcuts (editor keys, Escape chain).
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
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
      {isFileDropTarget && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-bg-dark border-2 border-dashed border-accent text-sm pointer-events-none"
          data-testid="chat-file-drop"
        >
          Drop files to send them to {title}
        </div>
      )}
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
              className="min-w-0 text-base overflow-hidden text-ellipsis whitespace-nowrap"
              onDoubleClick={() => setNameDraft(customName || title)}
              title={title}
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
        {onStop && !readOnlyReason && (ch.isActive || needsApproval) && (
          <Button
            size="sm"
            onClick={onStop}
            className="text-danger whitespace-nowrap shrink-0"
            title="Stop what this agent is doing (presses Esc in its terminal)"
            data-testid="chat-stop"
          >
            ■ Stop
          </Button>
        )}
        {onExpand && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={onExpand}
            title="Read this chat in Messages"
            aria-label="Open in Messages"
            data-testid="chat-expand"
          >
            ⤢
          </Button>
        )}
        {menuItems.length > 0 && (
          <span className="relative shrink-0">
            <Button
              size="sm"
              variant={showMenu ? 'active' : 'default'}
              onClick={() => setShowMenu((v) => !v)}
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={showMenu}
              title="More: settings, clear, screen, remove"
              data-testid="chat-menu"
            >
              ⋯
            </Button>
            {showMenu && (
              <span
                role="menu"
                className="absolute top-full right-0 mt-4 z-20 w-200 pixel-panel p-4 flex flex-col"
                onMouseLeave={() => setShowMenu(false)}
              >
                {menuItems.map((item) => (
                  <button
                    key={item.id}
                    role="menuitem"
                    onClick={() => {
                      setShowMenu(false);
                      item.onClick();
                    }}
                    className={`flex items-center gap-8 text-left px-8 py-4 bg-transparent border-0 rounded-none text-sm cursor-pointer hover:bg-btn-hover ${
                      item.danger ? 'text-danger' : 'text-text'
                    }`}
                    data-testid={item.id}
                  >
                    <span className="w-16 text-center text-text-muted">{item.icon}</span>
                    <span className="flex-1">{item.label}</span>
                    {item.on && <span className="text-2xs text-accent-bright">on</span>}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close chat" title="Close">
          ×
        </Button>
      </div>

      {question && onShowQuestion && (
        <div
          role="alert"
          className="flex items-center gap-8 px-10 py-6 bg-bg-dark border-b-2 border-status-permission text-xs"
          data-testid="chat-question"
        >
          <span className="flex-1 min-w-0 truncate">
            <span className="text-status-permission">Asking you:</span>{' '}
            {question.prompt[0] ?? 'a question'}
          </span>
          <Button size="sm" onClick={onShowQuestion} data-testid="chat-question-show">
            Answer
          </Button>
        </div>
      )}

      {clearRequest && onAnswerClear && (
        <div
          role="alertdialog"
          aria-label="Agent asks to clear its context"
          className="flex items-center gap-8 px-10 py-6 bg-bg-dark border-b-2 border-warning text-xs flex-wrap"
          data-testid="chat-clear-request"
        >
          <span className="flex-1 min-w-0">
            <span className="text-warning">Asks to clear its context.</span>
            {clearRequest.reason ? ` “${clearRequest.reason}”` : ''} Nothing is carried over.
          </span>
          <Button size="sm" onClick={() => onAnswerClear(true)} data-testid="chat-clear-allow">
            Allow
          </Button>
          <Button size="sm" onClick={() => onAnswerClear(false)}>
            Not now
          </Button>
        </div>
      )}

      {onClearContext && showClear && (
        <div
          role="dialog"
          aria-label="Clear context"
          className="flex flex-col gap-6 px-10 py-6 bg-bg-dark border-b-2 border-danger text-xs"
          data-testid="chat-clear-panel"
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">How to clear</legend>
            <label className="flex items-start gap-6">
              <input
                type="radio"
                name={`clear-mode-${agentId}`}
                checked={clearMode === 'clear'}
                onChange={() => setClearMode('clear')}
              />
              <span>
                <strong>Clear</strong> — /clear when the turn ends. Nothing is typed after it; the
                agent starts blank.
              </span>
            </label>
            <label className="flex items-start gap-6">
              <input
                type="radio"
                name={`clear-mode-${agentId}`}
                checked={clearMode === 'compact'}
                onChange={() => setClearMode('compact')}
              />
              <span>
                <strong>Compact instead</strong> — /compact keeps a summary in the session.
              </span>
            </label>
          </fieldset>
          <div className="flex items-center gap-8 flex-wrap">
            <Button
              size="sm"
              className="bg-danger! border-danger text-white"
              onClick={() => {
                setShowClear(false);
                onClearContext(clearMode);
              }}
              data-testid="chat-clear-yes"
            >
              {clearMode === 'clear' ? 'Clear context' : 'Compact'}
            </Button>
            <Button size="sm" onClick={() => setShowClear(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {showPrefs && (onSetClearPolicy || onSetDocEditMode || onSetModel) && (
        <div
          role="dialog"
          aria-label="Agent settings"
          className="flex flex-col gap-6 px-10 py-6 bg-bg-dark border-b-2 border-border text-xs"
          data-testid="chat-prefs-panel"
        >
          {onSetModel && onLoadModels && (
            <ModelRow agentId={agentId} models={models} onLoad={onLoadModels} onSet={onSetModel} />
          )}
          {onSetClearPolicy && (
            <label
              className="flex items-center gap-8 flex-wrap"
              htmlFor={`clear-policy-${agentId}`}
            >
              <span className="flex-1 min-w-0">When it asks to clear its own context</span>
              <select
                id={`clear-policy-${agentId}`}
                value={clearPolicy}
                onChange={(e) => onSetClearPolicy(e.target.value as AgentClearPolicy)}
                className="bg-bg text-text border-2 border-border rounded-none px-2"
                data-testid="chat-clear-policy"
              >
                <option value="ask">Ask me</option>
                <option value="allow">Allow</option>
                <option value="never">Never</option>
              </select>
            </label>
          )}
          {onSetDocEditMode && (
            <label className="flex items-center gap-8 flex-wrap" htmlFor={`doc-mode-${agentId}`}>
              <span className="flex-1 min-w-0">Document edits (Word, PowerPoint, Excel)</span>
              <select
                id={`doc-mode-${agentId}`}
                value={docEditMode ?? docEditDefault}
                onChange={(e) => onSetDocEditMode(e.target.value as DocEditMode)}
                className="bg-bg text-text border-2 border-border rounded-none px-2"
                data-testid="chat-doc-mode"
              >
                {(['ask', 'auto', 'off'] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {DOC_EDIT_LABEL[mode]}
                    {!docEditMode && mode === docEditDefault ? ' (office default)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {onRemove && confirmRemove && (
        <div
          role="alertdialog"
          aria-label="Remove agent"
          className="flex items-center gap-8 px-10 py-6 bg-bg-dark border-b-2 border-danger text-xs flex-wrap"
          data-testid="chat-remove-confirm"
        >
          <span className="flex-1 min-w-0">
            {screen
              ? 'Stop this agent? Its Claude session ends and the character leaves.'
              : 'Remove this agent from the office? Its terminal keeps running; only the character leaves.'}
          </span>
          <Button
            size="sm"
            className="bg-danger! border-danger text-white"
            onClick={() => {
              setConfirmRemove(false);
              onRemove();
            }}
            data-testid="chat-remove-yes"
          >
            {screen ? 'Stop agent' : 'Remove'}
          </Button>
          <Button size="sm" onClick={() => setConfirmRemove(false)}>
            Cancel
          </Button>
        </div>
      )}

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
            {usage ? `${formatTokens(usage.outputTokens)} tokens out` : '—'}
          </span>
          <span className="text-text-muted">
            {usage
              ? `${usage.requests} requests${usage.partial ? ' · recent only' : ''}`
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

      {screen && showScreen && (
        <div
          className="flex flex-col gap-4 p-8 bg-bg-dark border-b-2 border-bg-thumb"
          data-testid="chat-screen"
        >
          <pre className="m-0 max-h-200 overflow-auto p-6 bg-chat-tool text-text text-code-sm leading-tight whitespace-pre">
            {screen.length > 0 ? screen.join('\n') : '(nothing on screen yet)'}
          </pre>
          {onKeys && (
            <div className="flex flex-wrap items-center gap-4">
              <span className="text-2xs text-text-muted">Press:</span>
              {SCREEN_KEYS.map((k) => (
                <Button key={k.label} size="sm" onClick={() => onKeys(k.keys)}>
                  {k.label}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

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
            <span className="text-sm">
              {screen
                ? 'Claude is asking something on its screen. Answer it in the dialog at the top, or open Screen.'
                : 'Claude is waiting for your answer in the terminal.'}
            </span>
            {screen && !showScreen && (
              <Button size="sm" className="self-start" onClick={() => setShowScreen(true)}>
                Open Screen
              </Button>
            )}
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
            <div className="px-8 py-4 border-2 border-dashed border-accent-bright font-reading text-read leading-snug text-text-muted whitespace-pre-wrap break-words">
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

      {run && (
        <WorkflowRunSteps
          run={run}
          onStop={onStopRun}
          className="px-8 py-6 border-t-2 border-border bg-bg"
        />
      )}

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
          {docRefs.length > 0 && (
            <div className="flex flex-wrap gap-4" data-testid="chat-doc-refs">
              {docRefs.map((ref, i) => (
                <span
                  key={`${refLabel(ref)}-${i}`}
                  className="flex items-center gap-4 px-4 border border-accent bg-active-bg text-code-sm font-mono"
                >
                  {refLabel(ref)}
                  {onRemoveDocRef && (
                    <button
                      className="bg-transparent border-0 p-0 text-text-muted cursor-pointer"
                      aria-label={`Remove ${refLabel(ref)}`}
                      onClick={() => onRemoveDocRef(i)}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          <FileChips attachments={attachments} />
          {queue?.error && <div className="text-2xs text-danger">{queue.error}</div>}
          <label htmlFor={`chat-input-${agentId}`} className="sr-only">
            Message {title}
          </label>
          <div className="flex flex-col gap-6">
            <textarea
              onPaste={(e) => {
                if (!filesEnabled) return;
                const pasted = pastedFiles(e.clipboardData);
                if (pasted.length === 0) return;
                e.preventDefault();
                attachments.add(pasted);
              }}
              id={`chat-input-${agentId}`}
              ref={inputRef}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={`Message ${title} — Enter sends, Shift+Enter new line`}
              title={`Drop a pin${filesEnabled ? ' or files' : ''} here to attach`}
              className={`w-full min-w-0 resize-none p-6 bg-bg text-text font-reading text-read border-2 rounded-none outline-none ${
                isDropTarget ? 'border-dashed border-pin-note' : 'border-border focus:border-accent'
              }`}
              data-testid="chat-input"
            />
            <div className="flex gap-6 items-center">
              {filesEnabled && <AttachFileButton attachments={attachments} size="sm" />}
              {workflows && onAttachWorkflow && (
                <span className="relative">
                  <Button
                    size="sm"
                    onClick={() => setShowWorkflows((v) => !v)}
                    title="Give this agent a workflow"
                  >
                    Workflow
                  </Button>
                  {showWorkflows && (
                    <span className="absolute bottom-full left-0 mb-4 z-10 w-220 pixel-panel p-4 flex flex-col">
                      {workflows.length === 0 && (
                        <span className="text-2xs text-text-muted p-4">
                          No workflows yet. Make one in Workflows.
                        </span>
                      )}
                      {workflows.map((w) => (
                        <button
                          key={w.id}
                          className="flex gap-6 text-left px-6 py-2 bg-transparent border-0 text-xs text-text cursor-pointer hover:bg-bg-thumb"
                          onClick={() => {
                            onAttachWorkflow(w.id);
                            setShowWorkflows(false);
                          }}
                        >
                          <span className="flex-1">{w.title}</span>
                          <span className="text-2xs text-text-muted">{w.steps} steps</span>
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              )}
              <span className="flex-1" />
              <Button
                variant={hasContent && !attachments.uploading ? 'accent' : 'disabled'}
                size="sm"
                disabled={!hasContent || attachments.uploading}
                onClick={() => void submit()}
                data-testid="chat-send"
              >
                {attachments.uploading
                  ? 'Uploading'
                  : ch.isActive || needsApproval
                    ? 'Queue'
                    : 'Send'}
              </Button>
            </div>
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
