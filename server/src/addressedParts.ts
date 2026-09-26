import { ADDRESS_BARE_NAME_MIN_CHARS } from './constants.js';

/**
 * Which parts of an agent's reply are addressed to whom. A paragraph is for
 * `@name` when it OPENS with the mention ("@scout — check the API",
 * "@scout, @asker: …", "Hey @scout, …"); a passing mention ("@scout is still
 * searching") addresses nobody. Lists and code right after an addressed
 * paragraph (or after one ending in ":") belong to it; other prose goes back
 * to nobody — it was usually meant for the user.
 *
 * Used by the @mention relay and by team call-ins, so each agent gets only
 * the part meant for it, never the whole reply.
 */

export interface Addressee<K> {
  key: K;
  /** Names `@` may use for it, any case. */
  aliases: string[];
}

/** At most this many words may come before the first mention ("Thanks, @Pat"). */
const MAX_WORDS_BEFORE = 2;
const LEADING_MARKUP_RE = /^[\s>*_#•\-–—]+|^\d+[.)]\s+/;
const CONTINUATION_RE = /^\s*(?:[-*•]\s|\d+[.)]\s|```|\s{2,}\S|\|)/;
const SEPARATOR_RE = /^(?:[\s,&/*_]|and\s)*/;

/** Blank-line separated blocks, keeping fenced code in one piece. */
export function splitBlocks(text: string): string[] {
  const out: string[] = [];
  let open = '';
  for (const part of text.split(/\n\s*\n/)) {
    open = open ? `${open}\n\n${part}` : part;
    if ((open.match(/```/g)?.length ?? 0) % 2 === 0) {
      if (open.trim()) out.push(open.trim());
      open = '';
    }
  }
  if (open.trim()) out.push(open.trim());
  return out;
}

/** Who a block OPENS by addressing (the rule above); empty = nobody. */
export function leadingAddressees<K>(block: string, addressees: Array<Addressee<K>>): K[] {
  let line = block.split('\n', 1)[0].toLowerCase();
  for (let prev = ''; prev !== line;) {
    prev = line;
    line = line.replace(LEADING_MARKUP_RE, '');
  }
  const first = line.indexOf('@');
  if (first === -1) return [];
  const before = line.slice(0, first).replace(/[*_]/g, '').trim();
  if (before && before.split(/\s+/).length > MAX_WORDS_BEFORE) return [];

  const found: K[] = [];
  let p = first;
  while (line[p] === '@') {
    let best: { key: K; length: number } | null = null;
    for (const a of addressees) {
      for (const alias of a.aliases) {
        const name = alias.toLowerCase();
        if (!name || !line.startsWith(name, p + 1)) continue;
        const next = line[p + 1 + name.length];
        if (next !== undefined && /[a-z0-9_-]/.test(next)) continue;
        if (!best || name.length + 1 > best.length) best = { key: a.key, length: name.length + 1 };
      }
    }
    if (!best) break;
    if (!found.includes(best.key)) found.push(best.key);
    p += best.length;
    p += SEPARATOR_RE.exec(line.slice(p))![0].length;
  }
  return found;
}

/** Addressees `@`-mentioned anywhere in `block` (whole names, any case). */
export function mentionedIn<K>(block: string, addressees: Array<Addressee<K>>): K[] {
  const lower = block.toLowerCase();
  const found: K[] = [];
  for (const a of addressees) {
    const hit = a.aliases.some((alias) => {
      const needle = `@${alias.toLowerCase()}`;
      if (needle === '@') return false;
      for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
        const next = lower[at + needle.length];
        if (next === undefined || !/[a-z0-9_-]/.test(next)) return true;
      }
      return false;
    });
    if (hit && !found.includes(a.key)) found.push(a.key);
  }
  return found;
}

/**
 * Addressees a block names WITHOUT `@` ("scout, check the limits"): a whole
 * word, any case. Only ever a candidate for the decision model — a bare name
 * is too often just a mention for the rule to act on.
 */
export function namedIn<K>(block: string, addressees: Array<Addressee<K>>): K[] {
  const lower = block.toLowerCase();
  const found: K[] = [];
  for (const a of addressees) {
    const hit = a.aliases.some((alias) => {
      const needle = alias.toLowerCase();
      if (needle.length < ADDRESS_BARE_NAME_MIN_CHARS) return false;
      for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
        const before = lower[at - 1];
        const after = lower[at + needle.length];
        const edge = (c: string | undefined) => c === undefined || !/[a-z0-9_@-]/.test(c);
        if (edge(before) && edge(after)) return true;
      }
      return false;
    });
    if (hit && !found.includes(a.key)) found.push(a.key);
  }
  return found;
}

/**
 * Parts per addressee from blocks and who each block opens to. Lists and code
 * right after an addressed block (or after one ending in ":") stay with it.
 */
export function assignParts<K>(blocks: string[], openers: K[][]): Map<K, string> {
  const parts = new Map<K, string[]>();
  let current: K[] = [];
  let openEnded = false;
  blocks.forEach((block, i) => {
    const to = openers[i] ?? [];
    if (to.length > 0) current = to;
    else if (!(current.length > 0 && (openEnded || CONTINUATION_RE.test(block)))) current = [];
    for (const key of current) parts.set(key, [...(parts.get(key) ?? []), block]);
    openEnded = current.length > 0 && /:\s*$/.test(block);
  });
  return new Map([...parts].map(([key, list]) => [key, list.join('\n\n')]));
}

/** The text each addressee should get; absent = not addressed. */
export function addressedParts<K>(text: string, addressees: Array<Addressee<K>>): Map<K, string> {
  const blocks = splitBlocks(text);
  return assignParts(
    blocks,
    blocks.map((block) => leadingAddressees(block, addressees)),
  );
}
