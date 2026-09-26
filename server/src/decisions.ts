import {
  DECISION_MIN_CONFIDENCE,
  DECISION_STATE_MAX_CHARS,
  DECISION_THRESHOLDS,
  DECISION_TIMEOUT_MS,
  type DecisionKind,
  DECISIONS_KEY_ENV,
  DECISIONS_URL_ENV,
} from './constants.js';

/**
 * Typed decisions from a "System One" model: a piece of state plus typed
 * questions in, typed answers with calibrated confidence out, no generated
 * text. Spoken over the `POST /v1/systemone` wire protocol, which Laya's
 * `laya-serve` (open weights, runs locally) and TypeSafe's hosted Jev share.
 *
 * Optional everywhere: with no endpoint configured `decider()` is null and
 * every caller keeps its rule. A caller asks only where its rule is unsure,
 * uses an answer only at `DECISION_MIN_CONFIDENCE` or above, and treats a
 * failure, timeout or low confidence exactly like "no model". The text sent
 * is agent replies, so the endpoint should be one the user runs themselves.
 */

export type DecisionQuestion =
  | {
      type: 'choice';
      instructions: string;
      /** Option key → what it means. Keys must not be yes/no/true/false (Laya follows those words, not the meaning). */
      criteria: Record<string, string>;
    }
  | { type: 'noul'; instructions: string };

export interface DecisionAnswer {
  /** `choice` questions: the top option. */
  choice?: string;
  /** `noul` questions: P(true). */
  noul?: number;
  confidence?: number;
  /** The checkpoint that answered (the reply's top-level `model`), when the server says. */
  model?: string;
}

/** Who a decision is about, for the office to show (the agent walks over to Laya). */
export interface DecisionAbout {
  agentId?: number;
  /** A few words: what is being asked ("Is the work done?"). */
  topic: string;
}

export interface Decider {
  /** Answers by question key, or null when the model could not be asked. Never throws. */
  ask(
    state: Record<string, string>,
    questions: Record<string, DecisionQuestion>,
    about?: DecisionAbout,
  ): Promise<Record<string, DecisionAnswer> | null>;
}

export interface DecisionsConfig {
  url: string;
  apiKey?: string;
  /** Checkpoint to ask for (laya-serve honours english/multilingual/typed-decisions); absent = the server's router picks. */
  model?: string;
}

/** The lowest confidence used for this kind of question from the checkpoint that answered. */
export function thresholdFor(answer: DecisionAnswer | undefined, kind: DecisionKind): number {
  const table = answer?.model ? DECISION_THRESHOLDS[answer.model] : undefined;
  return table?.[kind] ?? DECISION_MIN_CONFIDENCE;
}

/** The option chosen with enough confidence, else undefined. */
export function confidentChoice(
  answer: DecisionAnswer | undefined,
  kind: DecisionKind,
): string | undefined {
  if (!answer || typeof answer.choice !== 'string') return undefined;
  return (answer.confidence ?? 0) >= thresholdFor(answer, kind) ? answer.choice : undefined;
}

/** A yes/no answer only when the probability is clearly on one side, else undefined. */
export function confidentYes(
  answer: DecisionAnswer | undefined,
  kind: DecisionKind,
): boolean | undefined {
  const p = answer?.noul;
  if (typeof p !== 'number') return undefined;
  const t = thresholdFor(answer, kind);
  if (p >= t) return true;
  if (p <= 1 - t) return false;
  return undefined;
}

/** The end of `text`, bounded: a reply's question or verdict is usually its last lines. */
export function tailOf(text: string, max = DECISION_STATE_MAX_CHARS): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

function parseAnswers(body: unknown): Record<string, DecisionAnswer> | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { answers?: unknown }).answers;
  if (!raw || typeof raw !== 'object') return null;
  const model = (body as { model?: unknown }).model;
  const out: Record<string, DecisionAnswer> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    out[key] = {
      ...(typeof v.choice === 'string' ? { choice: v.choice } : {}),
      ...(typeof v.noul === 'number' ? { noul: v.noul } : {}),
      ...(typeof v.confidence === 'number' ? { confidence: v.confidence } : {}),
      ...(typeof model === 'string' ? { model } : {}),
    };
  }
  return out;
}

export class SystemOneClient implements Decider {
  private warned = false;

  constructor(
    private readonly config: DecisionsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ask(
    state: Record<string, string>,
    questions: Record<string, DecisionQuestion>,
  ): Promise<Record<string, DecisionAnswer> | null> {
    const url = `${this.config.url.replace(/\/+$/, '')}/v1/systemone`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          state,
          questions,
          ...(this.config.model ? { model: this.config.model } : {}),
        }),
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const answers = parseAnswers(await res.json());
      if (!answers) throw new Error('no answers in the reply');
      this.warned = false;
      return answers;
    } catch (err) {
      // Once per outage: a stopped laya-serve would otherwise log on every reply.
      if (!this.warned) {
        this.warned = true;
        console.warn(`[Pixel Agents] Decision model at ${url} unavailable: ${String(err)}`);
      }
      return null;
    }
  }
}

/** The configured endpoint: environment first, then config.json `decisions`. */
export function decisionsConfig(fromFile: DecisionsConfig | undefined): DecisionsConfig | null {
  const url = process.env[DECISIONS_URL_ENV]?.trim() || fromFile?.url;
  if (!url) return null;
  const apiKey = process.env[DECISIONS_KEY_ENV]?.trim() || fromFile?.apiKey;
  return { url, ...(apiKey ? { apiKey } : {}) };
}

/** Coerce config.json's `decisions` value: an http(s) URL and an optional key, else undefined. */
export function parseDecisionsConfig(raw: unknown): DecisionsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string' || !/^https?:\/\/\S+$/i.test(r.url.trim())) return undefined;
  const apiKey = typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey.trim() : undefined;
  return { url: r.url.trim(), ...(apiKey ? { apiKey } : {}) };
}
