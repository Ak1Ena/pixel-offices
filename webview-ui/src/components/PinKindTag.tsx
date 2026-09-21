import type { BoardPinKind } from '../../../core/src/messages.js';
import { PIN_KIND_LABEL, PIN_KIND_PAPER } from './pinKinds.js';

export function PinKindTag({ kind }: { kind: BoardPinKind }) {
  return (
    <span className={`px-4 text-2xs leading-none py-1 text-board-ink ${PIN_KIND_PAPER[kind]}`}>
      {PIN_KIND_LABEL[kind]}
    </span>
  );
}
