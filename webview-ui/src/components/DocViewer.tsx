import { useEffect, useRef, useState } from 'react';

import type { DocEdit, DocModel, DocSheet, DocSlide } from '../../../core/src/docModel.js';
import type {
  BoardPin,
  ChatEntry,
  FocusRequest,
  ProposalHunk,
} from '../../../core/src/messages.js';
import type { AskAgent } from '../askAgent.js';
import { BOARD_FILE_API } from '../constants.js';
import { cellSuggestion, hunkTexts, placeSuggestions } from '../docSuggestions.js';
import type { CellRange, DocRef, SheetView } from '../docViewer.js';
import {
  cellEditText,
  cellRange,
  columnLetter,
  fileBaseName,
  fileExtension,
  isTextEditableName,
  mergeDocEdit,
  modelSheetGrid,
  modelSheetView,
  parseCellRef,
  parseCsv,
  refLabel,
  refText,
  spotLabel,
  toSheetView,
  viewerKind,
} from '../docViewer.js';
import { transport } from '../transport/index.js';
import { tunable } from '../tunableStore.js';
import { DocChatPanel } from './DocChatPanel.js';
import { SlidesView, WordParagraphs } from './DocModelViews.js';
import type { DocSuggestionProps } from './DocSuggestions.js';
import { SuggestionBar, SuggestionCard } from './DocSuggestions.js';
import { Button } from './ui/Button.js';
import { WordDocumentView } from './WordDocumentView.js';

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
  /** The newest edit written to this file (anyone's): the viewer reloads when it changes. */
  lastEditKey?: string;
  /** Open another document (the Open file dialog); absent when this viewer can't. */
  onOpenFile?: () => void;
  /** Delete the office's stored copy of an uploaded file (and its pin); absent otherwise. */
  onDeleteFile?: () => void;
  /** An agent's open suggestion for this file, shown in the document (not a separate review). */
  suggestion?: DocSuggestionProps;
  /** The last suggestion applied to this file, while it can still be undone. */
  appliedSuggestion?: { note: string; onUndo: () => void };
  /** Talk to an agent about this file beside it (Agent chat); absent when nobody can be asked. */
  ask?: {
    agents: AskAgent[];
    /** An agent's chat thread. */
    entriesFor: (agentId: number) => ChatEntry[];
    preferred?: number | null;
    canStartAgent: boolean;
    onSend: (agentId: number, text: string) => void;
    onOpenChat: (agentId: number) => void;
    /** The question went out: the picked places are used up. */
    onClearRefs: () => void;
  };
}

type Loaded =
  | { kind: 'pdf' | 'image'; url: string }
  | { kind: 'word'; paragraphs?: Extract<DocModel, { kind: 'docx' }>['paragraphs'] }
  | { kind: 'slides'; slides: DocSlide[] }
  | { kind: 'table'; sheets: SheetView[]; model?: DocSheet[]; raw?: string }
  | { kind: 'text'; text: string };

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; doc: Loaded; blob: Blob; sha?: string };

/** The server token this page was opened with (the private link), if any. */
function officeToken(): string | null {
  return new URLSearchParams(window.location.search).get('token');
}

/** The office's numbered model of a Word / PowerPoint / Excel file, and the hash edits go against. */
async function loadModel(
  pin: BoardPin,
  token: string,
  signal: AbortSignal,
): Promise<{ sha: string; model: DocModel } | null> {
  try {
    const res = await fetch(`${BOARD_FILE_API}/${encodeURIComponent(pin.id)}/model`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as { sha: string; model: DocModel };
  } catch {
    return null; // an older office, or a file the parser can't read: view without places
  }
}

/** sha256 of the bytes, when the browser can (secure contexts only). */
async function hashOf(blob: Blob): Promise<string | undefined> {
  try {
    if (!globalThis.crypto?.subtle) return undefined;
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

async function loadDocument(pin: BoardPin, signal: AbortSignal): Promise<ViewState> {
  const kind = viewerKind(pin.value);
  if (kind === 'unsupported') {
    return {
      status: 'error',
      message:
        'The viewer opens PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), CSV, text and images. Older .doc, .ppt and .xls files need saving as .docx, .pptx or .xlsx first.',
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
    // Drawn by WordDocumentView from the blob; the model gives the ¶ numbers.
    const loaded = await loadModel(pin, token, signal);
    const paragraphs = loaded?.model.kind === 'docx' ? loaded.model.paragraphs : undefined;
    return {
      status: 'ready',
      blob,
      sha: loaded?.sha,
      doc: { kind: 'word', ...(paragraphs ? { paragraphs } : {}) },
    };
  }
  if (kind === 'slides') {
    const loaded = await loadModel(pin, token, signal);
    if (loaded?.model.kind !== 'pptx') {
      return { status: 'error', message: 'Could not read this presentation.' };
    }
    return {
      status: 'ready',
      blob,
      sha: loaded.sha,
      doc: { kind: 'slides', slides: loaded.model.slides },
    };
  }
  if (kind === 'sheet') {
    const loaded = await loadModel(pin, token, signal);
    if (loaded?.model.kind === 'xlsx') {
      const model = loaded.model.sheets;
      return {
        status: 'ready',
        blob,
        sha: loaded.sha,
        doc: { kind: 'table', sheets: model.map((s) => modelSheetView(s)), model },
      };
    }
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    const sheets = await readXlsxFile(blob);
    return {
      status: 'ready',
      blob,
      doc: { kind: 'table', sheets: sheets.map((s) => toSheetView(s.sheet, s.data)) },
    };
  }
  const text = await blob.text();
  const sha = await hashOf(blob);
  if (kind === 'csv') {
    return {
      status: 'ready',
      blob,
      sha,
      doc: {
        kind: 'table',
        sheets: [toSheetView(fileBaseName(pin.value), parseCsv(text))],
        raw: text,
      },
    };
  }
  return { status: 'ready', blob, sha, doc: { kind: 'text', text } };
}

function SheetTable({
  sheet,
  mark,
  picked,
  onPick,
  suggestedAt,
}: {
  sheet: SheetView;
  mark?: CellRange | null;
  picked?: { a: { r: number; c: number }; b: { r: number; c: number } } | null;
  onPick?: (cell: { r: number; c: number }, extend: boolean) => void;
  /** An agent's suggested value for a cell, if any. */
  suggestedAt?: (r: number, c: number) => ProposalHunk | undefined;
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
                  const suggested = suggestedAt?.(r, c);
                  const next = suggested && hunkTexts(suggested);
                  return (
                    <td
                      key={c}
                      ref={marked && r === mark?.r0 && c === mark.c0 ? firstMarked : undefined}
                      onClick={(e) => onPick?.({ r, c }, e.shiftKey)}
                      title={
                        next
                          ? `Suggested: ${next.before || '(empty)'} → ${next.after || '(empty)'}`
                          : undefined
                      }
                      className={`border px-8 py-2 whitespace-nowrap cursor-cell ${
                        suggested && suggested.decision !== 'rejected'
                          ? 'bg-diff-add border-pin-note'
                          : isPicked
                            ? 'bg-doc-pick border-status-active'
                            : marked
                              ? 'bg-doc-mark border-accent'
                              : 'border-board-edge'
                      }`}
                    >
                      {next && suggested?.decision !== 'rejected' ? (
                        <>
                          <span className="line-through decoration-danger opacity-60 mr-6">
                            {row[c] ?? ''}
                          </span>
                          {next.after}
                        </>
                      ) : (
                        (row[c] ?? '')
                      )}
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
  if (lines.length > tunable('docNumberedMaxLines') && from === undefined) {
    return (
      <pre className="flex-1 min-h-0 overflow-auto m-0 p-16 bg-board text-board-ink text-code whitespace-pre-wrap break-words">
        {text}
      </pre>
    );
  }
  // A huge file shows a window around the marked lines instead of every line.
  const start = lines.length > tunable('docNumberedMaxLines') && from ? Math.max(1, from - 200) : 1;
  const end = Math.min(lines.length, start + tunable('docNumberedMaxLines') - 1);
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
 * Word laid out like Word by docx-preview (in a frame that runs no scripts — nothing in the document runs
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
  lastEditKey,
  onOpenFile,
  onDeleteFile,
  ask,
  suggestion,
  appliedSuggestion,
}: DocViewerProps) {
  const placed = placeSuggestions(suggestion?.proposal);
  const inPlace = suggestion
    ? { placed, canDecide: suggestion.canDecide, onDecide: suggestion.onDecide }
    : undefined;
  const [unplaced, setUnplaced] = useState(0);
  const [showAsk, setShowAsk] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [pin]);
  const [pickedLines, setPickedLines] = useState<{ a: number; b: number } | null>(null);
  const [pickedCells, setPickedCells] = useState<{
    a: { r: number; c: number };
    b: { r: number; c: number };
  } | null>(null);
  const [pdfPage, setPdfPage] = useState('');
  const [copied, setCopied] = useState(false);
  const [pickedParas, setPickedParas] = useState<{ a: number; b: number } | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [pickedShape, setPickedShape] = useState<string | null>(null);
  const [wordView, setWordView] = useState<'document' | 'places'>('document');
  // Editing: staged edits (Word / PowerPoint / Excel) or a text draft, saved in one go.
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<DocEdit[]>([]);
  const [textDraft, setTextDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [changedUnderUs, setChangedUnderUs] = useState(false);
  useEffect(() => {
    setPickedLines(null);
    setPickedCells(null);
    setPickedParas(null);
    setPickedShape(null);
    setPdfPage(focus?.page ? String(focus.page) : '');
  }, [pin, focus?.page]);
  useEffect(() => {
    setEditing(false);
    setEdits([]);
    setTextDraft(null);
    setSaveError(null);
    setSaved(null);
    setChangedUnderUs(false);
    setSlideIndex(0);
  }, [pin]);
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [sheetIndex, setSheetIndex] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    setState((prev) => (prev.status === 'ready' && reloadKey > 0 ? prev : { status: 'loading' }));
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
  }, [pin, reloadKey]);
  useEffect(() => setSheetIndex(0), [pin]);

  const dirty = edits.length > 0 || textDraft !== null;
  // Someone wrote to this file (an agent, an Undo, another window): show the new version,
  // unless the human is mid-edit — then say so and let them decide.
  const seenEditKey = useRef(lastEditKey);
  useEffect(() => {
    if (lastEditKey === seenEditKey.current) return;
    seenEditKey.current = lastEditKey;
    if (dirty) setChangedUnderUs(true);
    else setReloadKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new edit reloads
  }, [lastEditKey]);

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
  const wordParagraphs = doc?.kind === 'word' ? doc.paragraphs : undefined;
  // The Paragraphs list: always while editing, else when the user picks that tab.
  const paragraphs =
    wordParagraphs && (wordView === 'places' || editing) ? wordParagraphs : undefined;
  const slide = doc?.kind === 'slides' ? doc.slides[slideIndex] : undefined;
  const current: DocRef | null =
    wordParagraphs && pickedParas
      ? {
          path: pin.value,
          paraStart: Math.min(pickedParas.a, pickedParas.b),
          paraEnd: Math.max(pickedParas.a, pickedParas.b),
        }
      : slide
        ? { path: pin.value, slide: slide.n, ...(pickedShape ? { shape: pickedShape } : {}) }
        : doc?.kind === 'text' && pickedLines
          ? {
              path: pin.value,
              lineStart: Math.min(pickedLines.a, pickedLines.b),
              lineEnd: Math.max(pickedLines.a, pickedLines.b),
            }
          : doc?.kind === 'table' && pickedCells
            ? { path: pin.value, cell: cellRange(pickedCells.a, pickedCells.b, sheetName) }
            : doc?.kind === 'pdf' && Number(pdfPage) > 0
              ? { path: pin.value, page: Number(pdfPage) }
              : doc &&
                  doc.kind !== 'text' &&
                  doc.kind !== 'table' &&
                  doc.kind !== 'pdf' &&
                  !wordParagraphs
                ? { path: pin.value }
                : null;

  // A suggestion opens on the slide / sheet its first change is on.
  const suggestionId = suggestion?.proposal.proposalId;
  useEffect(() => {
    const first = suggestion?.proposal.hunks.find((h) => h.place)?.place;
    if (!first) return;
    if (doc?.kind === 'slides' && first.slide !== undefined) {
      const index = doc.slides.findIndex((sl) => sl.n === first.slide);
      if (index !== -1) setSlideIndex(index);
    }
    if (doc?.kind === 'table' && first.sheet) {
      const index = doc.sheets.findIndex(
        (sh) => sh.name.toLowerCase() === first.sheet!.toLowerCase(),
      );
      if (index !== -1) setSheetIndex(index);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per document / suggestion
  }, [doc, suggestionId]);

  // A request naming a slide (--page) opens on it.
  useEffect(() => {
    if (doc?.kind !== 'slides' || !focus?.page) return;
    const index = doc.slides.findIndex((s) => s.n === focus.page);
    if (index !== -1) setSlideIndex(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per document / request
  }, [doc, focus?.requestId]);

  const token = officeToken();
  const textSource =
    doc?.kind === 'text'
      ? doc.text
      : doc?.kind === 'table' && doc.raw !== undefined
        ? doc.raw
        : null;
  const modelSheets = doc?.kind === 'table' ? doc.model : undefined;
  const canEdit =
    !!token &&
    state.status === 'ready' &&
    ((doc?.kind === 'word' && !!doc.paragraphs) ||
      doc?.kind === 'slides' ||
      !!modelSheets ||
      (textSource !== null && isTextEditableName(pin.value)));
  const stage = (edit: DocEdit) => setEdits((list) => mergeDocEdit(list, edit));
  const startEditing = () => {
    setSaved(null);
    setSaveError(null);
    setEditing(true);
    if (textSource !== null && !modelSheets && doc?.kind !== 'word') setTextDraft(textSource);
  };
  const stopEditing = () => {
    setEditing(false);
    setEdits([]);
    setTextDraft(null);
    setSaveError(null);
    if (changedUnderUs) {
      setChangedUnderUs(false);
      setReloadKey((k) => k + 1);
    }
  };
  const save = async () => {
    if (!token || state.status !== 'ready') return;
    const body =
      textDraft !== null
        ? { sha: state.sha, text: textDraft }
        : {
            sha: state.sha,
            edits: edits.filter((e) => e.kind !== 'insertAfter' || e.text.trim() !== ''),
          };
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`${BOARD_FILE_API}/${encodeURIComponent(pin.id)}/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const reply = (await res.json().catch(() => null)) as {
        error?: string;
        edit?: { editId: string };
      } | null;
      if (!res.ok || !reply?.edit) {
        setSaveError(reply?.error ?? `Could not save (${res.status}).`);
        return;
      }
      seenEditKey.current = `${reply.edit.editId}:false`;
      setSaved(reply.edit.editId);
      setEditing(false);
      setEdits([]);
      setTextDraft(null);
      setChangedUnderUs(false);
      setReloadKey((k) => k + 1);
    } catch {
      setSaveError('Could not reach the office to save.');
    } finally {
      setSaving(false);
    }
  };
  // The cell picked for editing (one cell, the first of a picked range).
  const editCell =
    editing && modelSheets && pickedCells
      ? {
          sheet: modelSheets[sheetIndex]?.name,
          ref: cellRange(pickedCells.a, pickedCells.a),
          grid: modelSheets[sheetIndex] ? modelSheetGrid(modelSheets[sheetIndex]) : null,
        }
      : null;
  const editCellValue = (() => {
    if (!editCell) return '';
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      if (e.kind === 'cell' && e.ref === editCell.ref && (e.sheet ?? '') === (editCell.sheet ?? ''))
        return e.value;
    }
    return cellEditText(editCell.grid?.rows[pickedCells!.a.r]?.[pickedCells!.a.c]);
  })();

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
        {ask && (
          <Button
            size="md"
            variant={showAsk ? 'active' : 'accent'}
            onClick={() => setShowAsk((v) => !v)}
            title="Talk to an agent about this file, beside it"
            data-testid="doc-ask-agent"
          >
            Agent chat
          </Button>
        )}
        {onDeleteFile &&
          (confirmDelete ? (
            <>
              <span className="text-xs text-danger">Delete the office&apos;s copy?</span>
              <Button
                size="md"
                className="text-danger"
                onClick={onDeleteFile}
                data-testid="doc-delete-yes"
              >
                Delete
              </Button>
              <Button size="md" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button
              size="md"
              onClick={() => setConfirmDelete(true)}
              title="This is a copy the office stored when it was uploaded. Your original is not touched."
              data-testid="doc-delete"
            >
              Delete file
            </Button>
          ))}
        {onOpenFile && (
          <Button size="md" onClick={onOpenFile} data-testid="doc-open-file">
            Open file…
          </Button>
        )}
        {canEdit && !editing && (
          <Button size="md" onClick={startEditing} data-testid="doc-edit">
            Edit
          </Button>
        )}
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
          {suggestion && !editing && <SuggestionBar {...suggestion} />}
          {!suggestion && appliedSuggestion && !editing && (
            <div className="flex items-center gap-8 px-12 py-4 text-xs bg-bg-dark border-b-2 border-border">
              <span className="flex-1 text-status-success">{appliedSuggestion.note}</span>
              <Button
                size="sm"
                onClick={appliedSuggestion.onUndo}
                data-testid="doc-suggestion-undo"
              >
                Undo
              </Button>
            </div>
          )}
          {suggestion && unplaced > 0 && !paragraphs && doc?.kind === 'word' && (
            <div className="px-12 py-4 text-xs text-status-permission bg-bg-dark border-b-2 border-border">
              {unplaced} change{unplaced === 1 ? '' : 's'} could not be placed on the page — see the
              Paragraphs tab.
            </div>
          )}
          {(editing || saved || saveError || changedUnderUs) && (
            <div
              className={`flex items-center gap-8 flex-wrap px-10 py-6 border-b-2 text-xs ${
                editing ? 'bg-chat-permission border-status-permission' : 'bg-bg-dark border-border'
              }`}
              data-testid="doc-edit-bar"
            >
              {editing ? (
                <span className="flex-1 min-w-0">
                  {textDraft !== null
                    ? 'Editing the text.'
                    : doc?.kind === 'word'
                      ? 'Click a paragraph to change its text.'
                      : doc?.kind === 'slides'
                        ? 'Click a text box to change it.'
                        : 'Pick a cell, then type its value or a formula (=SUM(A1:A3)).'}{' '}
                  {edits.length > 0 &&
                    `${edits.length} change${edits.length === 1 ? '' : 's'} not saved.`}{' '}
                  <span className="text-text-muted">
                    Formatting outside the changed text is kept; a backup is saved.
                  </span>
                </span>
              ) : (
                <span className="flex-1 min-w-0">
                  {saved && !saveError && <span className="text-status-success">Saved. </span>}
                  {changedUnderUs && (
                    <span className="text-status-permission">
                      Someone else changed this file while you were editing.{' '}
                    </span>
                  )}
                </span>
              )}
              {saveError && <span className="text-danger">{saveError}</span>}
              {editing && (
                <>
                  <Button
                    size="sm"
                    variant="accent"
                    onClick={() => void save()}
                    disabled={saving || !dirty}
                    data-testid="doc-save"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                  <Button size="sm" onClick={stopEditing}>
                    Cancel
                  </Button>
                </>
              )}
              {!editing && saved && (
                <Button
                  size="sm"
                  onClick={() => {
                    transport.send({ type: 'undoDocEdit', editId: saved });
                    setSaved(null);
                  }}
                  data-testid="doc-undo"
                >
                  Undo
                </Button>
              )}
              {!editing && changedUnderUs && (
                <Button
                  size="sm"
                  onClick={() => {
                    setChangedUnderUs(false);
                    setReloadKey((k) => k + 1);
                  }}
                >
                  Reload
                </Button>
              )}
            </div>
          )}
          {doc?.kind === 'word' && doc.paragraphs && !editing && (
            <div role="tablist" className="flex bg-bg-dark border-b-2 border-border text-sm">
              {(['document', 'places'] as const).map((v) => (
                <button
                  key={v}
                  role="tab"
                  aria-selected={wordView === v}
                  onClick={() => setWordView(v)}
                  className={`px-12 py-4 border-0 border-b-4 rounded-none cursor-pointer ${
                    wordView === v
                      ? 'bg-bg text-text border-accent'
                      : 'bg-bg-dark text-text-muted border-transparent'
                  }`}
                >
                  {v === 'places' ? 'Paragraphs' : 'Document'}
                </button>
              ))}
            </div>
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
          {paragraphs && (
            <WordParagraphs
              paragraphs={paragraphs}
              mark={
                focus?.lineStart
                  ? { from: focus.lineStart, to: focus.lineEnd ?? focus.lineStart }
                  : null
              }
              picked={pickedParas}
              onPick={(n, extend) =>
                setPickedParas((prev) => (extend && prev ? { a: prev.a, b: n } : { a: n, b: n }))
              }
              editing={editing}
              edits={edits}
              onEdit={stage}
              suggestions={editing ? undefined : inPlace}
              onReplaceEdit={(index, edit) =>
                setEdits((list) =>
                  edit
                    ? list.map((e, i) => (i === index ? edit : e))
                    : list.filter((_, i) => i !== index),
                )
              }
            />
          )}
          {doc?.kind === 'slides' && (
            <SlidesView
              slides={doc.slides}
              index={slideIndex}
              onIndex={setSlideIndex}
              markSlide={focus?.page}
              pickedShape={pickedShape}
              onPickShape={setPickedShape}
              editing={editing}
              edits={edits}
              onEdit={stage}
              suggestions={editing ? undefined : inPlace}
            />
          )}
          {doc?.kind === 'word' && !paragraphs && state.status === 'ready' && (
            <WordDocumentView
              title={pin.title}
              blob={state.blob}
              paragraphs={doc.paragraphs}
              mark={
                focus?.lineStart
                  ? { from: focus.lineStart, to: focus.lineEnd ?? focus.lineStart }
                  : null
              }
              picked={pickedParas}
              onPick={(n, extend) =>
                setPickedParas((prev) => (extend && prev ? { a: prev.a, b: n } : { a: n, b: n }))
              }
              suggestions={inPlace?.placed}
              canDecide={inPlace?.canDecide}
              onDecide={inPlace?.onDecide}
              onUnplaced={setUnplaced}
            />
          )}
          {textDraft !== null && (
            <textarea
              value={textDraft}
              onChange={(e) => setTextDraft(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={`Edit ${pin.title}`}
              spellCheck={false}
              className="flex-1 min-h-0 m-0 p-16 bg-board text-board-ink font-mono text-code border-0 rounded-none outline-none resize-none"
              data-testid="doc-text-editor"
            />
          )}
          {doc?.kind === 'text' && textDraft === null && (
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
          {doc?.kind === 'table' && textDraft === null && (
            <>
              {editCell && (
                <div className="flex items-center gap-6 px-10 py-4 bg-bg-dark border-b-2 border-border">
                  <span className="text-code-sm font-mono text-text-muted w-80 shrink-0">
                    {editCell.ref}
                  </span>
                  <input
                    autoFocus
                    value={editCellValue}
                    onChange={(e) =>
                      stage({
                        kind: 'cell',
                        ...(editCell.sheet ? { sheet: editCell.sheet } : {}),
                        ref: editCell.ref,
                        value: e.target.value,
                      })
                    }
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && pickedCells) {
                        const below = { r: pickedCells.a.r + 1, c: pickedCells.a.c };
                        setPickedCells({ a: below, b: below });
                      }
                    }}
                    aria-label={`Value of ${editCell.ref}`}
                    placeholder="value, or =formula"
                    className="flex-1 min-w-0 bg-bg border-2 border-accent px-6 py-2 font-mono text-code text-text"
                    data-testid="doc-cell-input"
                  />
                </div>
              )}
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
              {inPlace && placed.cell.size > 0 && !editing && (
                <div className="flex flex-col gap-4 max-h-200 overflow-y-auto p-8 bg-bg-dark border-b-2 border-border">
                  {[...placed.cell.values()].map((h) => (
                    <SuggestionCard
                      key={h.hunkId}
                      hunk={h}
                      canDecide={inPlace.canDecide}
                      onDecide={inPlace.onDecide}
                    />
                  ))}
                </div>
              )}
              {doc.sheets[sheetIndex] && (
                <SheetTable
                  suggestedAt={
                    inPlace && !editing
                      ? (r, c) =>
                          cellSuggestion(
                            placed,
                            doc.sheets[sheetIndex].name,
                            sheetIndex === 0,
                            r,
                            c,
                          )
                      : undefined
                  }
                  sheet={
                    modelSheets?.[sheetIndex] && edits.length > 0
                      ? modelSheetView(modelSheets[sheetIndex], edits)
                      : doc.sheets[sheetIndex]
                  }
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
                    {wordParagraphs
                      ? 'Click a paragraph to pick it; Shift-click another for a range.'
                      : doc?.kind === 'text'
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
                {ask && (refs.length > 0 || current) && !showAsk && (
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={() => setShowAsk(true)}
                    data-testid="doc-pick-ask-agent"
                  >
                    Ask in Agent chat…
                  </Button>
                )}
                {onAskRefs && (refs.length > 0 || current) && (
                  <Button
                    variant={ask ? 'default' : 'accent'}
                    size="sm"
                    onClick={() => {
                      if (current && onAddRef && !refs.some((r) => refText(r) === refText(current)))
                        onAddRef(current);
                      onAskRefs();
                    }}
                    data-testid="doc-pick-ask"
                  >
                    {ask
                      ? `Add to ${askLabel ?? 'the'} chat`
                      : `Ask ${askLabel ?? 'the agent'} about this`}
                  </Button>
                )}
              </div>
              {refs.length > 0 && (
                <div className="flex gap-4 flex-wrap">
                  {refs.map((r, i) => (
                    <span
                      key={`${refText(r)}-${i}`}
                      className="flex items-center gap-4 px-6 py-1 bg-active-bg border-2 border-accent text-code-sm font-mono"
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
        {ask && showAsk && state.status === 'ready' && (
          <DocChatPanel
            filePath={pin.value}
            refs={
              current && !refs.some((r) => refText(r) === refText(current))
                ? [...refs, current]
                : refs
            }
            agents={ask.agents}
            preferred={ask.preferred}
            canStartAgent={ask.canStartAgent}
            entriesFor={ask.entriesFor}
            onSend={ask.onSend}
            onOpenChat={ask.onOpenChat}
            onSent={() => {
              ask.onClearRefs();
              setPickedLines(null);
              setPickedCells(null);
              setPickedParas(null);
              setPickedShape(null);
            }}
            onClose={() => setShowAsk(false)}
          />
        )}
      </div>
    </div>
  );
}
