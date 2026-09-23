import { useRef, useState } from 'react';

import type { BoardPin, BoardPinKind } from '../../../core/src/messages.js';
import { BOARD_PIN_DETAIL_MAX_CHARS, PIN_DRAG_MIME } from '../constants.js';
import { dragHasFiles, pastedFiles } from '../fileUpload.js';
import { filterPins, newPinId } from '../officeChat.js';
import { tunable } from '../tunableStore.js';
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

/** Upload files one by one as file pins; resolves with the first error, if any. */
async function uploadAll(
  files: File[],
  onUpload: (file: File) => Promise<string | null>,
): Promise<string | null> {
  for (const file of files) {
    const error = await onUpload(file);
    if (error) return error;
  }
  return null;
}

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

  const long = text.length > tunable('boardPinDetailPreviewChars');
  return (
    <div className="flex flex-col gap-2">
      {text && (
        <span
          className="text-2xs leading-tight whitespace-pre-wrap break-words"
          data-testid="pin-detail-text"
        >
          {long && !expanded ? `${text.slice(0, tunable('boardPinDetailPreviewChars'))}…` : text}
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
  initial,
}: {
  agents: AgentOption[];
  onSave: (pin: BoardPin) => void;
  onCancel: () => void;
  onUpload?: (file: File) => Promise<string | null>;
  /** Editing this pin: the form starts from it and saves over it (same id). */
  initial?: BoardPin;
}) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState<BoardPinKind>(initial?.kind ?? 'link');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [value, setValue] = useState(initial?.value ?? '');
  const [detail, setDetail] = useState(initial?.detail ?? '');
  const [scope, setScope] = useState<number[]>(initial?.scope ?? []);
  const multiline = kind === 'snippet' || kind === 'note';
  const canSave = title.trim().length > 0 && (kind === 'note' || value.trim().length > 0);

  const [dropping, setDropping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = (files: File[]) => {
    if (!onUpload || files.length === 0 || uploading) return;
    setUploading(true);
    setUploadError(null);
    void uploadAll(files, onUpload).then((error) => {
      setUploading(false);
      if (error) setUploadError(error);
      else onCancel(); // pinned by the server; close the form
    });
  };

  const toggleScope = (id: number) =>
    setScope((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <form
      aria-label={initial ? `Edit pin ${initial.title}` : 'New pin'}
      className={`flex flex-col gap-6 p-10 ${
        initial ? 'border-2 border-board-ink bg-board shadow-pixel' : 'border-b-2 border-board-edge'
      }`}
      data-testid={initial ? 'pin-edit-form' : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        onSave({
          id: initial?.id ?? newPinId(),
          kind,
          title: title.trim(),
          value: kind === 'snippet' ? value : value.trim(),
          ...(detail.trim() ? { detail: detail.trim() } : {}),
          scope,
          createdAt: initial?.createdAt ?? new Date().toISOString(),
        });
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onCancel();
      }}
      onPaste={(e) => {
        // A pasted file or screenshot becomes a file pin; pasted text stays text.
        if (!onUpload || initial) return;
        const files = pastedFiles(e.clipboardData);
        if (files.length === 0) return;
        e.preventDefault();
        setKind('file');
        upload(files);
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
      {kind === 'file' && onUpload && !initial && (
        <div
          className={`flex flex-col items-center gap-4 p-10 text-2xs text-center border-2 border-dashed ${
            dropping ? 'border-board-ink bg-board-ink text-board' : 'border-board-ink'
          }`}
          onDragOver={(e) => {
            if (!dragHasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropping(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
          }}
          onDrop={(e) => {
            setDropping(false);
            if (!dragHasFiles(e)) return;
            e.preventDefault();
            e.stopPropagation();
            upload(Array.from(e.dataTransfer.files));
          }}
          data-testid="pin-drop"
        >
          <span>Or drop a file here, or paste one (⌘V / Ctrl+V)</span>
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className={`px-8 py-2 text-2xs ${boardButton}`}
          >
            Choose a file…
          </button>
          <span className="text-board-ink-muted">
            PDF, Word, Excel, CSV, text, image · up to 25 MB
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.log,.json,.png,.jpg,.jpeg,.gif,.webp"
            disabled={uploading}
            className="hidden"
            data-testid="pin-upload"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              upload(files);
            }}
          />
          {uploading && <span>Uploading…</span>}
          {uploadError && <span className="text-danger">{uploadError}</span>}
        </div>
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
          {initial ? 'Save' : 'Pin it'}
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
  const [railDrop, setRailDrop] = useState(false);
  const [railUploading, setRailUploading] = useState(false);
  const [railError, setRailError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [full, setFull] = useState(false);
  const labelFor = (id: number) => agents.find((a) => a.id === id)?.label ?? `#${id}`;
  const shown = filterPins(pins, query, labelFor);

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
      className={`absolute flex flex-col bg-board text-board-ink ${
        full ? 'inset-0 z-58' : 'right-0 top-0 bottom-0 z-30 border-l-4 border-board-edge'
      }`}
      style={full ? undefined : { width: `min(${tunable('whiteboardRailWidthPx')}px, 100%)` }}
      data-full={full || undefined}
      data-testid="board-rail"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        if (!onUpload || !dragHasFiles(e)) return;
        e.preventDefault();
        setRailDrop(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRailDrop(false);
      }}
      onDrop={(e) => {
        setRailDrop(false);
        if (!onUpload || !dragHasFiles(e)) return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files);
        setRailError(null);
        setRailUploading(true);
        void uploadAll(files, onUpload).then((error) => {
          setRailUploading(false);
          setRailError(error);
        });
      }}
    >
      {railDrop && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-board border-4 border-dashed border-board-ink text-sm pointer-events-none"
          data-testid="board-drop"
        >
          Drop to pin these files
        </div>
      )}
      <div className="flex items-start gap-8 p-10 border-b-2 border-board-edge">
        <div className="flex flex-col gap-2 flex-1">
          <span className="text-lg leading-none">WHITEBOARD</span>
          <span className="text-2xs text-board-ink-muted">
            Drag a pin onto a character or its chat
            {onUpload ? ' · drop files here to pin them' : ''}
          </span>
        </div>
        <button
          onClick={() => setFull((v) => !v)}
          aria-label={full ? 'Back to the side rail' : 'Open the whiteboard as a full page'}
          title={full ? 'Back to the side rail' : 'Full page'}
          className="bg-transparent border-0 text-board-ink cursor-pointer text-lg leading-none p-0"
          data-testid="board-full"
        >
          {full ? '⇲' : '⤢'}
        </button>
        <button
          onClick={() => {
            setFull(false);
            onToggle();
          }}
          aria-label="Close whiteboard"
          className="bg-transparent border-0 text-board-ink cursor-pointer text-lg leading-none p-0"
        >
          ×
        </button>
      </div>
      {pins.length > 0 && (
        <div className="flex gap-6 items-center px-10 py-6 border-b-2 border-board-edge">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder="Search pins…"
            aria-label="Search pins"
            className={`flex-1 min-w-0 p-4 text-xs bg-board text-board-ink border-2 border-board-ink rounded-none outline-none ${
              full ? 'max-w-480' : ''
            }`}
            data-testid="board-search"
          />
          {query && (
            <span className="text-2xs text-board-ink-muted whitespace-nowrap">
              {shown.length} of {pins.length}
            </span>
          )}
        </div>
      )}

      {(railUploading || railError) && (
        <div className="flex gap-6 px-10 py-4 border-b-2 border-board-edge text-2xs">
          <span className={`flex-1 ${railError ? 'text-danger' : ''}`}>
            {railError ?? 'Uploading…'}
          </span>
          {railError && (
            <button
              className="bg-transparent border-0 p-0 text-board-ink cursor-pointer"
              onClick={() => setRailError(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          )}
        </div>
      )}
      {isAdding && (
        <div className={full ? 'w-full max-w-560 self-center' : ''}>
          <PinForm
            agents={agents}
            onSave={(pin) => {
              onSave(pin);
              setIsAdding(false);
            }}
            onCancel={() => setIsAdding(false)}
            onUpload={onUpload}
          />
        </div>
      )}

      <div
        className={`flex-1 min-h-0 overflow-y-auto p-10 ${
          full
            ? 'grid gap-10 content-start items-start grid-cols-[repeat(auto-fill,minmax(260px,1fr))]'
            : 'flex flex-col gap-8'
        }`}
      >
        {pins.length === 0 && !isAdding && (
          <span className="text-xs text-board-ink-muted">
            Nothing pinned yet. Pin the links, files, snippets and decisions your sessions share.
          </span>
        )}
        {pins.length > 0 && shown.length === 0 && (
          <span className="text-xs text-board-ink-muted">No pin matches “{query.trim()}”.</span>
        )}
        {shown.map((pin) =>
          editingId === pin.id ? (
            <PinForm
              key={pin.id}
              agents={agents}
              initial={pin}
              onSave={(next) => {
                onSave(next);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
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
                <span
                  className={`text-2xs text-board-ink-muted ${
                    full
                      ? 'whitespace-pre-wrap break-words max-h-160 overflow-y-auto'
                      : 'overflow-hidden text-ellipsis whitespace-nowrap'
                  }`}
                >
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
                  onClick={() => setEditingId(pin.id)}
                  className={`px-6 text-2xs ${boardButton}`}
                  aria-label={`Edit pin ${pin.title}`}
                  data-testid="pin-edit"
                >
                  Edit
                </button>
                <button
                  onClick={() => onRemove(pin.id)}
                  className={`px-6 text-2xs ${boardButton}`}
                  aria-label={`Remove pin ${pin.title}`}
                >
                  Remove
                </button>
              </div>
            </div>
          ),
        )}
      </div>

      {!isAdding && (
        <div className={`p-10 border-t-2 border-board-edge ${full ? 'flex justify-center' : ''}`}>
          <button
            onClick={() => setIsAdding(true)}
            className={`py-4 text-sm border-2 border-board-ink rounded-none cursor-pointer bg-board-ink text-board shadow-pixel ${
              full ? 'w-full max-w-560' : 'w-full'
            }`}
            data-testid="board-add"
          >
            + Pin resource
          </button>
        </div>
      )}
    </aside>
  );
}
