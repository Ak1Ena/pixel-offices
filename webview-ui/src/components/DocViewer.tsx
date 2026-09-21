import { useEffect, useState } from 'react';

import type { BoardPin } from '../../../core/src/messages.js';
import { BOARD_FILE_API, DOCX_FRAME_CSS } from '../constants.js';
import type { SheetView } from '../docViewer.js';
import {
  columnLetter,
  fileBaseName,
  fileExtension,
  parseCsv,
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

function SheetTable({ sheet }: { sheet: SheetView }) {
  const columns = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
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
                {Array.from({ length: columns }, (_, c) => (
                  <td key={c} className="border border-board-edge px-8 py-2 whitespace-nowrap">
                    {row[c] ?? ''}
                  </td>
                ))}
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

/**
 * Opens a whiteboard file pin inside the office: PDF and images natively,
 * Word via mammoth (rendered in a sandboxed frame — document HTML never runs
 * in the office page), Excel/CSV as a table, text as text. Libraries load
 * only when a document of that type is opened.
 */
export function DocViewer({ pin, filePins, onSelect, onClose, onAttach }: DocViewerProps) {
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
        {filePins.length > 1 && (
          <nav
            aria-label="Files on the board"
            className="hidden sm:flex flex-col gap-4 w-260 p-8 bg-bg-dark border-r-2 border-border overflow-y-auto"
          >
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
          {state.status === 'loading' && (
            <div className="m-auto text-sm text-text-muted">Opening…</div>
          )}
          {state.status === 'error' && (
            <div className="m-auto max-w-md p-16 pixel-panel text-sm" data-testid="doc-error">
              {state.message}
            </div>
          )}
          {doc?.kind === 'pdf' && (
            <iframe title={pin.title} src={doc.url} className="flex-1 w-full border-0 bg-board" />
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
            <pre className="flex-1 min-h-0 overflow-auto m-0 p-16 bg-board text-board-ink text-xs whitespace-pre-wrap break-words">
              {doc.text}
            </pre>
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
              {doc.sheets[sheetIndex] && <SheetTable sheet={doc.sheets[sheetIndex]} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
