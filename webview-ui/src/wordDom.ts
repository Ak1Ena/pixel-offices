/** DOM helpers for the laid-out Word view (WordDocumentView.tsx). */

/** A drawn paragraph's text, and the same without superscripts (the renderer's note markers). */
export function drawnTexts(el: Element): string[] {
  const full = el.textContent ?? '';
  if (!el.querySelector('sup')) return [full];
  const clone = el.cloneNode(true) as Element;
  Array.from(clone.querySelectorAll('sup')).forEach((sup) => sup.remove());
  return [full, clone.textContent ?? ''];
}
