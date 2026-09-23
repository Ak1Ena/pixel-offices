import { useEffect, useRef, useState } from 'react';

import type { DocParagraph } from '../../../core/src/docModel.js';
import type { HunkDecision, ProposalHunk } from '../../../core/src/messages.js';
import { DOCX_FRAME_CSS } from '../constants.js';
import type { PlacedSuggestions } from '../docSuggestions.js';
import { hunkTexts } from '../docSuggestions.js';
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
  /** An agent's suggested changes, shown where they land. */
  suggestions?: PlacedSuggestions;
  canDecide?: boolean;
  onDecide?: (hunkId: string, decision: HunkDecision) => void;
  /** How many suggested changes could not be placed on the drawn page. */
  onUnplaced?: (count: number) => void;
}

/** One suggestion card in the frame: the new text and Accept / Reject (handled by the office page). */
function suggestionNode(doc: Document, hunk: ProposalHunk, canDecide: boolean): HTMLElement {
  const { after } = hunkTexts(hunk);
  const box = doc.createElement('div');
  box.className = 'pa-sugg';
  box.setAttribute('data-state', hunk.decision);
  box.textContent = after || '(removed)';
  const actions = doc.createElement('div');
  actions.className = 'pa-sugg-actions';
  const label = doc.createElement('span');
  label.textContent = `Suggested · ${hunk.where}${hunk.decision !== 'pending' ? ` · ${hunk.decision}` : ''}`;
  actions.appendChild(label);
  const button = (text: string, decision: HunkDecision) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('data-hunk', hunk.hunkId);
    b.setAttribute('data-decision', decision);
    actions.appendChild(b);
  };
  if (canDecide) {
    if (hunk.decision === 'pending') {
      button('✗ Reject', 'rejected');
      button('✓ Accept', 'accepted');
    } else button('Undo', 'pending');
  }
  box.appendChild(actions);
  return box;
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
  suggestions,
  canDecide = false,
  onDecide,
  onUnplaced,
}: WordDocumentViewProps) {
  const onDecideRef = useRef(onDecide);
  onDecideRef.current = onDecide;
  const scrolledFor = useRef('');
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
            const choice = target?.closest('[data-decision]');
            if (choice) {
              e.preventDefault();
              onDecideRef.current?.(
                choice.getAttribute('data-hunk') ?? '',
                choice.getAttribute('data-decision') as HunkDecision,
              );
              return;
            }
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

  // Place the agent's suggested changes in the page, again whenever they change.
  const suggestionKey = JSON.stringify([
    [...(suggestions?.para ?? [])].map(([n, h]) => [n, h.hunkId, h.decision]),
    [...(suggestions?.after ?? [])].map(([n, hs]) => [n, hs.map((h) => [h.hunkId, h.decision])]),
    canDecide,
  ]);
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc || status !== 'ready') return;
    doc.querySelectorAll('.pa-sugg').forEach((el) => el.remove());
    doc.querySelectorAll('.pa-sugg-old').forEach((el) => el.classList.remove('pa-sugg-old'));
    if (!suggestions) return;
    let unplaced = 0;
    for (const [n, hunk] of suggestions.para) {
      const el = doc.querySelector(`[data-para="${n}"]`);
      if (!el) {
        unplaced++;
        continue;
      }
      if (hunk.decision !== 'rejected') el.classList.add('pa-sugg-old');
      el.after(suggestionNode(doc, hunk, canDecide));
    }
    for (const [n, hunks] of suggestions.after) {
      const anchor =
        n === 0 ? doc.querySelector('[data-para]') : doc.querySelector(`[data-para="${n}"]`);
      if (!anchor) {
        unplaced += hunks.length;
        continue;
      }
      // After the paragraph (and its own suggestion card, if any), in order.
      let at: Element = anchor;
      while (n !== 0 && at.nextElementSibling?.classList.contains('pa-sugg'))
        at = at.nextElementSibling;
      for (const hunk of hunks) {
        const node = suggestionNode(doc, hunk, canDecide);
        if (n === 0) anchor.before(node);
        else {
          at.after(node);
          at = node;
        }
      }
    }
    onUnplaced?.(unplaced);
    // Bring the first change into view once per suggestion, not on every decision.
    const which = [...suggestions.para.values(), ...[...suggestions.after.values()].flat()]
      .map((h) => h.hunkId)
      .join(',');
    if (which && which !== scrolledFor.current) {
      scrolledFor.current = which;
      doc.querySelector('.pa-sugg')?.scrollIntoView({ block: 'center' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what the suggestions say
  }, [status, suggestionKey]);

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
