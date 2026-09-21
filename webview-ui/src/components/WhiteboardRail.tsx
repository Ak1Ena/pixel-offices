import { useState } from 'react';

import type { BoardPin, BoardPinKind } from '../../../core/src/messages.js';
import {
  BOARD_PIN_DETAIL_MAX_CHARS,
  BOARD_PIN_DETAIL_PREVIEW_CHARS,
  PIN_DRAG_MIME,
  WHITEBOARD_RAIL_WIDTH_PX,
} from '../constants.js';
import { newPinId } from '../officeChat.js';
import { PIN_KIND_LABEL, PIN_KIND_PAPER } from './pinKinds.js';

interface AgentOption {
  id: number;
  label: string;
}

interface WhiteboardRailProps {
  isOpen: boolean;
  onToggle: () => void;
  pins: BoardPin[];
  agents: AgentOption[];
  /** The agent whose chat is open, if any — enables "Attach" on each pin. */
  chatAgentLabel: string | null;
  onAttach: (pinId: string) => void;
  onSave: (pin: BoardPin) => void;
  onRemove: (pinId: string) => void;
  /** Open a file pin in the document viewer; absent where the viewer isn't available. */
  onView?: (pinId: string) => void;
  /** Upload a file from this device and pin it; resolves with an error message or null. */
  onUpload?: (file: File) => Promise<string | null>;
}

const KINDS: BoardPinKind[] = ['link', 'file', 'snippet', 'note'];

const VALUE_LABEL: Record<BoardPinKind, string> = {
  link: 'URL',
  file: 'Full path (e.g. ~/Documents/plan.pdf)',
  snippet: 'Code',
  note: 'Text',
};

const boardButton =
  'border-2 border-board-ink rounded-none cursor-pointer text-board-ink bg-board shadow-pixel';

const detailInputClass =
  'p-4 text-xs bg-board text-board-ink border-2 border-board-ink rounded-none outline-none resize-none';

/** A pin's detail: shown folded when long, and edited in place. */
function PinDetail({ pin, onSave }: { pin: BoardPin; onSave: (pin: BoardPin) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const text = pin.detail ?? '';

  if (draft !== null) {
    const save = () => {
      const next = draft.trim();
      // undefined drops out of the JSON, so clearing the text removes the detail.
      onSave({ ...pin, detail: next || undefined });
      setDraft(null);
    };
    return (
      <div
        className="flex flex-col gap-4"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') setDraft(null);
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
        }}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
      >
        <textarea
          autoFocus
          rows={4}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={BOARD_PIN_DETAIL_MAX_CHARS}
          placeholder="What it is, why it matters, how to use it"
          aria-label={`Detail for ${pin.title}`}
          className={detailInputClass}
          data-testid="pin-detail-edit"
        />
        <div className="flex gap-6 justify-end">
          <button onClick={() => setDraft(null)} className={`px-6 text-2xs ${boardButton}`}>
            Cancel
          </button>
          <button
            onClick={save}
            className="px-6 text-2xs border-2 border-board-ink rounded-none cursor-pointer bg-board-ink text-board shadow-pixel"
            data-testid="pin-detail-save"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  const long = text.length > BOARD_PIN_DETAIL_PREVIEW_CHARS;
  return (
    <div className="flex flex-col gap-2">
      {text && (
        <span
          className="text-2xs leading-tight whitespace-pre-wrap break-words"
          data-testid="pin-detail-text"
        >
          {long && !expanded ? `${text.slice(0, BOARD_PIN_DETAIL_PREVIEW_CHARS)}…` : text}
        </span>
      )}
      <div className="flex gap-8 text-2xs">
        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="bg-transparent border-0 p-0 underline cursor-pointer text-board-ink text-2xs"
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        <button
          onClick={() => setDraft(text)}
          className="bg-transparent border-0 p-0 underline cursor-pointer text-board-ink text-2xs"
          data-testid="pin-detail-button"
        >
          {text ? 'Edit detail' : '+ Add detail'}
        </button>
      </div>
    </div>
  );
}

function PinForm({
  agents,
  onSave,
  onCancel,
  onUpload,
}: {
  agents: AgentOption[];
  onSave: (pin: BoardPin) => void;
  onCancel: () => void;
  onUpload?: (file: File) => Promise<string | null>;
}) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState<BoardPinKind>('link');
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [detail, setDetail] = useState('');
  const [scope, setScope] = useState<number[]>([]);
  const multiline = kind === 'snippet' || kind === 'note';
  const canSave = title.trim().length > 0 && (kind === 'note' || value.trim().length > 0);

  const toggleScope = (id: number) =>
    setScope((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <form
      aria-label="New pin"
      className="flex flex-col gap-6 p-10 border-b-2 border-board-edge"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        onSave({
          id: newPinId(),
          kind,
          title: title.trim(),
          value: kind === 'snippet' ? value : value.trim(),
          ...(detail.trim() ? { detail: detail.trim() } : {}),
          scope,
          createdAt: new Date().toISOString(),
        });
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div role="radiogroup" aria-label="Pin type" className="grid grid-cols-4 gap-4">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={`py-2 text-2xs border-2 border-board-ink rounded-none cursor-pointer ${
              kind === k ? 'bg-board-ink text-board' : 'bg-board text-board-ink'
            }`}
          >
            {PIN_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-2 text-2xs">
        Title
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className="p-4 text-xs bg-board text-board-ink border-2 border-board-ink rounded-none outline-none"
          data-testid="pin-title"
        />
      </label>
      <label className="flex flex-col gap-2 text-2xs">
        {VALUE_LABEL[kind]}
        {multiline ? (
          <textarea
            rows={4}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={8000}
            className="p-4 text-xs bg-board text-board-ink border-2 border-board-ink rounded-none outline-none resize-none"
            data-testid="pin-value"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={8000}
            className="p-4 text-xs bg-board text-board-ink border-2 border-board-ink rounded-none outline-none"
            data-testid="pin-value"
          />
        )}
      </label>
      <label className="flex flex-col gap-2 text-2xs">
        Detail (optional — what it is, why it matters, how to use it)
        <textarea
          rows={3}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          maxLength={BOARD_PIN_DETAIL_MAX_CHARS}
          className={detailInputClass}
          data-testid="pin-detail"
        />
      </label>
      {kind === 'file' && onUpload && (
        <label className="flex flex-col gap-2 text-2xs">
          Or upload from this device (PDF, Word, Excel, CSV, text, image · up to 25 MB)
          <input
            type="file"
            accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.log,.json,.png,.jpg,.jpeg,.gif,.webp"
            disabled={uploading}
            className="text-2xs"
            data-testid="pin-upload"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setUploading(true);
              setUploadError(null);
              void onUpload(file).then((error) => {
                setUploading(false);
                if (error) setUploadError(error);
                else onCancel(); // pinned by the server; close the form
              });
            }}
          />
          {uploading && <span>Uploading…</span>}
          {uploadError && <span className="text-danger">{uploadError}</span>}
        </label>
      )}
      {agents.length > 0 && (
        <fieldset className="flex flex-wrap gap-8 items-center border-0 p-0 m-0 text-2xs">
          <legend className="mb-2">Visible to</legend>
          <label className="flex gap-4 items-center">
            <input type="checkbox" checked={scope.length === 0} onChange={() => setScope([])} />
            All
          </label>
          {agents.map((agent) => (
            <label key={agent.id} className="flex gap-4 items-center">
              <input
                type="checkbox"
                checked={scope.includes(agent.id)}
                onChange={() => toggleScope(agent.id)}
              />
              {agent.label}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex gap-6">
        <button
          type="submit"
          disabled={!canSave}
          className={`flex-1 py-2 text-xs border-2 border-board-ink rounded-none bg-board-ink text-board shadow-pixel ${
            canSave ? 'cursor-pointer' : 'cursor-default opacity-[var(--btn-disabled-opacity)]'
          }`}
          data-testid="pin-save"
        >
          Pin it
        </button>
        <button type="button" onClick={onCancel} className={`px-10 py-2 text-xs ${boardButton}`}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The whiteboard: shared resources (links, files, snippets, notes) every
 * session can use. Pins drag onto a character or a chat to ride along with
 * the next message. Closed, it folds into a tab on the right edge.
 */
export function WhiteboardRail({
  isOpen,
  onToggle,
  pins,
  agents,
  chatAgentLabel,
  onAttach,
  onSave,
  onRemove,
  onView,
  onUpload,
}: WhiteboardRailProps) {
  const [isAdding, setIsAdding] = useState(false);
  const labelFor = (id: number) => agents.find((a) => a.id === id)?.label ?? `#${id}`;

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        aria-label={`Open whiteboard, ${pins.length} pins`}
        className={`absolute right-0 top-1/2 -translate-y-1/2 z-30 px-4 py-16 text-xs ${boardButton} border-r-0`}
        style={{ writingMode: 'vertical-rl' }}
        data-testid="board-tab"
      >
        BOARD · {pins.length}
      </button>
    );
  }

  return (
    <aside
      aria-label="Whiteboard"
      className="absolute right-0 top-0 bottom-0 z-30 flex flex-col bg-board text-board-ink border-l-4 border-board-edge"
      style={{ width: `min(${WHITEBOARD_RAIL_WIDTH_PX}px, 100%)` }}
      data-testid="board-rail"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-8 p-10 border-b-2 border-board-edge">
        <div className="flex flex-col gap-2 flex-1">
          <span className="text-lg leading-none">WHITEBOARD</span>
          <span className="text-2xs text-board-ink-muted">
            Drag a pin onto a character or its chat
          </span>
        </div>
        <button
          onClick={onToggle}
          aria-label="Close whiteboard"
          className="bg-transparent border-0 text-board-ink cursor-pointer text-lg leading-none p-0"
        >
          ×
        </button>
      </div>

      {isAdding && (
        <PinForm
          agents={agents}
          onSave={(pin) => {
            onSave(pin);
            setIsAdding(false);
          }}
          onCancel={() => setIsAdding(false)}
          onUpload={onUpload}
        />
      )}

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-8 p-10">
        {pins.length === 0 && !isAdding && (
          <span className="text-xs text-board-ink-muted">
            Nothing pinned yet. Pin the links, files, snippets and decisions your sessions share.
          </span>
        )}
        {pins.map((pin) => (
          <div
            key={pin.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PIN_DRAG_MIME, pin.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            className={`flex flex-col gap-2 p-8 border-2 border-board-ink shadow-pixel cursor-grab ${PIN_KIND_PAPER[pin.kind]}`}
            data-testid="board-pin"
          >
            <div className="flex justify-between gap-6 text-2xs">
              <span>{PIN_KIND_LABEL[pin.kind]}</span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {pin.scope.length === 0 ? 'ALL' : pin.scope.map(labelFor).join(', ')}
              </span>
            </div>
            <span className="text-sm leading-tight break-words">{pin.title}</span>
            {pin.value && (
              <span className="text-2xs text-board-ink-muted overflow-hidden text-ellipsis whitespace-nowrap">
                {pin.value}
              </span>
            )}
            <PinDetail pin={pin} onSave={onSave} />
            <div className="flex gap-6 justify-end">
              {pin.kind === 'file' && onView && (
                <button
                  onClick={() => onView(pin.id)}
                  className={`px-6 text-2xs ${boardButton}`}
                  data-testid="pin-view"
                >
                  View
                </button>
              )}
              {chatAgentLabel && (
                <button
                  onClick={() => onAttach(pin.id)}
                  className={`px-6 text-2xs ${boardButton}`}
                  title={`Attach to the message for ${chatAgentLabel}`}
                >
                  Attach
                </button>
              )}
              <button
                onClick={() => onRemove(pin.id)}
                className={`px-6 text-2xs ${boardButton}`}
                aria-label={`Remove pin ${pin.title}`}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {!isAdding && (
        <div className="p-10 border-t-2 border-board-edge">
          <button
            onClick={() => setIsAdding(true)}
            className="w-full py-4 text-sm border-2 border-board-ink rounded-none cursor-pointer bg-board-ink text-board shadow-pixel"
            data-testid="board-add"
          >
            + Pin resource
          </button>
        </div>
      )}
    </aside>
  );
}
