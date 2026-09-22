import { useEffect, useRef, useState } from 'react';

import type { BoardPin, FocusRequest } from '../../../core/src/messages.js';
import { BOARD_FILE_API, DOC_NUMBERED_MAX_LINES, DOCX_FRAME_CSS } from '../constants.js';
import type { CellRange, DocRef, SheetView } from '../docViewer.js';
import {
  cellRange,
  columnLetter,
  fileBaseName,
  fileExtension,
  parseCellRef,
  parseCsv,
  refLabel,
  refText,
  spotLabel,
  toSheetView,
  viewerKind,
} from '../docViewer.js';
import { Button } from './ui/Button.js';

interface DocViewerProps {
  pin: BoardPin;
  /** Every file pin, for the list on the left. */
  filePins: BoardPin[];
  onSelect: (pinId: string) => void;
  onClose: () => void;
  /** Attach the open file to the chat that is open; absent when none can take it. */
  onAttach?: () => void;
  /** The "show me" request this file was opened for: where to jump, and why. */
  focus?: FocusRequest;
  /** Label of the agent that asked. */
  focusAgent?: string;
  /** Answer the request ("Got it", or a reply); absent for view-only links. */
  onAnswerFocus?: (reply?: string) => void;
  /** Requests from agents, listed above the board's files. */
  requests?: Array<{ request: FocusRequest; agent: string }>;
  onSelectRequest?: (requestId: string) => void;
  /** Places picked in any file so far (the tray), and what to do with them. */
  refs?: DocRef[];
  onAddRef?: (ref: DocRef) => void;
  onRemoveRef?: (index: number) => void;
  /** Send the tray to an agent's chat; absent when no chat can take it. */
  onAskRefs?: () => void;
  /** Who "Ask about this" goes to ("auth-fix"), for the button. */
  askLabel?: string;
}

type Loaded =
  | { kind: 'pdf' | 'image'; url: string }
  | { kind: 'word'; html: string }
  | { kind: 'table'; sheets: SheetView[] }
  | { kind: 'text'; text: string };

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; doc: Loaded; blob: Blob };

/** The server token this page was opened with (the private link), if any. */
function officeToken(): string | null {
  return new URLSearchParams(window.location.search).get('token');
}

async function loadDocument(pin: BoardPin, signal: AbortSignal): Promise<ViewState> {
  const kind = viewerKind(pin.value);
  if (kind === 'unsupported') {
    return {
      status: 'error',
      message:
        'The viewer opens PDF, Word (.docx), Excel (.xlsx), CSV, text and images. Older .doc and .xls files need saving as .docx or .xlsx first.',
    };
  }
  const token = officeToken();
  if (!token) {
    return {
      status: 'error',
      message:
        'Files only open when the office was opened from your private link (the one with ?token= that pixel-office printed).',
    };
  }
  const res = await fetch(`${BOARD_FILE_API}/${encodeURIComponent(pin.id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { status: 'error', message: body?.error ?? `Could not open the file (${res.status}).` };
  }
  const blob = await res.blob();
  if (kind === 'pdf' || kind === 'image') {
    return { status: 'ready', blob, doc: { kind, url: URL.createObjectURL(blob) } };
  }
  if (kind === 'word') {
    const mammoth = await import('mammoth/mammoth.browser');
    const { value } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
    return { status: 'ready', blob, doc: { kind: 'word', html: value } };
  }
  if (kind === 'sheet') {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const sheets = await readXlsxFile(blob);
    return {
      status: 'ready',
      blob,
      doc: { kind: 'table', sheets: sheets.map((s) => toSheetView(s.sheet, s.data)) },
    };
  }
  const text = await blob.text();
  if (kind === 'csv') {
    return {
      status: 'ready',
      blob,
      doc: { kind: 'table', sheets: [toSheetView(fileBaseName(pin.value), parseCsv(text))] },
    };
  }
  return { status: 'ready', blob, doc: { kind: 'text', text } };
}

function SheetTable({
  sheet,
  mark,
  picked,
  onPick,
}: {
  sheet: SheetView;
  mark?: CellRange | null;
  picked?: { a: { r: number; c: number }; b: { r: number; c: number } } | null;
  onPick?: (cell: { r: number; c: number }, extend: boolean) => void;
}) {
  const columns = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const firstMarked = useRef<HTMLTableCellElement | null>(null);
  useEffect(() => {
    firstMarked.current?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [sheet, mark]);
  const inMark = (r: number, c: number) =>
    !!mark && r >= mark.r0 && r <= mark.r1 && c >= mark.c0 && c <= mark.c1;
  const inPick = (r: number, c: number) =>
    !!picked &&
    r >= Math.min(picked.a.r, picked.b.r) &&
    r <= Math.max(picked.a.r, picked.b.r) &&
    c >= Math.min(picked.a.c, picked.b.c) &&
    c <= Math.max(picked.a.c, picked.b.c);
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex-1 min-h-0 overflow-auto bg-board">
        <table className="border-collapse text-xs text-board-ink">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-2 bg-board border border-board-edge px-6" />
              {Array.from({ length: columns }, (_, i) => (
                <th
                  key={i}
                  className="sticky top-0 z-1 bg-board border border-board-edge px-8 py-2 font-normal"
                >
                  {columnLetter(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r}>
                <th className="sticky left-0 bg-board border border-board-edge px-6 text-right font-normal">
                  {r + 1}
                </th>
                {Array.from({ length: columns }, (_, c) => {
                  const marked = inMark(r, c);
                  const isPicked = inPick(r, c);
                  return (
                    <td
                      key={c}
                      ref={marked && r === mark?.r0 && c === mark.c0 ? firstMarked : undefined}
                      onClick={(e) => onPick?.({ r, c }, e.shiftKey)}
                      className={`border px-8 py-2 whitespace-nowrap cursor-cell ${
                        isPicked
                          ? 'bg-doc-pick border-status-active'
                          : marked
                            ? 'bg-doc-mark border-accent'
                            : 'border-board-edge'
                      }`}
                    >
                      {row[c] ?? ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-10 py-4 text-2xs text-text-muted border-t-2 border-border">
        {sheet.rows.length < sheet.totalRows
          ? `Showing ${sheet.rows.length.toLocaleString()} of ${sheet.totalRows.toLocaleString()} rows`
          : `${sheet.totalRows.toLocaleString()} rows`}{' '}
        · values only, no formulas or charts
      </div>
    </div>
  );
}

/** Text with line numbers; the marked lines are highlighted and scrolled to. */
function NumberedText({
  text,
  from,
  to,
  picked,
  onPick,
}: {
  text: string;
  from?: number;
  to?: number;
  /** Lines the user picked (a range), drawn apart from an agent's mark. */
  picked?: { a: number; b: number } | null;
  onPick?: (line: number, extend: boolean) => void;
}) {
  const lines = text.split(/\r?\n/);
  const firstMarked = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    firstMarked.current?.scrollIntoView({ block: 'center' });
  }, [text, from]);
  if (lines.length > DOC_NUMBERED_MAX_LINES && from === undefined) {
    return (
      <pre className="flex-1 min-h-0 overflow-auto m-0 p-16 bg-board text-board-ink text-xs whitespace-pre-wrap break-words">
        {text}
      </pre>
    );
  }
  // A huge file shows a window around the marked lines instead of every line.
  const start = lines.length > DOC_NUMBERED_MAX_LINES && from ? Math.max(1, from - 200) : 1;
  const end = Math.min(lines.length, start + DOC_NUMBERED_MAX_LINES - 1);
  const shown = lines.slice(start - 1, end);
  return (
    <div
      className="flex-1 min-h-0 overflow-auto bg-board text-board-ink text-xs py-8"
      data-testid="doc-text"
    >
      {start > 1 && (
        <div className="px-16 text-2xs text-board-ink-muted">Lines before {start} not shown</div>
      )}
      {shown.map((line, i) => {
        const n = start + i;
        const marked = from !== undefined && n >= from && n <= (to ?? from);
        const isPicked =
          !!picked && n >= Math.min(picked.a, picked.b) && n <= Math.max(picked.a, picked.b);
        return (
          <div
            key={n}
            ref={marked && n === from ? firstMarked : undefined}
            className={`grid grid-cols-[52px_1fr] pr-16 border-l-4 ${
              isPicked
                ? 'bg-doc-pick border-status-active'
                : marked
                  ? 'bg-doc-mark border-accent'
                  : 'border-transparent'
            }`}
            data-marked={marked || undefined}
          >
            <button
              className="text-right pr-12 text-board-ink-muted select-none bg-transparent border-0 p-0 cursor-pointer text-xs hover:text-board-ink"
              onClick={(e) => onPick?.(n, e.shiftKey)}
              title="Pick this line (Shift-click for a range)"
            >
              {n}
            </button>
            <span className="whitespace-pre-wrap break-words">{line || ' '}</span>
          </div>
        );
      })}
      {end < lines.length && (
        <div className="px-16 text-2xs text-board-ink-muted">Lines after {end} not shown</div>
      )}
    </div>
  );
}

/** Why the agent wants the user to look, with "Got it" / "Reply". */
function FocusBanner({
  focus,
  agent,
  onAnswer,
}: {
  focus: FocusRequest;
  agent: string;
  onAnswer?: (reply?: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => {
    setReplying(false);
    setText('');
  }, [focus.requestId]);
  const waiting = focus.state === 'waiting';
  const spot = spotLabel(focus);
  return (
    <div
      className={`flex flex-col gap-6 px-12 py-8 border-b-2 ${
        waiting ? 'bg-chat-permission border-status-permission' : 'bg-bg border-border'
      }`}
      data-testid="doc-focus"
    >
      <div className="text-sm">
        <span className="text-status-success">{agent}</span>
        {spot && <span className="text-text-muted"> · {spot}</span>}
        {focus.why ? (
          <span>: {focus.why}</span>
        ) : (
          <span className="text-text-muted"> wants you to look</span>
        )}
      </div>
      {!waiting && (
        <span className="text-2xs text-status-success">
          ✓ Seen{focus.reply ? ` · you replied: ${focus.reply}` : ''}
        </span>
      )}
      {waiting && onAnswer && !replying && (
        <div className="flex gap-6">
          <Button variant="accent" size="sm" onClick={() => onAnswer()} data-testid="doc-focus-ack">
            Got it
          </Button>
          <Button size="sm" onClick={() => setReplying(true)}>
            Reply…
          </Button>
        </div>
      )}
      {waiting && onAnswer && replying && (
        <form
          className="flex gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(text.trim());
          }}
        >
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') setReplying(false);
            }}
            placeholder={`Answer ${agent}`}
            className="flex-1 min-w-0 bg-bg-dark border-2 border-accent px-6 py-2 text-sm text-text"
            data-testid="doc-focus-reply"
          />
          <Button variant="accent" size="sm" type="submit">
            Send
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * Opens a whiteboard file pin inside the office: PDF and images natively,
 * Word via mammoth (rendered in a sandboxed frame — document HTML never runs
 * in the office page), Excel/CSV as a table, text as text. Libraries load
 * only when a document of that type is opened.
 */
export function DocViewer({
  pin,
  filePins,
  onSelect,
  onClose,
  onAttach,
  focus,
  focusAgent,
  onAnswerFocus,
  requests = [],
  onSelectRequest,
  refs = [],
  onAddRef,
  onRemoveRef,
  onAskRefs,
  askLabel,
}: DocViewerProps) {
  const [pickedLines, setPickedLines] = useState<{ a: number; b: number } | null>(null);
  const [pickedCells, setPickedCells] = useState<{
    a: { r: number; c: number };
    b: { r: number; c: number };
  } | null>(null);
  const [pdfPage, setPdfPage] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setPickedLines(null);
    setPickedCells(null);
    setPdfPage(focus?.page ? String(focus.page) : '');
  }, [pin, focus?.page]);
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [sheetIndex, setSheetIndex] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: 'loading' });
    setSheetIndex(0);
    loadDocument(pin, abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return;
        if (next.status === 'ready' && 'url' in next.doc) objectUrl = next.doc.url;
        setState(next);
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        console.error('[Webview] Document viewer failed:', err);
        setState({ status: 'error', message: 'Could not read this file.' });
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pin]);

  const download = () => {
    if (state.status !== 'ready') return;
    const url = URL.createObjectURL(state.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileBaseName(pin.value);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const doc = state.status === 'ready' ? state.doc : null;
  const mark = focus?.cell ? parseCellRef(focus.cell) : null;
  const sheetName =
    doc?.kind === 'table' && doc.sheets.length > 1 ? doc.sheets[sheetIndex]?.name : undefined;
  const current: DocRef | null =
    doc?.kind === 'text' && pickedLines
      ? {
          path: pin.value,
          lineStart: Math.min(pickedLines.a, pickedLines.b),
          lineEnd: Math.max(pickedLines.a, pickedLines.b),
        }
      : doc?.kind === 'table' && pickedCells
        ? { path: pin.value, cell: cellRange(pickedCells.a, pickedCells.b, sheetName) }
        : doc?.kind === 'pdf' && Number(pdfPage) > 0
          ? { path: pin.value, page: Number(pdfPage) }
          : doc && doc.kind !== 'text' && doc.kind !== 'table' && doc.kind !== 'pdf'
            ? { path: pin.value }
            : null;

  // A request naming a sheet opens on that sheet.
  useEffect(() => {
    if (doc?.kind !== 'table' || !mark?.sheet) return;
    const wanted = mark.sheet.toLowerCase();
    const index = doc.sheets.findIndex((sheet) => sheet.name.toLowerCase() === wanted);
    if (index !== -1) setSheetIndex(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per document / request
  }, [doc, focus?.requestId]);

  return (
    <div
      role="dialog"
      aria-label={`Document: ${pin.title}`}
      className="absolute inset-0 z-60 flex flex-col bg-bg"
      data-testid="doc-viewer"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-8 px-10 py-6 border-b-2 border-border flex-wrap">
        <span className="px-6 text-2xs bg-accent text-white uppercase">
          {fileExtension(pin.value) || 'file'}
        </span>
        <span className="text-base overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
          {pin.title}
        </span>
        <span className="flex-1" />
        {onAttach && (
          <Button variant="accent" size="md" onClick={onAttach} data-testid="doc-attach">
            Attach to chat
          </Button>
        )}
        <Button size="md" onClick={download} disabled={state.status !== 'ready'}>
          Download
        </Button>
        <Button size="md" onClick={onClose} aria-label="Close viewer" autoFocus>
          ×
        </Button>
      </div>

      <div className="flex-1 min-h-0 flex">
        {(filePins.length > 1 || requests.length > 0) && (
          <nav
            aria-label="Files on the board"
            className="hidden sm:flex flex-col gap-4 w-260 p-8 bg-bg-dark border-r-2 border-border overflow-y-auto"
          >
            {requests.length > 0 && (
              <>
                <span className="text-sm">Asked by agents</span>
                {requests.map(({ request, agent }) => (
                  <button
                    key={request.requestId}
                    onClick={() => onSelectRequest?.(request.requestId)}
                    className={`text-left px-6 py-4 border-2 rounded-none cursor-pointer text-xs text-text ${
                      request.requestId === focus?.requestId
                        ? 'bg-active-bg border-accent'
                        : 'bg-btn-bg border-transparent'
                    }`}
                    data-testid="doc-request"
                  >
                    <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
                      {request.state === 'waiting' && (
                        <span className="text-status-permission mr-4">●</span>
                      )}
                      {fileBaseName(request.path)}
                    </span>
                    <span className="block text-2xs text-text-muted">
                      {agent}
                      {spotLabel(request) ? ` · ${spotLabel(request)}` : ''}
                    </span>
                  </button>
                ))}
              </>
            )}
            <span className="text-sm">Files on the board</span>
            {filePins.map((p) => (
              <button
                key={p.id}
                onClick={() => onSelect(p.id)}
                className={`text-left px-6 py-4 border-2 rounded-none cursor-pointer text-xs text-text overflow-hidden text-ellipsis whitespace-nowrap ${
                  p.id === pin.id ? 'bg-active-bg border-accent' : 'bg-btn-bg border-transparent'
                }`}
              >
                <span className="text-2xs text-text-muted uppercase mr-6">
                  {fileExtension(p.value)}
                </span>
                {p.title}
              </button>
            ))}
          </nav>
        )}

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {focus && (
            <FocusBanner focus={focus} agent={focusAgent ?? 'An agent'} onAnswer={onAnswerFocus} />
          )}
          {state.status === 'loading' && (
            <div className="m-auto text-sm text-text-muted">Opening…</div>
          )}
          {state.status === 'error' && (
            <div className="m-auto max-w-md p-16 pixel-panel text-sm" data-testid="doc-error">
              {state.message}
            </div>
          )}
          {doc?.kind === 'pdf' && (
            <iframe
              title={pin.title}
              src={focus?.page ? `${doc.url}#page=${focus.page}` : doc.url}
              className="flex-1 w-full border-0 bg-board"
            />
          )}
          {doc?.kind === 'image' && (
            <div className="flex-1 min-h-0 overflow-auto flex bg-bg-dark">
              <img src={doc.url} alt={pin.title} className="m-auto max-w-full" />
            </div>
          )}
          {doc?.kind === 'word' && (
            <iframe
              title={pin.title}
              sandbox=""
              srcDoc={`<!doctype html><meta charset="utf-8"><style>${DOCX_FRAME_CSS}</style>${doc.html}`}
              className="flex-1 w-full border-0 bg-board"
            />
          )}
          {doc?.kind === 'text' && (
            <NumberedText
              text={doc.text}
              from={focus?.lineStart}
              to={focus?.lineEnd}
              picked={pickedLines}
              onPick={(n, extend) =>
                setPickedLines((prev) => (extend && prev ? { a: prev.a, b: n } : { a: n, b: n }))
              }
            />
          )}
          {doc?.kind === 'table' && (
            <>
              {doc.sheets.length > 1 && (
                <div role="tablist" className="flex bg-bg-dark border-b-2 border-border">
                  {doc.sheets.map((s, i) => (
                    <button
                      key={s.name}
                      role="tab"
                      aria-selected={i === sheetIndex}
                      onClick={() => setSheetIndex(i)}
                      className={`px-12 py-6 text-sm border-0 border-b-4 rounded-none cursor-pointer ${
                        i === sheetIndex
                          ? 'bg-bg text-text border-accent'
                          : 'bg-bg-dark text-text-muted border-transparent'
                      }`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              {doc.sheets[sheetIndex] && (
                <SheetTable
                  sheet={doc.sheets[sheetIndex]}
                  picked={pickedCells}
                  onPick={(cell, extend) =>
                    setPickedCells((prev) =>
                      extend && prev ? { a: prev.a, b: cell } : { a: cell, b: cell },
                    )
                  }
                  mark={
                    mark &&
                    (!mark.sheet ||
                      mark.sheet.toLowerCase() === doc.sheets[sheetIndex].name.toLowerCase())
                      ? mark
                      : null
                  }
                />
              )}
            </>
          )}
          {(onAddRef || refs.length > 0) && state.status === 'ready' && (
            <div
              className="flex flex-col gap-4 px-10 py-6 border-t-2 border-border bg-bg-dark"
              data-testid="doc-pick-bar"
            >
              <div className="flex items-center gap-6 flex-wrap text-xs">
                {current ? (
                  <>
                    <span className="text-status-active">{refLabel(current)}</span>
                    {onAddRef && (
                      <Button
                        size="sm"
                        onClick={() => onAddRef(current)}
                        data-testid="doc-pick-add"
                      >
                        Add to selection
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(refText(current))
                          .then(() => setCopied(true));
                        setTimeout(() => setCopied(false), 1_500);
                      }}
                    >
                      {copied ? 'Copied' : 'Copy reference'}
                    </Button>
                  </>
                ) : (
                  <span className="text-text-muted">
                    {doc?.kind === 'text'
                      ? 'Click a line number to pick it; Shift-click another for a range.'
                      : doc?.kind === 'table'
                        ? 'Click a cell to pick it; Shift-click another for a range.'
                        : doc?.kind === 'pdf'
                          ? 'Type the page to point at.'
                          : 'Point at this whole file.'}
                  </span>
                )}
                {doc?.kind === 'pdf' && (
                  <input
                    value={pdfPage}
                    onChange={(e) => setPdfPage(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="page"
                    className="w-60 bg-bg border-2 border-border px-4 py-1 text-xs text-text"
                  />
                )}
                <span className="flex-1" />
                {onAskRefs && (refs.length > 0 || current) && (
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={() => {
                      if (current && onAddRef && !refs.some((r) => refText(r) === refText(current)))
                        onAddRef(current);
                      onAskRefs();
                    }}
                    data-testid="doc-pick-ask"
                  >
                    Ask {askLabel ?? 'the agent'} about this
                  </Button>
                )}
              </div>
              {refs.length > 0 && (
                <div className="flex gap-4 flex-wrap">
                  {refs.map((r, i) => (
                    <span
                      key={`${refText(r)}-${i}`}
                      className="flex items-center gap-4 px-6 py-1 bg-active-bg border-2 border-accent text-2xs font-mono"
                    >
                      {refLabel(r)}
                      {onRemoveRef && (
                        <button
                          className="bg-transparent border-0 p-0 text-text-muted cursor-pointer"
                          onClick={() => onRemoveRef(i)}
                          aria-label={`Remove ${refLabel(r)}`}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  ))}
                  <span className="text-2xs text-text-muted self-center">
                    Only the path and place are sent, never the text.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
