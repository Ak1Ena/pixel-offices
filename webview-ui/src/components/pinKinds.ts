import type { BoardPinKind } from '../../../core/src/messages.js';

export const PIN_KIND_LABEL: Record<BoardPinKind, string> = {
  link: 'LINK',
  file: 'FILE',
  snippet: 'SNIPPET',
  note: 'NOTE',
};

/** Tailwind background class for each pin kind's paper color. */
export const PIN_KIND_PAPER: Record<BoardPinKind, string> = {
  link: 'bg-pin-link',
  file: 'bg-pin-file',
  snippet: 'bg-pin-snippet',
  note: 'bg-pin-note',
};
