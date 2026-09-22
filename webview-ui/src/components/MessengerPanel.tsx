import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AgentTokenUsage,
  BoardPin,
  ChatEntry,
  FocusRequest,
} from '../../../core/src/messages.js';
import {
  MESSENGER_DOCK_DEFAULT_PX,
  MESSENGER_DOCK_KEY_STEP_PX,
  MESSENGER_DOCK_MIN_PX,
  MESSENGER_DOCK_OFFICE_MIN_PX,
  MESSENGER_DOCK_WIDTH_KEY,
  MESSENGER_EDIT_PREVIEW_ROWS,
  MESSENGER_PREFS_KEY,
} from '../constants.js';
import type { DocRef } from '../docViewer.js';
import { fileBaseName, refLabel, spotLabel } from '../docViewer.js';
import { asFilePath, OpenFileContext } from '../fileLinks.js';
import { canSendChatFiles, dragHasFiles, pastedFiles, withFileMentions } from '../fileUpload.js';
import { useFileAttachments } from '../hooks/useFileAttachments.js';
import type { ChatQueueState } from '../hooks/useOfficeChat.js';
import type { MdBlock, MdInline, ReadingPrefs } from '../messenger.js';
import {
  chatOutline,
  editCounts,
  editRows,
  groupEntries,
  parseMarkdown,
  readPrefs,
  stepCounts,
} from '../messenger.js';
import { formatTokens } from '../officeChat.js';
import {
  AttachFileButton,
  FileChips,
  FileLink,
  LinkedText,
  MessageText,
} from './FileAttachments.js';
import { PinKindTag } from './PinKindTag.js';
import { Button } from './ui/Button.js';

export type MessengerStatus = 'working' | 'idle' | 'asking';

export interface MessengerAgent {
  id: number;
  label: string;
  status: MessengerStatus;
}

export interface MessengerRoom {
  id: string;
  name: string;
}

interface MessengerPanelProps {
  agents: MessengerAgent[];
  rooms: MessengerRoom[];
  selectedId: number | null;
  onSelect: (agentId: number) => void;
  chats: Record<number, ChatEntry[]>;
  unread: Record<number, boolean>;
  queues: Record<number, ChatQueueState | undefined>;
  usage: Record<number, AgentTokenUsage | undefined>;
  contextOf: (agentId: number) => { tokens: number; max: number } | null;
  readOnlyReason: (agentId: number) => string | null;
  onSend: (agentId: number, text: string) => void;
  onCancel: (agentId: number, queueId: string) => void;
  /** Board pins the user can attach, and the ones attached per agent. */
  pinsFor: (agentId: number) => BoardPin[];
  attachedPins: (agentId: number) => BoardPin[];
  onAttachPin: (agentId: number, pinId: string) => void;
  onDetachPin: (agentId: number, pinId: string) => void;
  /** Files agents pointed the user at (`show me`), for the side panel. */
  requests: FocusRequest[];
  onOpenRequest?: (request: FocusRequest) => void;
  onOpenRoom: (roomId: string) => void;
  onOpenTerminal?: (agentId: number) => void;
  /** Open a file named in the chat in the document viewer; absent where it can't be viewed. */
  onOpenFile?: (path: string) => void;
  /** Places picked in the document viewer, waiting to go out with the next message. */
  docRefs: (agentId: number) => DocRef[];
  onRemoveDocRef: (agentId: number, index: number) => void;
  docked: boolean;
  onToggleDock: () => void;
  onClose: () => void;
}

const STATUS_DOT: Record<MessengerStatus, string> = {
  working: 'bg-status-active',
  idle: 'bg-status-success',
  asking: 'bg-status-permission',
};
const STATUS_TEXT: Record<MessengerStatus, string> = {
  working: 'working',
  idle: 'idle',
  asking: 'needs you',
};

function timeLabel(timestamp: string | undefined): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function loadPrefs(): ReadingPrefs {
  try {
    return readPrefs(localStorage.getItem(MESSENGER_PREFS_KEY));
  } catch {
    return readPrefs(null);
  }
}

function savePrefs(prefs: ReadingPrefs): void {
  try {
    localStorage.setItem(MESSENGER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private window or blocked storage: the prefs just don't stick */
  }
}

function loadDockWidth(): number {
  try {
    const n = Number(localStorage.getItem(MESSENGER_DOCK_WIDTH_KEY));
    return Number.isFinite(n) && n >= MESSENGER_DOCK_MIN_PX ? n : MESSENGER_DOCK_DEFAULT_PX;
  } catch {
    return MESSENGER_DOCK_DEFAULT_PX;
  }
}

function saveDockWidth(width: number): void {
  try {
    localStorage.setItem(MESSENGER_DOCK_WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* private window or blocked storage: the width just doesn't stick */
  }
}

/** Keep the dock between its minimum and "leave some office showing". */
function clampDockWidth(width: number, parentWidth: number): number {
  const max = Math.max(MESSENGER_DOCK_MIN_PX, parentWidth - MESSENGER_DOCK_OFFICE_MIN_PX);
  return Math.min(max, Math.max(MESSENGER_DOCK_MIN_PX, width));
}

function Inline({ parts }: { parts: MdInline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'code' ? (
          // Highlighted, not resized: the message's own font and size, so a
          // monospace face never towers over (or shrinks under) the words around it.
          <code
            key={i}
            className="[font:inherit] px-3 bg-bg-dark border border-bg-thumb text-status-success"
          >
            <CodeText text={p.text} />
          </code>
        ) : p.kind === 'bold' ? (
          <strong key={i}>
            <LinkedText text={p.text} />
          </strong>
        ) : (
          <LinkedText key={i} text={p.text} />
        ),
      )}
    </>
  );
}

/** An inline code span; one that names a file opens it. */
function CodeText({ text }: { text: string }) {
  const path = asFilePath(text);
  return path ? <FileLink path={path} text={text} /> : <>{text}</>;
}

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="m-0 p-10 bg-bg-dark border-2 border-bg-thumb overflow-x-auto font-mono text-[13px] leading-snug">
        {text}
      </pre>
      <button
        className="absolute right-4 top-4 px-4 text-2xs bg-bg border-2 border-border text-text-muted cursor-pointer"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          setTimeout(() => setCopied(false), 1_500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Markdown({ blocks }: { blocks: MdBlock[] }) {
  return (
    <div className="flex flex-col gap-8">
      {blocks.map((b, i) => {
        if (b.kind === 'code') return <CodeBlock key={i} text={b.text} />;
        if (b.kind === 'heading') {
          return (
            <div key={i} className="font-bold text-md-heading mt-4">
              <Inline parts={b.inline} />
            </div>
          );
        }
        if (b.kind === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag
              key={i}
              className={`m-0 pl-20 flex flex-col gap-2 ${b.ordered ? 'list-decimal' : 'list-disc'}`}
            >
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline parts={item} />
                </li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={i} className="m-0">
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inline parts={line} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/** A file the agent edited: its path, +/− counts, and the change itself. */
function EditCard({ entry }: { entry: ChatEntry }) {
  const edit = entry.edit!;
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(
    () =>
      edit.hunks.flatMap((h, i) => [
        ...(i > 0 ? [{ kind: 'gap' as const, text: '' }] : []),
        ...editRows(h.removed, h.added),
      ]),
    [edit],
  );
  const counts = useMemo(() => editCounts(edit.hunks), [edit]);
  const shown = showAll ? rows : rows.slice(0, MESSENGER_EDIT_PREVIEW_ROWS);
  return (
    <details open className="border-2 border-bg-thumb bg-chat-tool" data-testid="messenger-edit">
      <summary className="flex items-center gap-8 px-8 py-2 text-xs cursor-pointer select-none">
        <span className={entry.toolDone ? 'text-status-success' : 'text-status-active'}>
          {entry.toolDone ? '✓' : '▶'}
        </span>
        <span className="text-text-muted">{edit.kind === 'write' ? 'Wrote' : 'Edited'}</span>
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={edit.path}>
          <FileLink path={edit.path} text={fileBaseName(edit.path)} />
        </span>
        <span className="ml-auto flex gap-6 font-mono text-2xs shrink-0">
          {counts.added > 0 && <span className="text-status-success">+{counts.added}</span>}
          {counts.removed > 0 && <span className="text-danger">−{counts.removed}</span>}
        </span>
      </summary>
      <div className="border-t-2 border-bg-thumb overflow-x-auto font-mono text-[12px] leading-snug">
        {shown.map((r, i) =>
          r.kind === 'gap' ? (
            <div key={i} className="px-8 text-text-muted">
              ⋯
            </div>
          ) : (
            <div
              key={i}
              className={`flex whitespace-pre ${r.kind === 'del' ? 'bg-diff-del' : r.kind === 'add' ? 'bg-diff-add' : 'text-text-muted'}`}
            >
              {/* font-mono on each span: the global `* { font-pixel }` rule beats inheritance. */}
              <span className="w-16 shrink-0 text-center select-none font-mono">
                {r.kind === 'del' ? '−' : r.kind === 'add' ? '+' : ' '}
              </span>
              <span className="font-mono pr-8">{r.text || ' '}</span>
            </div>
          ),
        )}
        {(rows.length > MESSENGER_EDIT_PREVIEW_ROWS || edit.clipped) && (
          <div className="flex gap-8 px-8 py-2 text-2xs text-text-muted border-t border-bg-thumb font-reading">
            {rows.length > MESSENGER_EDIT_PREVIEW_ROWS && (
              <button
                className="bg-transparent border-0 p-0 underline text-2xs text-text-muted cursor-pointer"
                onClick={() => setShowAll((v) => !v)}
                data-testid="messenger-edit-toggle"
              >
                {showAll ? 'Show less' : `Show all ${rows.length} lines`}
              </button>
            )}
            {edit.clipped && <span>Long change, cut short here.</span>}
          </div>
        )}
      </div>
    </details>
  );
}

function Steps({ entries, open }: { entries: ChatEntry[]; open: boolean }) {
  const running = entries.some((e) => !e.toolDone);
  return (
    <details
      open={open}
      className="border-2 border-bg-thumb bg-chat-tool"
      data-testid="messenger-steps"
    >
      <summary className="flex items-center gap-8 px-8 py-2 text-xs text-text-muted cursor-pointer select-none">
        <span className={running ? 'text-status-active' : 'text-status-success'}>
          {running ? '▶' : '✓'}
        </span>
        {entries.length} {entries.length === 1 ? 'step' : 'steps'}
        <span className="ml-auto flex gap-4 flex-wrap justify-end">
          {stepCounts(entries).map(({ tool, count }) => (
            <span key={tool} className="px-4 border-2 border-border text-2xs">
              {tool}
              {count > 1 ? ` ×${count}` : ''}
            </span>
          ))}
        </span>
      </summary>
      <div className="flex flex-col">
        {entries.map((e) => (
          <div
            key={e.entryId}
            className="flex gap-8 px-8 py-1 border-t border-bg-thumb text-2xs font-mono"
          >
            <span className={e.toolDone ? 'text-status-success' : 'text-status-active'}>
              {e.toolDone ? '✓' : '▶'}
            </span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{e.text}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * The Messenger: a full-size view for reading long chats. A wide reading
 * column in a readable face (the pixel font stays on the chrome), tool rows
 * folded into one line, and the agent's details alongside. Docked, it sits
 * beside the office instead of over it.
 */
export function MessengerPanel(props: MessengerPanelProps) {
  const { agents, rooms, selectedId, onSelect, chats, unread, queues, usage, docked } = props;
  const [prefs, setPrefs] = useState<ReadingPrefs>(loadPrefs);
  const [showPrefs, setShowPrefs] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [showPins, setShowPins] = useState(false);
  const attachments = useFileAttachments();
  const [isFileDropTarget, setIsFileDropTarget] = useState(false);
  const filesEnabled = canSendChatFiles();
  const { clear: clearFiles } = attachments;
  // Pending files belong to the chat they were added in.
  useEffect(() => clearFiles(), [selectedId, clearFiles]);
  const [listOnPhone, setListOnPhone] = useState(selectedId === null);
  const readRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const [dockWidth, setDockWidth] = useState(loadDockWidth);

  const parentWidth = () => panelRef.current?.parentElement?.clientWidth ?? window.innerWidth;
  const resizeDock = (width: number) => {
    const next = clampDockWidth(width, parentWidth());
    setDockWidth(next);
    saveDockWidth(next);
  };

  const startDockDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = panelRef.current?.offsetWidth ?? dockWidth;
    const onMove = (ev: PointerEvent) => {
      // The dock hangs off the right edge: dragging left widens it.
      setDockWidth(clampDockWidth(startWidth + startX - ev.clientX, parentWidth()));
    };
    const onUp = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      resizeDock(startWidth + startX - ev.clientX);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const update = (next: Partial<ReadingPrefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    savePrefs(merged);
  };

  const agent = agents.find((a) => a.id === selectedId) ?? null;
  const entries = useMemo(
    () => (selectedId !== null ? (chats[selectedId] ?? []) : []),
    [chats, selectedId],
  );
  const blocks = useMemo(() => groupEntries(entries), [entries]);
  const outline = useMemo(() => chatOutline(entries), [entries]);

  // Follow new messages while the reader is at the bottom; otherwise offer a jump.
  useEffect(() => {
    const el = readRef.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow content, not scroll state
  }, [entries.length, selectedId]);

  const needle = search.trim().toLowerCase();
  const shownAgents = needle
    ? agents.filter(
        (a) =>
          a.label.toLowerCase().includes(needle) ||
          (chats[a.id] ?? []).some((e) => e.text.toLowerCase().includes(needle)),
      )
    : agents;

  const preview = (id: number) => {
    const list = chats[id] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role !== 'tool' && list[i].text.trim()) return list[i].text.trim().split('\n')[0];
    }
    return '';
  };

  const send = async () => {
    if (selectedId === null || attachments.uploading) return;
    const agentId = selectedId;
    const text = (draft[agentId] ?? '').trim();
    const hasExtras =
      props.attachedPins(agentId).length > 0 ||
      props.docRefs(agentId).length > 0 ||
      attachments.files.length > 0;
    if (!text && !hasExtras) return;
    const paths = await attachments.upload();
    if (!paths) return; // error shown; draft and files kept
    props.onSend(agentId, withFileMentions(paths, text));
    setDraft((d) => ({ ...d, [agentId]: d[agentId]?.trim() === text ? '' : (d[agentId] ?? '') }));
    setAtBottom(true);
  };

  const readOnly = selectedId !== null ? props.readOnlyReason(selectedId) : null;
  const queued = selectedId !== null ? (queues[selectedId]?.queued ?? []) : [];
  const ctx = selectedId !== null ? props.contextOf(selectedId) : null;
  const use = selectedId !== null ? usage[selectedId] : undefined;
  const files = props.requests.filter((r) => r.agentId === selectedId);
  const textSize = prefs.size === 'large' ? 'text-[18px]' : 'text-[15px]';
  const bodyFont = prefs.font === 'pixel' ? 'font-pixel' : 'font-reading';

  const list = (
    <div
      className={`${docked ? 'hidden' : 'flex'} ${listOnPhone ? 'max-sm:flex' : 'max-sm:hidden'} sm:flex flex-col w-240 max-sm:w-full shrink-0 bg-bg-dark border-r-2 border-border min-h-0`}
    >
      <div className="flex items-center gap-6 px-10 py-6 border-b-2 border-border">
        <span className="text-lg">Messages</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={props.onClose}
          aria-label="Close Messages"
        >
          ×
        </Button>
      </div>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        placeholder="Search all chats…"
        className="m-8 px-6 py-2 bg-bg border-2 border-border text-sm text-text"
        data-testid="messenger-search"
      />
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col px-4 pb-8">
        <span className="px-6 pt-4 text-2xs text-text-muted uppercase">Agents</span>
        {shownAgents.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              onSelect(a.id);
              setListOnPhone(false);
              setAtBottom(true);
            }}
            className={`grid grid-cols-[14px_1fr_auto] gap-8 items-center text-left px-6 py-4 border-2 rounded-none cursor-pointer text-text ${
              a.id === selectedId
                ? 'bg-active-bg border-accent'
                : 'bg-transparent border-transparent hover:bg-bg-thumb'
            }`}
            data-testid="messenger-agent"
          >
            <span className={`w-10 h-10 ${STATUS_DOT[a.status]}`} title={STATUS_TEXT[a.status]} />
            <span className="min-w-0">
              <span className="block text-sm overflow-hidden text-ellipsis whitespace-nowrap">
                {a.label}
              </span>
              <span className="block text-2xs text-text-muted font-reading overflow-hidden text-ellipsis whitespace-nowrap">
                {preview(a.id) || STATUS_TEXT[a.status]}
              </span>
            </span>
            {unread[a.id] && a.id !== selectedId && (
              <span className="w-8 h-8 bg-accent" title="Unread" />
            )}
          </button>
        ))}
        {rooms.length > 0 && (
          <span className="px-6 pt-10 text-2xs text-text-muted uppercase">Rooms</span>
        )}
        {rooms.map((r) => (
          <button
            key={r.id}
            onClick={() => props.onOpenRoom(r.id)}
            className="flex gap-8 items-center text-left px-6 py-4 border-2 border-transparent rounded-none cursor-pointer bg-transparent text-text text-sm hover:bg-bg-thumb"
          >
            <span className="text-text-muted">#</span>
            {r.name}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <OpenFileContext.Provider value={props.onOpenFile ?? null}>
      <div
        role="dialog"
        aria-label="Messages"
        ref={panelRef}
        className={`absolute z-58 flex bg-bg border-border ${
          docked ? 'top-0 right-0 bottom-0 max-w-full border-l-2' : 'inset-0'
        }`}
        style={docked ? { width: dockWidth } : undefined}
        data-testid="messenger"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') props.onClose();
        }}
      >
        {docked && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Messages"
            aria-valuenow={Math.round(dockWidth)}
            aria-valuemin={MESSENGER_DOCK_MIN_PX}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            className="absolute -left-4 top-0 bottom-0 w-8 z-10 cursor-col-resize touch-none hover:bg-accent focus-visible:bg-accent outline-none max-sm:hidden"
            onPointerDown={startDockDrag}
            onDoubleClick={() => resizeDock(MESSENGER_DOCK_DEFAULT_PX)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') resizeDock(dockWidth + MESSENGER_DOCK_KEY_STEP_PX);
              else if (e.key === 'ArrowRight') resizeDock(dockWidth - MESSENGER_DOCK_KEY_STEP_PX);
              else return;
              e.preventDefault();
            }}
            data-testid="messenger-dock-resize"
          />
        )}

        {list}

        <div
          className={`${listOnPhone && !docked ? 'max-sm:hidden' : ''} flex-1 min-w-0 flex flex-col min-h-0`}
        >
          {agent ? (
            <>
              <div className="flex items-center gap-8 px-12 py-6 border-b-2 border-border relative">
                <Button
                  size="sm"
                  className="sm:hidden"
                  onClick={() => setListOnPhone(true)}
                  aria-label="Back to the list"
                >
                  ‹
                </Button>
                <span className={`w-12 h-12 ${STATUS_DOT[agent.status]}`} />
                <div className="min-w-0">
                  <div className="text-base overflow-hidden text-ellipsis whitespace-nowrap">
                    {agent.label}
                  </div>
                  <div className="text-2xs text-text-muted">{STATUS_TEXT[agent.status]}</div>
                </div>
                <span className="flex-1" />
                <Button
                  size="sm"
                  onClick={() => setShowPrefs((v) => !v)}
                  title="Reading settings"
                  data-testid="messenger-prefs-toggle"
                >
                  Aa
                </Button>
                {props.onOpenTerminal && (
                  <Button size="sm" onClick={() => props.onOpenTerminal?.(agent.id)}>
                    Terminal
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={props.onToggleDock}
                  title={docked ? 'Full window' : 'Dock beside the office'}
                >
                  {docked ? '⤢ Full' : '⇲ Dock'}
                </Button>
                {docked && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={props.onClose}
                    aria-label="Close Messages"
                  >
                    ×
                  </Button>
                )}
                {showPrefs && (
                  <div
                    className="absolute right-12 top-full mt-4 z-10 w-240 pixel-panel p-10 flex flex-col gap-8 text-sm"
                    data-testid="messenger-prefs"
                  >
                    <span>Reading</span>
                    <label className="flex flex-col gap-2 text-xs text-text-muted">
                      Message font
                      <span className="flex">
                        {(['readable', 'pixel'] as const).map((f) => (
                          <Button
                            key={f}
                            size="sm"
                            variant={prefs.font === f ? 'active' : 'default'}
                            className="flex-1"
                            onClick={() => update({ font: f })}
                          >
                            {f === 'readable' ? 'Readable' : 'Pixel'}
                          </Button>
                        ))}
                      </span>
                    </label>
                    <label className="flex flex-col gap-2 text-xs text-text-muted">
                      Text size
                      <span className="flex">
                        {(['normal', 'large'] as const).map((sz) => (
                          <Button
                            key={sz}
                            size="sm"
                            variant={prefs.size === sz ? 'active' : 'default'}
                            className="flex-1"
                            onClick={() => update({ size: sz })}
                          >
                            {sz === 'normal' ? 'Normal' : 'Large'}
                          </Button>
                        ))}
                      </span>
                    </label>
                    <label className="flex items-center justify-between text-xs cursor-pointer">
                      Fold tool steps
                      <input
                        type="checkbox"
                        checked={prefs.foldSteps}
                        onChange={(e) => update({ foldSteps: e.target.checked })}
                      />
                    </label>
                    <label className="flex items-center justify-between text-xs cursor-pointer">
                      Show times
                      <input
                        type="checkbox"
                        checked={prefs.timestamps}
                        onChange={(e) => update({ timestamps: e.target.checked })}
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className="relative flex-1 min-h-0">
                <div
                  ref={readRef}
                  className="absolute inset-0 overflow-y-auto py-16"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
                  }}
                  data-testid="messenger-read"
                >
                  <div
                    className={`max-w-680 mx-auto px-16 flex flex-col gap-14 ${bodyFont} ${textSize} leading-relaxed`}
                  >
                    {entries.length === 0 && (
                      <div className="m-auto text-sm text-text-muted font-pixel">
                        No messages yet.
                      </div>
                    )}
                    {blocks.map((b) => {
                      if (b.kind === 'steps') {
                        return <Steps key={b.id} entries={b.entries} open={!prefs.foldSteps} />;
                      }
                      if (b.kind === 'edit') {
                        return <EditCard key={b.entry.entryId} entry={b.entry} />;
                      }
                      const e = b.entry;
                      const isUser = e.role === 'user';
                      return (
                        <div
                          key={e.entryId}
                          id={`msg-${e.entryId}`}
                          className={isUser ? 'self-end max-w-[80%]' : 'self-stretch'}
                          data-testid={isUser ? 'messenger-user' : 'messenger-assistant'}
                        >
                          <div
                            className={`flex gap-8 text-2xs text-text-muted font-pixel mb-2 ${isUser ? 'justify-end' : ''}`}
                          >
                            <span className="text-text">
                              {isUser
                                ? e.source === 'office'
                                  ? 'you · office'
                                  : 'you'
                                : agent.label}
                            </span>
                            {prefs.timestamps && <span>{timeLabel(e.timestamp)}</span>}
                            {e.usage && (
                              <span>
                                {formatTokens(
                                  e.usage.input +
                                    e.usage.cacheCreation +
                                    e.usage.cacheRead +
                                    e.usage.output,
                                )}{' '}
                                tokens
                              </span>
                            )}
                          </div>
                          {isUser ? (
                            <div className="px-10 py-6 bg-chat-office border-2 border-accent whitespace-pre-wrap break-words">
                              <MessageText text={e.text} />
                            </div>
                          ) : (
                            <Markdown blocks={parseMarkdown(e.text)} />
                          )}
                        </div>
                      );
                    })}
                    {queued.map((q) => (
                      <div
                        key={q.queueId}
                        className="self-end max-w-[80%] px-10 py-6 border-2 border-dashed border-accent text-text-muted whitespace-pre-wrap"
                      >
                        {q.text}
                        <div className="flex gap-8 mt-4 text-2xs font-pixel">
                          <span>waiting for the turn to end</span>
                          <button
                            className="bg-transparent border-0 p-0 underline text-text-muted cursor-pointer"
                            onClick={() => props.onCancel(agent.id, q.queueId)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {!atBottom && (
                  <button
                    className="absolute left-1/2 -translate-x-1/2 bottom-10 px-10 py-2 bg-accent border-2 border-accent-bright text-sm text-white cursor-pointer"
                    onClick={() => {
                      const el = readRef.current;
                      if (el) el.scrollTop = el.scrollHeight;
                      setAtBottom(true);
                    }}
                  >
                    ↓ Latest
                  </button>
                )}
              </div>

              <div
                className="relative border-t-2 border-border px-12 py-8"
                onDragOver={(e) => {
                  if (readOnly || !filesEnabled || !dragHasFiles(e)) return;
                  e.preventDefault();
                  setIsFileDropTarget(true);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                    setIsFileDropTarget(false);
                }}
                onDrop={(e) => {
                  setIsFileDropTarget(false);
                  if (readOnly || !filesEnabled || !dragHasFiles(e)) return;
                  e.preventDefault();
                  attachments.add(e.dataTransfer.files);
                }}
              >
                {isFileDropTarget && (
                  <div
                    className="absolute inset-0 z-10 flex items-center justify-center bg-bg-dark border-2 border-dashed border-accent text-sm pointer-events-none"
                    data-testid="messenger-file-drop"
                  >
                    Drop files to send them to {agent.label}
                  </div>
                )}
                <div className="max-w-680 mx-auto flex flex-col gap-6">
                  {readOnly ? (
                    <div className="text-xs text-text-muted">{readOnly}</div>
                  ) : (
                    <>
                      {props.attachedPins(agent.id).length > 0 && (
                        <div className="flex gap-4 flex-wrap">
                          {props.attachedPins(agent.id).map((pin) => (
                            <span
                              key={pin.id}
                              className="flex items-center gap-4 px-6 py-1 bg-active-bg border-2 border-accent text-2xs"
                            >
                              <PinKindTag kind={pin.kind} />
                              {pin.title}
                              <button
                                className="bg-transparent border-0 p-0 text-text-muted cursor-pointer"
                                onClick={() => props.onDetachPin(agent.id, pin.id)}
                                aria-label={`Remove ${pin.title}`}
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {props.docRefs(agent.id).length > 0 && (
                        <div className="flex gap-4 flex-wrap" data-testid="messenger-doc-refs">
                          {props.docRefs(agent.id).map((ref, i) => (
                            <span
                              key={`${refLabel(ref)}-${i}`}
                              className="flex items-center gap-4 px-6 py-1 bg-active-bg border-2 border-accent text-2xs font-mono"
                            >
                              {refLabel(ref)}
                              <button
                                className="bg-transparent border-0 p-0 text-text-muted cursor-pointer"
                                aria-label={`Remove ${refLabel(ref)}`}
                                onClick={() => props.onRemoveDocRef(agent.id, i)}
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      {filesEnabled && <FileChips attachments={attachments} />}
                      <textarea
                        value={draft[agent.id] ?? ''}
                        onPaste={(e) => {
                          if (!filesEnabled) return;
                          const pasted = pastedFiles(e.clipboardData);
                          if (pasted.length === 0) return;
                          e.preventDefault();
                          attachments.add(pasted);
                        }}
                        onChange={(e) => setDraft((d) => ({ ...d, [agent.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                        rows={3}
                        placeholder={`Message ${agent.label}…`}
                        className="w-full resize-y min-h-60 max-h-240 px-10 py-6 bg-bg-dark border-2 border-border font-reading text-[15px] text-text"
                        data-testid="messenger-input"
                      />
                      <div className="flex items-center gap-6 relative">
                        <Button size="sm" onClick={() => setShowPins((v) => !v)}>
                          + Attach
                        </Button>
                        {filesEnabled && <AttachFileButton attachments={attachments} />}
                        {showPins && (
                          <div className="absolute bottom-full left-0 mb-4 w-280 max-h-240 overflow-y-auto pixel-panel p-6 flex flex-col gap-2 z-10">
                            {props.pinsFor(agent.id).length === 0 && (
                              <span className="text-2xs text-text-muted p-4">
                                The whiteboard has nothing for this agent.
                              </span>
                            )}
                            {props.pinsFor(agent.id).map((pin) => (
                              <button
                                key={pin.id}
                                className="flex items-center gap-6 text-left px-6 py-2 bg-transparent border-0 text-xs text-text cursor-pointer hover:bg-bg-thumb"
                                onClick={() => {
                                  props.onAttachPin(agent.id, pin.id);
                                  setShowPins(false);
                                }}
                              >
                                <PinKindTag kind={pin.kind} />
                                <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                                  {pin.title}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        <span className="flex-1 text-2xs text-text-muted max-sm:hidden">
                          Enter sends · Shift+Enter new line
                          {filesEnabled ? ' · paste or drop files' : ''}
                        </span>
                        <Button
                          variant="accent"
                          size="sm"
                          disabled={attachments.uploading}
                          onClick={() => void send()}
                          data-testid="messenger-send"
                        >
                          {attachments.uploading ? 'Uploading' : 'Send'}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="m-auto text-sm text-text-muted">Pick an agent to read its chat.</div>
          )}
        </div>

        {agent && !docked && (
          <aside className="hidden lg:flex flex-col gap-16 w-260 shrink-0 p-12 bg-bg-dark border-l-2 border-border overflow-y-auto">
            <section className="flex flex-col gap-4">
              <span className="text-2xs text-text-muted uppercase">Context</span>
              {ctx ? (
                <>
                  <div className="h-10 bg-bg-thumb border-2 border-border relative">
                    <div
                      className="absolute inset-y-0 left-0 bg-status-active"
                      style={{
                        width: `${Math.min(100, Math.round((ctx.tokens / ctx.max) * 100))}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-2xs text-text-muted">
                    <span>
                      {formatTokens(ctx.tokens)} / {formatTokens(ctx.max)}
                    </span>
                    <span>{Math.round((ctx.tokens / ctx.max) * 100)}%</span>
                  </div>
                </>
              ) : (
                <span className="text-2xs text-text-muted">Not known yet.</span>
              )}
            </section>
            {use && (
              <section className="flex flex-col gap-2 text-xs">
                <span className="text-2xs text-text-muted uppercase">Tokens this session</span>
                <span>{formatTokens(use.totalTokens)} total</span>
                <span className="text-text-muted">
                  {formatTokens(use.burnPerMinute)} / min lately
                </span>
              </section>
            )}
            {outline.length > 0 && (
              <section className="flex flex-col gap-2">
                <span className="text-2xs text-text-muted uppercase">In this chat</span>
                {outline.map((o) => (
                  <button
                    key={o.entryId}
                    className="text-left bg-transparent border-0 border-l-2 border-bg-thumb px-6 py-2 text-xs text-text font-reading cursor-pointer hover:border-accent"
                    onClick={() =>
                      document
                        .getElementById(`msg-${o.entryId}`)
                        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                    }
                  >
                    {o.label}
                    {prefs.timestamps && o.timestamp && (
                      <span className="text-text-muted"> · {timeLabel(o.timestamp)}</span>
                    )}
                  </button>
                ))}
              </section>
            )}
            {files.length > 0 && (
              <section className="flex flex-col gap-4">
                <span className="text-2xs text-text-muted uppercase">Files it showed you</span>
                {files.map((r) => (
                  <button
                    key={r.requestId}
                    disabled={!props.onOpenRequest}
                    onClick={() => props.onOpenRequest?.(r)}
                    className="self-start max-w-full px-6 py-1 bg-pin-file text-board-ink text-2xs border-2 border-board-ink cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap"
                  >
                    {fileBaseName(r.path)}
                    {spotLabel(r) ? ` · ${spotLabel(r)}` : ''}
                  </button>
                ))}
              </section>
            )}
          </aside>
        )}
      </div>
    </OpenFileContext.Provider>
  );
}
