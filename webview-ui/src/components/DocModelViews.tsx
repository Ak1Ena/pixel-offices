import { useEffect, useRef, useState } from 'react';

import type { DocEdit, DocParagraph, DocSlide } from '../../../core/src/docModel.js';

/**
 * Word and PowerPoint as the office numbers them (core/src/docModel.ts):
 * paragraphs with ¶ numbers, slides with their named text boxes. Click a
 * number (Shift for a range) or a box to point at it; in edit mode the text
 * is edited in place and each change becomes one DocEdit for the save.
 */

function pendingPara(edits: DocEdit[], n: number): string | undefined {
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    if (e.kind === 'para' && e.n === n) return e.text;
  }
  return undefined;
}

function insertedAfter(edits: DocEdit[], n: number): Array<{ index: number; text: string }> {
  return edits
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.kind === 'insertAfter' && e.n === n)
    .map(({ e, index }) => ({ index, text: (e as { text: string }).text }));
}

/** A textarea that grows with its text. */
function GrowingText({
  value,
  onChange,
  label,
  autoFocus,
}: {
  value: string;
  onChange: (text: string) => void;
  label: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      autoFocus={autoFocus}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      className="w-full resize-none bg-board text-board-ink font-reading text-read border-2 border-accent rounded-none outline-none px-6 py-2"
    />
  );
}

export function WordParagraphs({
  paragraphs,
  mark,
  picked,
  onPick,
  editing,
  edits,
  onEdit,
  onReplaceEdit,
}: {
  paragraphs: DocParagraph[];
  /** An agent's "show me" range. */
  mark?: { from: number; to: number } | null;
  picked?: { a: number; b: number } | null;
  onPick?: (n: number, extend: boolean) => void;
  editing: boolean;
  edits: DocEdit[];
  onEdit: (edit: DocEdit) => void;
  /** Change or drop a staged new paragraph (index into `edits`). */
  onReplaceEdit: (index: number, edit: DocEdit | null) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const firstMarked = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    firstMarked.current?.scrollIntoView({ block: 'center' });
  }, [paragraphs, mark?.from]);
  useEffect(() => {
    if (!editing) setActive(null);
  }, [editing]);

  return (
    <div
      className="flex-1 min-h-0 overflow-auto bg-board text-board-ink py-8"
      data-testid="doc-paragraphs"
    >
      {paragraphs.length === 0 && (
        <div className="px-16 text-sm text-board-ink-muted">This document has no text.</div>
      )}
      {paragraphs.map((p) => {
        const marked = !!mark && p.n >= mark.from && p.n <= mark.to;
        const isPicked =
          !!picked && p.n >= Math.min(picked.a, picked.b) && p.n <= Math.max(picked.a, picked.b);
        const staged = pendingPara(edits, p.n);
        const text = staged ?? p.text;
        return (
          <div key={p.n}>
            <div
              ref={marked && p.n === mark?.from ? firstMarked : undefined}
              className={`grid grid-cols-[52px_1fr] pr-16 border-l-4 ${
                isPicked
                  ? 'bg-doc-pick border-status-active'
                  : marked
                    ? 'bg-doc-mark border-accent'
                    : staged !== undefined
                      ? 'border-status-permission'
                      : 'border-transparent'
              }`}
              data-testid="doc-para"
            >
              <button
                className="text-right pr-12 pt-2 text-board-ink-muted select-none bg-transparent border-0 p-0 cursor-pointer text-code-sm hover:text-board-ink"
                onClick={(e) => onPick?.(p.n, e.shiftKey)}
                title="Pick this paragraph (Shift-click for a range)"
              >
                ¶{p.n}
              </button>
              {editing && active === p.n ? (
                <GrowingText
                  value={text}
                  autoFocus
                  label={`Paragraph ${p.n}`}
                  onChange={(t) => onEdit({ kind: 'para', n: p.n, text: t })}
                />
              ) : (
                <span
                  onClick={() => editing && setActive(p.n)}
                  className={`font-reading whitespace-pre-wrap break-words py-2 ${
                    p.heading
                      ? p.heading <= 1
                        ? 'text-lg font-bold'
                        : p.heading === 2
                          ? 'text-base font-bold'
                          : 'text-read font-bold'
                      : 'text-read'
                  } ${p.table ? 'pl-12 border-l-2 border-board-edge' : ''} ${
                    p.list ? 'pl-12' : ''
                  } ${editing ? 'cursor-text hover:bg-doc-mark' : ''}`}
                >
                  {p.list && '• '}
                  {text || ' '}
                </span>
              )}
            </div>
            {insertedAfter(edits, p.n).map(({ index, text: added }) => (
              <div
                key={`new-${index}`}
                className="grid grid-cols-[52px_1fr] pr-16 border-l-4 border-status-success"
              >
                <button
                  className="text-right pr-12 text-status-success bg-transparent border-0 p-0 cursor-pointer text-code-sm"
                  title="Remove this new paragraph"
                  onClick={() => onReplaceEdit(index, null)}
                >
                  new ✕
                </button>
                <GrowingText
                  value={added}
                  label={`New paragraph after ${p.n}`}
                  onChange={(t) => onReplaceEdit(index, { kind: 'insertAfter', n: p.n, text: t })}
                />
              </div>
            ))}
            {editing && active === p.n && (
              <div className="grid grid-cols-[52px_1fr] pr-16">
                <span />
                <button
                  className="justify-self-start bg-transparent border-0 p-0 text-2xs text-board-ink-muted cursor-pointer hover:text-board-ink"
                  onClick={() => onEdit({ kind: 'insertAfter', n: p.n, text: '' })}
                >
                  + paragraph after ¶{p.n}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SlidesView({
  slides,
  index,
  onIndex,
  markSlide,
  pickedShape,
  onPickShape,
  editing,
  edits,
  onEdit,
}: {
  slides: DocSlide[];
  index: number;
  onIndex: (index: number) => void;
  /** An agent's "show me" slide (1-based). */
  markSlide?: number;
  pickedShape: string | null;
  onPickShape: (shape: string | null) => void;
  editing: boolean;
  edits: DocEdit[];
  onEdit: (edit: DocEdit) => void;
}) {
  const slide = slides[index];
  const staged = (shape: string): string | undefined => {
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      if (e.kind === 'shape' && e.slide === slide?.n && e.shape === shape) return e.text;
    }
    return undefined;
  };
  if (!slide) {
    return <div className="m-auto text-sm text-text-muted">This presentation has no slides.</div>;
  }
  return (
    <div className="flex-1 min-h-0 flex bg-bg-dark" data-testid="doc-slides">
      <nav
        aria-label="Slides"
        className="w-110 shrink-0 overflow-y-auto flex flex-col gap-6 p-6 border-r-2 border-border"
      >
        {slides.map((s, i) => {
          const title = s.shapes.find((sh) => sh.title)?.text ?? s.shapes[0]?.text ?? '';
          return (
            <button
              key={s.n}
              onClick={() => {
                onIndex(i);
                onPickShape(null);
              }}
              className={`aspect-video flex flex-col justify-between p-4 text-left rounded-none cursor-pointer bg-board text-board-ink border-2 ${
                i === index
                  ? 'border-accent'
                  : s.n === markSlide
                    ? 'border-status-permission'
                    : 'border-board-edge'
              }`}
              aria-label={`Slide ${s.n}`}
            >
              <span className="text-code-sm line-clamp-2 break-words font-reading">{title}</span>
              <span className="text-code-sm text-board-ink-muted">{s.n}</span>
            </button>
          );
        })}
      </nav>
      <div className="flex-1 min-w-0 overflow-auto p-16 flex">
        <div
          className="m-auto w-full max-w-[960px] aspect-video bg-board text-board-ink border-2 border-board-edge p-24 flex flex-col gap-10 overflow-auto"
          data-testid="doc-slide"
        >
          {slide.shapes.length === 0 && (
            <span className="text-sm text-board-ink-muted">No text on this slide.</span>
          )}
          {slide.shapes.map((shape) => {
            const text = staged(shape.name) ?? shape.text;
            const isPicked = pickedShape === shape.name;
            return (
              <div
                key={shape.name}
                onClick={() => onPickShape(isPicked && !editing ? null : shape.name)}
                className={`flex flex-col gap-2 border-2 px-8 py-4 cursor-pointer ${
                  isPicked
                    ? 'bg-doc-pick border-status-active'
                    : staged(shape.name) !== undefined
                      ? 'border-status-permission border-dashed'
                      : 'border-transparent hover:border-board-edge border-dashed'
                }`}
                title={shape.name}
              >
                <span className="text-code-sm text-board-ink-muted">{shape.name}</span>
                {editing && isPicked ? (
                  <GrowingText
                    value={text}
                    autoFocus
                    label={`${shape.name} on slide ${slide.n}`}
                    onChange={(t) =>
                      onEdit({ kind: 'shape', slide: slide.n, shape: shape.name, text: t })
                    }
                  />
                ) : (
                  <span
                    className={`font-reading whitespace-pre-wrap break-words ${
                      shape.title ? 'text-xl font-bold' : 'text-read'
                    }`}
                  >
                    {text || ' '}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
