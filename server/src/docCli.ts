import * as fs from 'fs';
import * as http from 'http';

import type { DocEdit, DocModel } from '../../core/src/docModel.js';
import { callerSession } from './agentsCli.js';
import { resolveFilePath } from './boardCli.js';
import {
  BOARD_CLI_REQUEST_TIMEOUT_MS,
  DOC_CLI_COMMAND,
  DOC_MAX_FILE_BYTES,
  DOC_OUTLINE_CELLS,
  DOC_OUTLINE_ROWS,
  DOC_OUTLINE_TEXT_CHARS,
  DOCS_API_PATH,
  PROPOSAL_POLL_MS,
  PROPOSAL_WAIT_MS,
} from './constants.js';
import { readLiveServers } from './launcher.js';
import {
  docKindOf,
  parseDocPlace,
  readDocModel,
  readDocPlace,
  validateDocEdit,
} from './officeDocs.js';
import { request as proposalRequest } from './proposeCli.js';
import type { ServerConfig } from './serverConfig.js';

/**
 * `pixel-office doc …` — Word, PowerPoint and Excel files by numbered place.
 *
 *   doc outline FILE                      numbered overview, to find places
 *   doc read FILE --para 3-4 | --slide 2 [--shape NAME] | --cell RANGE
 *
 * Both run LOCALLY (the file is read here; no office needed) and use the same
 * numbering as the office's viewer (officeDocs.ts). `doc edit` goes through
 * the office (Bearer `POST /api/docs/edits`): it applies the edits, or holds
 * them in Review changes, as the human set for this agent (docEdits.ts).
 */

export class DocCliError extends Error {}

export const DOC_USAGE = `Usage: ${DOC_CLI_COMMAND} outline FILE
       ${DOC_CLI_COMMAND} read FILE (--para A[-B] | --slide N [--shape NAME] | --cell RANGE)
       ${DOC_CLI_COMMAND} edit FILE (--para N --text T | --insert-after N --text T
                               | --slide N --shape NAME --text T
                               | --cell REF --value V [--sheet NAME]
                               | --from edits.json) [--why T] [--wait]

Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) files, by numbered place:
paragraphs ¶1… (tables flattened row by row), slides and their shape names,
cells like C5 or "Sheet1!C2:C4". Run outline first to find the numbers.
outline and read work on the file directly; edit goes through the office,
which shows the change and keeps everything else in the file as it was.
--text "a\\nb" makes a line break (Word) or a new paragraph (PowerPoint).
--value "=SUM(C2:C4)" is a formula, a plain number is a number, "" clears.`;

export interface DocCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  readFile?: (filePath: string) => Buffer | Promise<Buffer>;
  cwd?: string;
  /** Live offices (`doc edit`); default: the registry. */
  servers?: () => ServerConfig[];
  /** The caller's session (`doc edit`); default: from the environment. */
  session?: string;
}

interface Ctx {
  out: (text: string) => void;
  cwd: string;
  readFile: (filePath: string) => Buffer | Promise<Buffer>;
  servers: () => ServerConfig[];
  session: string | undefined;
}

type Subcommand = (args: string[], ctx: Ctx) => Promise<number>;

function needValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined) throw new DocCliError(`${flag} needs a value.\n\n${DOC_USAGE}`);
  return value;
}

/** Split `args` into positionals and --flag values; flags in `booleans` take no value. */
function parseFlags(
  args: string[],
  allowed: Set<string>,
  booleans: Set<string> = new Set(),
): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && arg.length > 2) {
      if (!allowed.has(arg) && !booleans.has(arg))
        throw new DocCliError(`Unknown option ${arg}.\n\n${DOC_USAGE}`);
      if (flags.has(arg)) throw new DocCliError(`${arg} is given twice.`);
      if (booleans.has(arg)) flags.set(arg, '');
      else {
        flags.set(arg, needValue(args, i, arg));
        i++;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

function onlyFile(positional: string[], sub: string): string {
  if (positional.length === 0) throw new DocCliError(`doc ${sub} needs a FILE.\n\n${DOC_USAGE}`);
  if (positional.length > 1)
    throw new DocCliError(
      `doc ${sub} takes one FILE (got ${positional.map((p) => `"${p}"`).join(' ')}).`,
    );
  return positional[0];
}

async function loadModel(raw: string, ctx: Ctx): Promise<DocModel> {
  const filePath = resolveFilePath(raw, ctx.cwd);
  const kind = docKindOf(filePath);
  if (!kind)
    throw new DocCliError(
      `${filePath} is not a Word, PowerPoint or Excel file (.docx, .pptx, .xlsx).`,
    );
  let buf: Buffer;
  try {
    buf = await ctx.readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new DocCliError(
      code === 'ENOENT'
        ? `No such file: ${filePath}`
        : `Can't read ${filePath}: ${(err as Error).message}`,
    );
  }
  if (buf.length > DOC_MAX_FILE_BYTES)
    throw new DocCliError(`${filePath} is too big to open here.`);
  try {
    return await readDocModel(buf, kind);
  } catch (err) {
    throw new DocCliError(`Can't read ${filePath}: ${(err as Error).message}`);
  }
}

function clip(text: string, max = DOC_OUTLINE_TEXT_CHARS): string {
  const one = text.replace(/\s*\n\s*/g, ' ⏎ ').replace(/\t/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A compact numbered overview of the document. */
export function formatOutline(model: DocModel): string {
  const lines: string[] = [];
  if (model.kind === 'docx') {
    const shown = model.paragraphs.filter((p) => p.text.trim() !== '');
    lines.push(
      `Word document, ${model.paragraphs.length} paragraphs` +
        (shown.length < model.paragraphs.length ? ' (empty ones not listed)' : ''),
    );
    for (const p of shown) {
      const marks = [
        p.heading ? `[H${p.heading}]` : '',
        p.table ? '[table]' : '',
        p.list ? '•' : '',
      ].filter(Boolean);
      lines.push(`¶${p.n} ${marks.length ? `${marks.join(' ')} ` : ''}${clip(p.text)}`);
    }
  } else if (model.kind === 'pptx') {
    lines.push(`PowerPoint presentation, ${model.slides.length} slides`);
    for (const s of model.slides) {
      lines.push(`Slide ${s.n}`);
      for (const sh of s.shapes) {
        const first = sh.text.split('\n').find((l) => l.trim() !== '') ?? '';
        lines.push(`  [${sh.name}]${sh.title ? ' (title)' : ''} ${clip(first)}`.trimEnd());
      }
    }
  } else {
    lines.push(`Excel workbook, ${model.sheets.length} sheets`);
    for (const sh of model.sheets) {
      lines.push(`${sh.name}  ${sh.range || '(empty)'}`);
      for (const row of sh.rows.slice(0, DOC_OUTLINE_ROWS)) {
        const cells = row
          .slice(0, DOC_OUTLINE_CELLS)
          .map((c) => `${c.ref} ${c.formula !== undefined ? `=${c.formula}` : clip(c.value, 30)}`);
        if (row.length > DOC_OUTLINE_CELLS) cells.push('…');
        lines.push(`  ${cells.join(' | ')}`);
      }
      if (sh.rows.length > DOC_OUTLINE_ROWS)
        lines.push(
          `  … (${sh.rows.length - DOC_OUTLINE_ROWS} more rows read${sh.truncated ? ', sheet truncated' : ''})`,
        );
    }
  }
  return lines.join('\n');
}

const READ_FLAGS = new Set(['--para', '--slide', '--shape', '--cell']);

/** POST the edits to one office's docs route. */
function postEdits(
  server: Pick<ServerConfig, 'port' | 'token'>,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: `${DOCS_API_PATH}/edits`,
        headers: {
          Authorization: `Bearer ${server.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: BOARD_CLI_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch {
            reject(new Error('not a docs route')); // an older office
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

/** Wait for the human's review of a document suggestion (`--wait`). */
async function waitForReview(server: ServerConfig, proposalId: string, ctx: Ctx): Promise<number> {
  const deadline = Date.now() + PROPOSAL_WAIT_MS;
  while (Date.now() < deadline) {
    let result: { state?: string; summary?: string };
    try {
      result = (
        await proposalRequest(
          server,
          'GET',
          `/${proposalId}`,
          undefined,
          PROPOSAL_POLL_MS + BOARD_CLI_REQUEST_TIMEOUT_MS,
        )
      ).body as typeof result;
    } catch {
      throw new DocCliError('Lost the office while waiting for the review.');
    }
    if (result.state === 'applied' || result.state === 'discarded') {
      ctx.out(result.summary ?? result.state);
      return 0;
    }
    if (result.state === 'gone') {
      ctx.out('The suggestion was closed before the human decided. Nothing was written.');
      return 0;
    }
  }
  ctx.out('The human has not decided yet. Carry on; you will get a message when they do.');
  return 0;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  /** Through the office: it applies the edits or holds them for review, as the human set. */
  async edit(args, ctx) {
    const cmd = parseDocEditArgs(args, { cwd: ctx.cwd });
    const payload = {
      path: cmd.file,
      edits: cmd.edits,
      why: cmd.why,
      cwd: ctx.cwd,
      ...(ctx.session ? { session: ctx.session } : {}),
    };
    let refusal = '';
    for (const server of ctx.servers()) {
      let res: { status: number; body: Record<string, unknown> };
      try {
        res = await postEdits(server, payload);
      } catch {
        continue; // gone, or too old to edit documents
      }
      if (res.status === 401 || res.status === 404) continue;
      const body = res.body;
      if (res.status >= 400) {
        refusal = typeof body.error === 'string' ? body.error : 'The office refused the edit.';
        if (res.status === 403) break; // the human said no: another office won't say yes
        continue;
      }
      if (body.status === 'applied') {
        ctx.out(String(body.summary ?? 'Applied.'));
        return 0;
      }
      if (body.status === 'review' && typeof body.proposalId === 'string') {
        if (!cmd.wait) {
          ctx.out(
            `Suggested ${cmd.edits.length} change${cmd.edits.length === 1 ? '' : 's'} to ${cmd.file}. Nothing is written until the human accepts them; you'll get a message saying what landed.`,
          );
          return 0;
        }
        return waitForReview(server, body.proposalId, ctx);
      }
    }
    throw new DocCliError(
      refusal || 'No Pixel Office is running, so nobody can apply the edit. Nothing was written.',
    );
  },

  async outline(args, ctx) {
    const { positional } = parseFlags(args, new Set());
    ctx.out(formatOutline(await loadModel(onlyFile(positional, 'outline'), ctx)));
    return 0;
  },
  async read(args, ctx) {
    const { positional, flags } = parseFlags(args, READ_FLAGS);
    const file = onlyFile(positional, 'read');
    let place;
    try {
      place = parseDocPlace({
        para: flags.get('--para'),
        slide: flags.get('--slide'),
        shape: flags.get('--shape'),
        cell: flags.get('--cell'),
      });
    } catch (err) {
      throw new DocCliError(`${(err as Error).message}\n\n${DOC_USAGE}`);
    }
    const model = await loadModel(file, ctx);
    try {
      ctx.out(readDocPlace(model, place));
    } catch (err) {
      throw new DocCliError((err as Error).message);
    }
    return 0;
  },
};

/** Run `pixel-office doc …` (argv after `doc`). Returns the process exit code. */
export async function runDocCommand(argv: string[], deps: DocCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => console.log(t));
  const err = deps.err ?? ((t: string) => console.error(t));
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    out(DOC_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    out(DOC_USAGE);
    return 0;
  }
  const run = Object.prototype.hasOwnProperty.call(SUBCOMMANDS, sub) ? SUBCOMMANDS[sub] : undefined;
  if (!run) {
    err(`Unknown doc command "${sub}".\n\n${DOC_USAGE}`);
    return 1;
  }
  try {
    return await run(rest, {
      out,
      cwd: deps.cwd ?? process.cwd(),
      readFile: deps.readFile ?? ((p: string) => fs.promises.readFile(p)),
      servers: deps.servers ?? readLiveServers,
      session: deps.session ?? callerSession(),
    });
  } catch (e) {
    err(e instanceof DocCliError ? e.message : `doc ${sub} failed: ${(e as Error).message}`);
    return 1;
  }
}

// ── doc edit (parsing only; sending goes through the office) ────────────────

export interface DocEditCommand {
  /** Absolute path. */
  file: string;
  edits: DocEdit[];
  why?: string;
  wait: boolean;
}

const EDIT_FLAGS = new Set([
  '--para',
  '--insert-after',
  '--slide',
  '--shape',
  '--cell',
  '--sheet',
  '--text',
  '--value',
  '--from',
  '--why',
]);

function wholeFlag(raw: string, flag: string, min: number): number {
  const n = Number(raw.trim());
  if (raw.trim() === '' || !Number.isInteger(n) || n < min)
    throw new DocCliError(
      `${flag} takes a whole number${min === 0 ? ' (0 = before the first)' : ' from 1'}.`,
    );
  return n;
}

/** Undo the shell-friendly escapes an agent is told to use: "\n" and "\t". */
function unescapeText(text: string): string {
  return text.replace(/\\(\\|n|t)/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : '\\',
  );
}

/**
 * Parse `edit FILE …` (the leading "edit" is optional) into edits.
 * Throws DocCliError with a message fit for the agent.
 */
export function parseDocEditArgs(
  argv: string[],
  deps: { cwd?: string; readText?: (filePath: string) => string } = {},
): DocEditCommand {
  const args = argv[0] === 'edit' ? argv.slice(1) : argv;
  const { positional, flags } = parseFlags(args, EDIT_FLAGS, new Set(['--wait']));
  const cwd = deps.cwd ?? process.cwd();
  const file = resolveFilePath(onlyFile(positional, 'edit'), cwd);
  const kind = docKindOf(file);
  if (!kind)
    throw new DocCliError(`${file} is not a Word, PowerPoint or Excel file (.docx, .pptx, .xlsx).`);
  const why = flags.get('--why')?.trim() || undefined;
  const wait = flags.has('--wait');
  const has = (f: string): boolean => flags.has(f);
  const get = (f: string): string => flags.get(f) as string;

  const modes = ['--para', '--insert-after', '--slide', '--cell', '--from'].filter(has);
  if (modes.length === 0)
    throw new DocCliError(
      `Say what to change: --para, --insert-after, --slide, --cell or --from.\n\n${DOC_USAGE}`,
    );
  if (modes.length > 1) throw new DocCliError(`Give only one of ${modes.join(', ')}.`);
  const mode = modes[0];
  const allowedWith: Record<string, string[]> = {
    '--para': ['--text'],
    '--insert-after': ['--text'],
    '--slide': ['--shape', '--text'],
    '--cell': ['--value', '--sheet'],
    '--from': [],
  };
  for (const f of ['--shape', '--text', '--value', '--sheet'])
    if (has(f) && !allowedWith[mode].includes(f))
      throw new DocCliError(`${f} can't be used with ${mode}.`);
  const requireFlag = (f: string): string => {
    if (!has(f)) throw new DocCliError(`${mode} needs ${f}.`);
    return get(f);
  };

  let edits: DocEdit[];
  if (mode === '--from') {
    const src = resolveFilePath(get('--from'), cwd);
    let raw: string;
    try {
      raw = (deps.readText ?? ((p: string) => fs.readFileSync(p, 'utf-8')))(src);
    } catch {
      throw new DocCliError(`--from: can't read ${src}.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new DocCliError(`--from: ${src} is not JSON (${(e as Error).message}).`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0)
      throw new DocCliError(
        '--from: the file must hold a JSON array of edits, e.g. [{"kind":"para","n":3,"text":"…"}].',
      );
    edits = parsed.map((x, i) => {
      try {
        return validateDocEdit(x);
      } catch (e) {
        throw new DocCliError(`--from: edit ${i + 1}: ${(e as Error).message}`);
      }
    });
  } else if (mode === '--para') {
    edits = [
      {
        kind: 'para',
        n: wholeFlag(get('--para'), '--para', 1),
        text: unescapeText(requireFlag('--text')),
      },
    ];
  } else if (mode === '--insert-after') {
    edits = [
      {
        kind: 'insertAfter',
        n: wholeFlag(get('--insert-after'), '--insert-after', 0),
        text: unescapeText(requireFlag('--text')),
      },
    ];
  } else if (mode === '--slide') {
    const shape = requireFlag('--shape');
    if (shape.trim() === '') throw new DocCliError('--shape needs a shape name, e.g. "Title 1".');
    edits = [
      {
        kind: 'shape',
        slide: wholeFlag(get('--slide'), '--slide', 1),
        shape,
        text: unescapeText(requireFlag('--text')),
      },
    ];
  } else {
    const ref = get('--cell').trim();
    if (!/^(?:(?:'(?:[^']|'')+'|[^!]+)!)?\$?[A-Za-z]{1,3}\$?\d+$/.test(ref))
      throw new DocCliError(`--cell takes one cell like C5 or "Sheet1!C5" (got "${ref}").`);
    const edit: DocEdit = { kind: 'cell', ref, value: requireFlag('--value') };
    if (has('--sheet') && get('--sheet').trim() !== '') edit.sheet = get('--sheet').trim();
    edits = [edit];
  }

  const want = { docx: ['para', 'insertAfter'], pptx: ['shape'], xlsx: ['cell'] }[kind];
  const kindName = { docx: 'a Word document', pptx: 'a PowerPoint file', xlsx: 'an Excel file' }[
    kind
  ];
  edits.forEach((e, i) => {
    if (!want.includes(e.kind))
      throw new DocCliError(
        `${edits.length > 1 ? `Edit ${i + 1}: ` : ''}a ${e.kind} edit doesn't fit ${kindName} (use ${want.join(' or ')}).`,
      );
  });
  const result: DocEditCommand = { file, edits, wait };
  if (why) result.why = why;
  return result;
}
