import { useEffect, useRef, useState } from 'react';

import type { DocParagraph } from '../../../core/src/docModel.js';
import { DOCX_FRAME_CSS } from '../constants.js';
import { matchParagraphs } from '../docViewer.js';
import { drawnTexts } from '../wordDom.js';

interface WordDocumentViewProps {
  title: string;
  blob: Blob;
  /** The office's numbering; absent when the file couldn't be parsed (then no picking). */
  paragraphs?: DocParagraph[];
  mark?: { from: number; to: number } | null;
  picked?: { a: number; b: number } | null;
  onPick?: (n: number, extend: boolean) => void;
}

const BASE_DOC = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

/**
 * A Word file as Word lays it out: pages, fonts, sizes, colours, tables,
 * images, headers and footers (docx-preview). It is drawn into a frame that
 * may not run scripts (`sandbox="allow-same-origin"`, no `allow-scripts`),
 * with embedded HTML chunks off and links intercepted, so nothing in the
 * document can act in the office. The office's ¶ numbers are laid over the
 * drawn paragraphs (matched by text), so a click picks the same paragraph an
 * agent reads with `pixel-office doc read --para`.
 */
export function WordDocumentView({
  title,
  blob,
  paragraphs,
  mark,
  picked,
  onPick,
}: WordDocumentViewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<'rendering' | 'ready' | 'error'>('rendering');
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  // Draw the document whenever the file changes.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let cancelled = false;
    setStatus('rendering');
    const draw = async () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.open();
      doc.write(BASE_DOC);
      doc.close();
      const style = doc.createElement('style');
      style.textContent = DOCX_FRAME_CSS;
      doc.head.appendChild(style);
      try {
        const { renderAsync } = await import('docx-preview');
        if (cancelled) return;
        await renderAsync(blob, doc.body, doc.head, {
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderChanges: false,
          // Embedded HTML (altChunk) is the one way a .docx carries markup: never drawn.
          renderAltChunks: false,
          useBase64URL: true,
          experimental: true,
        });
        if (cancelled) return;
        if (paragraphs) {
          // Body paragraphs only: headers, footers and notes are not numbered.
          const drawn = [...doc.querySelectorAll('article p')] as HTMLElement[];
          const numbers = matchParagraphs(
            paragraphs.map((p) => p.text),
            drawn.map(drawnTexts),
          );
          drawn.forEach((el, i) => {
            const n = numbers[i];
            if (n !== null) el.setAttribute('data-para', String(paragraphs[n - 1]?.n ?? n));
          });
        }
        doc.addEventListener(
          'click',
          (e) => {
            const target = e.target as Element | null;
            // Links never navigate the frame; web links open outside the office.
            const link = target?.closest('a');
            if (link) {
              e.preventDefault();
              const href = link.getAttribute('href') ?? '';
              if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
              return;
            }
            const para = target?.closest('[data-para]');
            if (para) onPickRef.current?.(Number(para.getAttribute('data-para')), e.shiftKey);
          },
          true,
        );
        setStatus('ready');
      } catch (err) {
        console.error('[Webview] Word rendering failed:', err);
        if (!cancelled) setStatus('error');
      }
    };
    void draw();
    return () => {
      cancelled = true;
    };
  }, [blob, paragraphs]);

  // Highlight the agent's spot and the user's pick; bring the spot into view.
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc || status !== 'ready') return;
    const inRange = (n: number, a: number, b: number) => n >= Math.min(a, b) && n <= Math.max(a, b);
    let firstMarked: Element | null = null;
    for (const el of doc.querySelectorAll('[data-para]')) {
      const n = Number(el.getAttribute('data-para'));
      const marked = !!mark && inRange(n, mark.from, mark.to);
      el.classList.toggle('pa-mark', marked);
      el.classList.toggle('pa-pick', !!picked && inRange(n, picked.a, picked.b));
      if (marked && !firstMarked) firstMarked = el;
    }
    firstMarked?.scrollIntoView({ block: 'center' });
  }, [status, mark?.from, mark?.to, picked?.a, picked?.b, mark, picked]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <iframe
        ref={frameRef}
        title={title}
        sandbox="allow-same-origin"
        className="flex-1 w-full border-0 bg-bg-dark"
        data-testid="doc-word-frame"
      />
      {status !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted bg-bg">
          {status === 'rendering'
            ? 'Laying out the document…'
            : 'Could not lay out this document. Try the Paragraphs tab.'}
        </div>
      )}
    </div>
  );
}
