/**
 * RS1 candidate validation (GST-1886), run in custody between mint.sh's probe and select steps. BEAM's probe step writes
 * many candidate items per ability, and many cite turns that do not support their reference answer, so selecting first
 * and regenerating failures could not fill every slot. This script asks validate.ts's two validators about every
 * candidate first, and mint.sh --candidates <report> then selects only from the candidates both passed. validate.ts
 * still runs unchanged on the selection and decides what is kept. It prints counts and hashes only, and writes a report
 * of conversation ids, candidate keys, gate names and numbers (never text).
 *
 *   bun eval/custody/rs1/validate-candidates.ts --set <out>/set --beam-dir <out>/tooling/beam --report <out>/validation/candidates.json
 *       (--fake | --paid --budget-run-id <id> --budget-ledger <RS1 ledger> --paid-window <unit> --window-cap-usd <n>)
 *       [--cache <dir>, default <set>/../validate-cache] [--public-index <file>] [--target-tokens 1070000] [--tolerance 0.15]
 *       [--window-tokens 60000] [--overlap-tokens 2000] [--concurrency 8] [--regroup-windows 4]
 *
 * Conversations: every one whose probe step is done (manifest probe@1). Any other is "unfinished" and gets no call. The
 * conversation gates come first, computed as validate.ts computes them: length (the cl100k token count of its messages
 * outside the target ± tolerance) and contamination (1% or more of its distinct 13-grams in one public BEAM file). A
 * conversation that fails one is "drop" and its candidates get no call: mint.sh selects nothing for it, and validate.ts
 * drops it on the same gate. validate.ts's duplicate gate across conversations stays with validate.ts.
 *
 * Candidates: every usable candidate in beam/1/probing_questions/<ability>/<ability>.json (rs1_mint.py's usable: a
 * non-empty reference answer, and cited turns unless it is an abstention item), keyed "<ability>/<index path>" as
 * rs1_mint.py's flatten_candidates keys it. The gates are validate.ts's item gates:
 *   - contamination: a public BEAM question, or half or more of its 13-grams public;
 *   - uncited: none of the turns it cites is in the (truncated) chat;
 *   - support: the two validators, gemini-3.8-flash and claude-haiku-5-5, must each find the reference answer supported
 *     by the cited turns, asked with validate.ts's own prompt;
 *   - absence: an abstention candidate fails if any window of validate.ts's windowed scan answers it. Each window asks
 *     each validator about all of the conversation's abstention candidates in one prompt. When a validator answers that
 *     prompt in the wrong shape (an empty reply or a refusal, not an error), the window is regrouped: asked again with
 *     one prompt per abstention candidate, for at most --regroup-windows windows per run (default 4), whose worst case
 *     the estimate includes. A regrouped candidate fails on "absence" if its own prompt answers it, on "refusal" if the
 *     validator refuses its prompt (Anthropic's stop reason refusal, Gemini's SAFETY, PROHIBITED_CONTENT, BLOCKLIST or
 *     SPII, or a blocked prompt; a refusal does not change on a rerun, so it fails the candidate, not the conversation),
 *     and on validator_error otherwise. A window past the limit fails every abstention candidate on validator_error.
 *     A candidate passes only if every window, from both validators, leaves it unanswered.
 * There is no duplicate gate among candidates: the select step skips a repeated question within an ability, and
 * validate.ts applies its duplicate gate to the selection.
 *
 * A validator call that errors or answers in the wrong shape leaves its conversation "incomplete": rerun, and replies
 * already cached are not bought again. Otherwise the conversation is "checked". The paid clients send validate.ts's own
 * requests (anthropicRequest, geminiRequest) through global fetch as validate.ts's post does, and return the reply text
 * validate.ts's clients return, but each also keeps how its reply ended: Anthropic's stop_reason or Gemini's finishReason
 * (a word of the provider's vocabulary, else "other"), the output token count and the kinds of content block, or the HTTP
 * status of a refused request. The report lists that for every unusable reply, per conversation, and its totals count
 * unusable replies by how they ended (unusable_<reason>), so an empty reply's cause is known without keeping its text. The select step refuses a conversation
 * that the report does not hold as checked or drop, or whose chat_sha256 is not its chat's.
 *
 * The reply cache is validate.ts's: the same default directory and the same file for the same validator and prompt, so
 * validate.ts's run over the selection finds the support reply of every selected item already cached. Its absence scan
 * asks about the two selected abstention items only, a different prompt, so those windows are asked again.
 *
 * Model calls sit behind validate.ts's ModelClient, so tests inject fakes, and --fake uses validate.ts's keyless
 * stand-ins under their own ids. Paid calls follow validate.ts's path: the granted paid window (requireRs1Window, exit 2
 * before any client exists without it), Gemini's key only from RS1_GEMINI_API_KEY, requirePaidArm with the worst-case
 * estimate, then startPaidRun, whose fetch guard prices and reserves every request in the budget ledger before it is
 * sent.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BudgetExceededError, budgetOptionsFrom, chatPrice, startPaidRun } from '../../runner/budget-ledger.ts';
import { ledgerCaps, PaidArmRefusal, requirePaidArm, requireRs1Window, WindowRefusal } from '../../runner/paid-arm.ts';
import { encodingCount } from '../../runner/systems/render-v2.ts';

import {
  ABILITIES, absencePrompt, ANSWER_FIELD, anthropicRequest, buildPublicIndex, chunkMessages, DEFAULTS, fakeClient, geminiRequest,
  ITEMS_PER_ABILITY, ngrams, normalize, runCalls, singleSourceShares, supportPrompt, THRESHOLDS, ValidateError, VALIDATOR_IDS,
  type Ability, type Message, type ModelClient, type Options, type PublicIndex,
} from './validate.ts';

/** validate.ts's reply-cache version, part of every cache file name, so both scripts read and write the same entries. */
const CACHE_VERSION = 'rs1-validate-cache/v2';
/** validate.ts's output allowance per call, which runCalls sends; the worst-case price assumes every reply uses it. */
const MAX_OUTPUT_TOKENS = 8192;
/** validate.ts's per-message framing in a window prompt ("[id N] ROLE: "), in cl100k tokens. */
const MESSAGE_FRAME_TOKENS = 8;
/** Windows regrouped per run, by default. */
export const REGROUP_WINDOWS = 4;
/** Stop reasons that mean the validator refused the prompt. */
const REFUSALS = new Set(['refusal', 'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);
const refused = (stop: string | undefined) => !!stop && (REFUSALS.has(stop) || stop.startsWith('blocked_'));

/** How a paid validator reply ended: provider vocabulary words and numbers only, never reply text. */
export interface StopRecord { stop: string; output_tokens: number | null; blocks: string[] }
/** A validator that keeps each prompt's last StopRecord. */
export interface RecordingClient extends ModelClient { readonly stops: Map<string, StopRecord> }

const vocab = (v: unknown) => (typeof v === 'string' && /^[A-Za-z_]{1,40}$/.test(v) ? v : v === undefined || v === null ? 'none' : 'other');
const tokenCount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const kinds = (types: string[]) => [...new Set(types)].sort();

/**
 * validate.ts's client for one provider: its request, its post (global fetch, so the paid run's fetch guard prices and
 * reserves the request, and an error naming only host and status) and its reply text, plus the reply's StopRecord.
 */
function recordingClient(id: string, request: (prompt: string, max: number) => { url: string; body: unknown }, headers: Record<string, string>,
  text: (reply: any) => string, ended: (reply: any) => StopRecord): RecordingClient {
  const stops = new Map<string, StopRecord>();
  return {
    id,
    stops,
    async complete(prompt, max) {
      const record = (stop: string) => void stops.set(prompt, { stop, output_tokens: null, blocks: [] });
      const { url, body } = request(prompt, max);
      let res: Response;
      try { res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); } catch (error) {
        if (!(error instanceof BudgetExceededError)) record('send_error');
        throw error;
      }
      if (!res.ok) { record(`http_${res.status}`); throw new ValidateError(`${new URL(url).hostname} answered HTTP ${res.status}`); }
      let reply: any, out: string;
      try { reply = await res.json(); out = text(reply); } catch (error) { record('bad_reply'); throw error; }
      try { stops.set(prompt, ended(reply)); } catch { record('other'); }
      return out;
    },
  };
}

export const recordingGeminiClient = (apiKey: string) => recordingClient(VALIDATOR_IDS[0], geminiRequest, { 'x-goog-api-key': apiKey },
  reply => (reply.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join(''),
  reply => {
    const candidate = reply.candidates?.[0];
    const block = reply.promptFeedback?.blockReason;
    return {
      stop: candidate ? vocab(candidate.finishReason) : block ? `blocked_${vocab(block)}` : 'no_candidate',
      output_tokens: tokenCount(reply.usageMetadata?.candidatesTokenCount),
      blocks: kinds((candidate?.content?.parts ?? []).map((p: { text?: unknown; thought?: unknown }) => (p.thought ? 'thought' : typeof p.text === 'string' ? 'text' : 'other'))),
    };
  });

export const recordingAnthropicClient = (apiKey: string) => recordingClient(VALIDATOR_IDS[1], anthropicRequest, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  reply => (reply.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join(''),
  reply => ({ stop: vocab(reply.stop_reason), output_tokens: tokenCount(reply.usage?.output_tokens), blocks: kinds((reply.content ?? []).map((b: { type?: unknown }) => vocab(b.type))) }));

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
/** A 13-gram's two hashes as one 53-bit number, as validate.ts keys them for singleSourceShares. */
const gramKey = (h1: number, h2: number) => h1 * 2 ** 21 + (h2 >>> 11);

function messagesOf(value: unknown, out: Message[] = []): Message[] {
  if (Array.isArray(value)) for (const v of value) messagesOf(v, out);
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.role === 'string' && typeof o.content === 'string') out.push({ id: Number(o.id), role: o.role, content: o.content });
    else for (const v of Object.values(o)) messagesOf(v, out);
  }
  return out;
}

function citedIds(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) for (const v of value) citedIds(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) citedIds(v, out);
  else if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) out.push(Number(value));
  return out;
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const v = JSON.parse(text.slice(start, end + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** rs1_mint.py's flatten_candidates: every object with a non-empty question inside a candidate file, keyed by its index path. */
function flatten(value: unknown, path: number[] = [], out: Array<[string, Record<string, unknown>]> = []): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(value)) value.forEach((v, i) => flatten(v, [...path, i], out));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.question === 'string' && o.question.trim()) out.push([path.join('.') || '0', o]);
  }
  return out;
}

/** Python's truthiness, for rs1_mint.py's usable. */
const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : !!v);

/** rs1_mint.py's usable: a non-empty reference answer, and cited turns unless it is an abstention item. */
function usable(ability: Ability, item: Record<string, unknown>): boolean {
  const answer = item[ANSWER_FIELD[ability]];
  return typeof answer === 'string' && !!answer.trim() && (ability === 'abstention' || truthy(item.source_chat_ids));
}

interface Candidate { ability: Ability; key: string; item: Record<string, unknown> }

/** A conversation whose probe step is done: its chat (the truncated chat when truncation wrote one) and usable candidates. */
function loadProbed(setDir: string, cid: string): { chatSha256: string; messages: Message[]; candidates: Candidate[] } | null {
  const dir = join(setDir, 'conversations', cid);
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  const steps = (readJson(join(dir, 'manifest.json')).steps ?? {}) as Record<string, { status?: string }>;
  if (steps['probe@1']?.status !== 'done') return null;
  const chatDir = join(dir, 'beam', '1');
  const raw = readFileSync(join(chatDir, existsSync(join(chatDir, 'chat_trunecated.json')) ? 'chat_trunecated.json' : 'chat.json'));
  const candidates = ABILITIES.flatMap(ability => {
    const path = join(chatDir, 'probing_questions', ability, `${ability}.json`);
    return existsSync(path) ? flatten(readJson(path)).filter(([, item]) => usable(ability, item)).map(([key, item]) => ({ ability, key: `${ability}/${key}`, item })) : [];
  });
  return { chatSha256: sha256(raw), messages: messagesOf(JSON.parse(raw.toString('utf8'))), candidates };
}

interface Call { client: number; prompt: string; tokens: number; cacheFile: string | null; cached: boolean; kind: 'support' | 'absence' | 'absence_single'; settle: (reply: string | null) => boolean }
export interface CandidateResult { pass: boolean; gates: string[] }
export interface CandidateConversation {
  status: 'checked' | 'drop' | 'incomplete' | 'unfinished';
  reasons: string[];
  chat_sha256: string | null;
  tokens: number | null;
  contamination_share: number | null;
  windows: number;
  candidates: Record<string, CandidateResult>;
  /** Every unusable validator reply: the validator, the call (a candidate key and/or a window index) and how it ended. */
  validator_errors: Array<{ validator: string; kind: Call['kind']; candidate: string | null; window: number | null; prompt_tokens: number } & StopRecord>;
  /** Windows asked again one candidate at a time, and those past the run's limit. */
  regrouped: Array<{ validator: string; window: number; over_cap: boolean }>;
  /** Passed candidates per ability. */
  passed: Record<string, number>;
}
export interface CandidateReport {
  schema: 'rs1-candidates/v1';
  validators: string[];
  params: Record<string, number>;
  public_index: { sources: number; ngrams: number; sources_sha256: string; source_list_sha256: string };
  conversations: Record<string, CandidateConversation>;
  totals: Record<string, number>;
  abilities: Record<string, { pass: number; fail: number }>;
}
/** calls first; then regroup() returns the calls for the windows whose replies were unusable; then finish. */
export interface CandidatePlan { calls: Call[]; estimateUsd: number; regroup: () => Call[]; finish: (run: { errors: number; cached: number }) => CandidateReport }

export function planCandidates(opts: Options, clients: ModelClient[], index: PublicIndex, regroupWindows = REGROUP_WINDOWS): CandidatePlan {
  if (clients.length !== 2 || clients[0].id.split(':')[0] === clients[1].id.split(':')[0]) throw new ValidateError('validation needs two validators from different families');
  const root = join(opts.setDir, 'conversations');
  const cids = existsSync(root) ? readdirSync(root).filter(n => /^c\d{3,}$/.test(n)).sort() : [];
  const results: Record<string, CandidateConversation> = {};
  /** Each checked conversation's normalized candidate questions, held in memory only, for the fillable count. */
  const questions = new Map<string, Map<string, string>>();
  const calls: Call[] = [];
  const low = Math.round(opts.targetTokens * (1 - opts.tolerance)), high = Math.round(opts.targetTokens * (1 + opts.tolerance));
  const endedOf = (client: number, prompt: string) => (clients[client] as Partial<RecordingClient>).stops?.get(prompt);
  const failItem = (cid: string, key: string, gate: string) => {
    const item = results[cid].candidates[key];
    item.pass = false;
    if (!item.gates.includes(gate)) item.gates.push(gate);
  };
  const call = (cid: string, at: { candidate?: string; window?: number }, client: number, prompt: string, tokens: number, kind: Call['kind'], settle: Call['settle']): Call => {
    const cacheFile = opts.cacheDir ? join(opts.cacheDir, `${sha256(`${CACHE_VERSION}\0${clients[client].id}\0${prompt}`)}.json`) : null;
    return {
      client, prompt, tokens, cacheFile, cached: !!cacheFile && existsSync(cacheFile), kind,
      settle: reply => {
        const usableReply = settle(reply);
        if (!usableReply) {
          const ended = endedOf(client, prompt) ?? { stop: 'unrecorded', output_tokens: null, blocks: [] };
          results[cid].validator_errors.push({ validator: clients[client].id, kind, candidate: at.candidate ?? null, window: at.window ?? null, prompt_tokens: tokens, ...ended });
        }
        return usableReply;
      },
    };
  };
  // validate.ts's worst case: Claude counts about 1.47 tokens per cl100k token (the Claude 5 calibration in
  // eval/runner/systems/render-v2.ts), every reply uses its whole output allowance, and long-prompt rates apply above
  // their threshold.
  const worstUsd = (client: number, tokens: number) => {
    const id = clients[client].id.replace(/^fake-/, '');
    const p = chatPrice(id) ?? (() => { throw new ValidateError(`no price for ${id}`); })();
    const input = (id.startsWith('anthropic:') ? 1.47 : 1) * tokens;
    const rates = p.long && input > p.long.above_input_tokens ? p.long : p;
    return (input * rates.input + MAX_OUTPUT_TOKENS * rates.output) / 1e6;
  };
  /** One window and validator whose reply may need regrouping, with its worst-case price if it does. */
  interface Regroupable { order: number; cid: string; window: number; client: number; batched: Call; usd: number; calls: () => Call[]; failAll: (gate: string) => void }
  const regroupable: Regroupable[] = [];
  const queued: Regroupable[] = [];
  const singles: Call[] = [];
  let regrouped = false;

  const measured = cids.flatMap(cid => {
    const result: CandidateConversation = { status: 'unfinished', reasons: [], chat_sha256: null, tokens: null, contamination_share: null, windows: 0, candidates: {}, validator_errors: [], regrouped: [], passed: {} };
    results[cid] = result;
    const conv = loadProbed(opts.setDir, cid);
    if (!conv) { result.reasons.push('unfinished'); return []; }
    result.chat_sha256 = conv.chatSha256;
    const contentTokens = conv.messages.map(m => encodingCount('cl100k_base', m.content));
    result.tokens = contentTokens.reduce((s, t) => s + t, 0);
    if (result.tokens < low || result.tokens > high) result.reasons.push('length');
    const grams = new Map<number, [number, number]>();
    for (const m of conv.messages) for (const [h1, h2] of ngrams(m.content)) grams.set(gramKey(h1, h2), [h1, h2]);
    const hits = [...grams].filter(([, [h1, h2]]) => index.bloom.has(h1, h2)).map(([k]) => k);
    return [{ cid, conv, result, contentTokens, size: grams.size, hits }];
  });
  singleSourceShares(index.paths, measured).forEach(({ share }, i) => {
    measured[i].result.contamination_share = share;
    if (share >= THRESHOLDS.contamination_max) measured[i].result.reasons.push('contamination');
  });

  for (const { cid, conv, result, contentTokens } of measured) {
    if (result.reasons.length) continue;
    const norms = new Map<string, string>();
    questions.set(cid, norms);
    const ids = new Map(conv.messages.map(m => [m.id, m]));
    const abstention: Array<{ key: string; question: string }> = [];
    for (const { ability, key, item: raw } of conv.candidates) {
      const item: CandidateResult = { pass: true, gates: [] };
      result.candidates[key] = item;
      const question = raw.question as string, answer = raw[ANSWER_FIELD[ability]] as string;
      const fail = (gate: string) => { item.pass = false; if (!item.gates.includes(gate)) item.gates.push(gate); };
      const norm = normalize(question);
      norms.set(key, norm);
      const qGrams = ngrams(question);
      const publicShare = qGrams.length ? qGrams.filter(([h1, h2]) => index.bloom.has(h1, h2)).length / qGrams.length : 0;
      if (index.questions.has(norm) || publicShare >= THRESHOLDS.item_contamination_max) { fail('contamination'); continue; }

      if (ability === 'abstention') { abstention.push({ key, question }); continue; }
      const turns = [...new Set(citedIds(raw.source_chat_ids))].sort((a, b) => a - b).map(id => ids.get(id)).filter((m): m is Message => !!m);
      if (!turns.length) { fail('uncited'); continue; }
      const prompt = supportPrompt(turns, question, answer);
      const tokens = encodingCount('cl100k_base', prompt);
      for (let c = 0; c < 2; c++) {
        calls.push(call(cid, { candidate: key }, c, prompt, tokens, 'support', reply => {
          const supported = reply === null ? undefined : jsonObject(reply)?.supported;
          if (typeof supported !== 'boolean') { fail(`validator_error:${clients[c].id}`); return false; }
          if (!supported) fail(`support:${clients[c].id}`);
          return true;
        }));
      }
    }

    if (!abstention.length) continue;
    const windows = chunkMessages(contentTokens.map(t => t + MESSAGE_FRAME_TOKENS), opts.windowTokens, opts.overlapTokens);
    result.windows = windows.length;
    for (const [window, [start, end]] of windows.entries()) {
      const part = conv.messages.slice(start, end);
      const prompt = absencePrompt(part, abstention.map(a => a.question));
      const tokens = contentTokens.slice(start, end).reduce((s, t) => s + t + MESSAGE_FRAME_TOKENS, 300);
      for (let c = 0; c < 2; c++) {
        const id = clients[c].id;
        const entry: Regroupable = {
          order: regroupable.length, cid, window, client: c, usd: abstention.length * worstUsd(c, tokens),
          failAll: gate => abstention.forEach(a => failItem(cid, a.key, gate)),
          batched: call(cid, { window }, c, prompt, tokens, 'absence', reply => {
            const answered = reply === null ? undefined : jsonObject(reply)?.answered;
            if (!Array.isArray(answered)) {
              if (reply === null) entry.failAll(`validator_error:${id}`);
              else queued.push(entry);
              return false;
            }
            abstention.forEach((a, i) => { if (answered.includes(i + 1)) failItem(cid, a.key, `absence:${id}`); });
            return true;
          }),
          calls: () => abstention.map(a => {
            const single = absencePrompt(part, [a.question]);
            return call(cid, { window, candidate: a.key }, c, single, tokens, 'absence_single', reply => {
              const answered = reply === null ? undefined : jsonObject(reply)?.answered;
              if (Array.isArray(answered)) {
                if (answered.includes(1)) failItem(cid, a.key, `absence:${id}`);
                return true;
              }
              failItem(cid, a.key, reply !== null && refused(endedOf(c, single)?.stop) ? `refusal:${id}` : `validator_error:${id}`);
              return false;
            });
          }),
        };
        regroupable.push(entry);
        calls.push(entry.batched);
      }
    }
  }

  // The batched calls not yet cached, plus the dearest regroupings the run may make. A cached window reply was usable,
  // so it is never regrouped.
  const estimateUsd = calls.filter(c => !c.cached).reduce((s, c) => s + worstUsd(c.client, c.tokens), 0)
    + regroupable.filter(r => !r.batched.cached).map(r => r.usd).sort((a, b) => b - a).slice(0, regroupWindows).reduce((s, u) => s + u, 0);

  const regroup = (): Call[] => {
    regrouped = true;
    const order = [...queued].sort((a, b) => a.order - b.order);
    order.forEach((r, i) => results[r.cid].regrouped.push({ validator: clients[r.client].id, window: r.window, over_cap: i >= regroupWindows }));
    for (const r of order.slice(regroupWindows)) r.failAll(`validator_error:${clients[r.client].id}`);
    singles.push(...order.slice(0, regroupWindows).flatMap(r => r.calls()));
    return singles;
  };

  const finish = (run: { errors: number; cached: number }): CandidateReport => {
    if (!regrouped) for (const r of queued) r.failAll(`validator_error:${clients[r.client].id}`);
    const of = (kind: Call['kind']) => calls.filter(c => c.kind === kind);
    const totals: Record<string, number> = {
      conversations: cids.length, checked: 0, drop: 0, incomplete: 0, unfinished: 0, fillable: 0, candidates: 0, pass: 0, fail: 0,
      calls: calls.length, support_calls: of('support').length, absence_calls: of('absence').length,
      support_tokens: of('support').reduce((s, c) => s + c.tokens, 0), absence_tokens: of('absence').reduce((s, c) => s + c.tokens, 0),
      cached_calls: run.cached, validator_errors: run.errors, windows: 0,
      absence_single_calls: singles.length, absence_single_tokens: singles.reduce((s, c) => s + c.tokens, 0),
      regrouped_windows: regrouped ? Math.min(queued.length, regroupWindows) : 0, regroup_over_cap: Math.max(0, queued.length - regroupWindows),
    };
    const abilities = Object.fromEntries(ABILITIES.map(a => [a, { pass: 0, fail: 0 }]));
    for (const [cid, result] of Object.entries(results)) {
      totals.windows += result.windows;
      for (const e of result.validator_errors) totals[`unusable_${e.stop.toLowerCase()}`] = (totals[`unusable_${e.stop.toLowerCase()}`] ?? 0) + 1;
      const items = Object.values(result.candidates);
      if (!result.reasons.length && items.some(i => i.gates.some(g => g.startsWith('validator_error:')))) result.reasons.push('validator_error');
      if (result.reasons.includes('unfinished')) result.status = 'unfinished';
      else if (result.reasons.includes('validator_error')) result.status = 'incomplete';
      else if (result.reasons.length) result.status = 'drop';
      else result.status = 'checked';
      totals[result.status]++;
      if (result.status === 'unfinished') continue;
      result.passed = Object.fromEntries(ABILITIES.map(a => [a, 0]));
      const distinct = Object.fromEntries(ABILITIES.map(a => [a, new Set<string>()]));
      for (const [key, item] of Object.entries(result.candidates)) {
        const ability = key.split('/')[0];
        totals.candidates++;
        totals[item.pass ? 'pass' : 'fail']++;
        abilities[ability][item.pass ? 'pass' : 'fail']++;
        if (item.pass) { result.passed[ability]++; distinct[ability].add(questions.get(cid)!.get(key)!); }
        for (const gate of item.gates) { const g = `gate_${gate.split(':')[0]}`; totals[g] = (totals[g] ?? 0) + 1; }
      }
      if (result.status === 'checked' && Object.values(distinct).every(s => s.size >= ITEMS_PER_ABILITY)) totals.fillable++;
    }
    for (const r of ['length', 'contamination']) totals[`drop_${r}`] = Object.values(results).filter(c => c.reasons.includes(r)).length;
    return {
      schema: 'rs1-candidates/v1',
      validators: clients.map(c => c.id),
      params: { target_tokens: opts.targetTokens, tolerance: opts.tolerance, window_tokens: opts.windowTokens, overlap_tokens: opts.overlapTokens, contamination_max: THRESHOLDS.contamination_max, item_contamination_max: THRESHOLDS.item_contamination_max, regroup_windows: regroupWindows },
      public_index: { sources: index.sources, ngrams: index.ngrams, sources_sha256: index.sourcesSha256, source_list_sha256: index.sourceListSha256 },
      conversations: results,
      totals,
      abilities,
    };
  };
  return { calls, estimateUsd, regroup, finish };
}

/** Runs a plan's calls, then its regrouped windows' calls, and writes nothing. */
export async function runPlan(plan: CandidatePlan, clients: ModelClient[], concurrency: number): Promise<CandidateReport> {
  const first = await runCalls(plan.calls, clients, concurrency);
  const second = await runCalls(plan.regroup(), clients, concurrency);
  return plan.finish({ errors: first.errors + second.errors, cached: first.cached + second.cached });
}

export async function validateCandidates(opts: Options, clients: ModelClient[], index = buildPublicIndex(opts.beamDir, opts.publicIndexPath), regroupWindows = REGROUP_WINDOWS): Promise<CandidateReport> {
  return runPlan(planCandidates(opts, clients, index, regroupWindows), clients, opts.concurrency);
}

export function writeCandidateReport(path: string, report: CandidateReport): string {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(path, text);
  return sha256(text);
}

export function summaryLines(report: CandidateReport, reportSha256: string): string[] {
  const t = report.totals;
  const kv = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
  const gates = Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('gate_')).sort());
  return [
    `rs1-validate-candidates ${kv({ conversations: t.conversations, checked: t.checked, drop: t.drop, incomplete: t.incomplete, unfinished: t.unfinished, drop_length: t.drop_length, drop_contamination: t.drop_contamination, fillable: t.fillable })}`,
    `rs1-validate-candidates ${kv({ candidates: t.candidates, pass: t.pass, fail: t.fail, ...gates })}`,
    ...ABILITIES.map(a => `rs1-validate-candidates ${kv({ ability: a, pass: report.abilities[a].pass, fail: report.abilities[a].fail })}`),
    `rs1-validate-candidates ${kv({ calls: t.calls, support_calls: t.support_calls, absence_calls: t.absence_calls, support_tokens: t.support_tokens, absence_tokens: t.absence_tokens, cached_calls: t.cached_calls, validator_errors: t.validator_errors, windows: t.windows })}`,
    `rs1-validate-candidates ${kv({ unusable: Object.values(report.conversations).reduce((s, c) => s + c.validator_errors.length, 0), ...Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('unusable_')).sort()), regrouped_windows: t.regrouped_windows, regroup_over_cap: t.regroup_over_cap, absence_single_calls: t.absence_single_calls })}`,
    `rs1-validate-candidates ${kv({ public_sources: report.public_index.sources, public_ngrams: report.public_index.ngrams, report_sha256: reportSha256 })}`,
  ];
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const num = (name: string, fallback: number) => {
    const v = flag(name), n = v === undefined ? fallback : Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new ValidateError(`${name} must be a positive number`);
    return n;
  };
  const setDir = flag('--set'), beamDir = flag('--beam-dir'), reportPath = flag('--report');
  const regroupWindows = Number(flag('--regroup-windows') ?? REGROUP_WINDOWS);
  if (!Number.isInteger(regroupWindows) || regroupWindows < 0) throw new ValidateError('--regroup-windows must be a whole number');
  if (!setDir || !beamDir || !reportPath) throw new ValidateError('--set, --beam-dir and --report are required');
  const fake = argv.includes('--fake');
  if (fake === argv.includes('--paid')) throw new ValidateError('pass exactly one of --fake and --paid');
  requireRs1Window(argv, { what: 'paid candidate validation', keyless: fake, caps: () => ledgerCaps(budgetOptionsFrom(argv).ledgerPath, flag('--budget-run-id')) });
  if (!fake) {
    if (!process.env.RS1_GEMINI_API_KEY) throw new ValidateError('paid candidate validation needs RS1_GEMINI_API_KEY, the dedicated paid-tier Gemini key; GEMINI_API_KEY is never used');
    process.env.GEMINI_API_KEY = process.env.RS1_GEMINI_API_KEY;
  }
  const opts: Options = {
    setDir: resolve(setDir), beamDir: resolve(beamDir), reportPath: resolve(reportPath),
    cacheDir: resolve(flag('--cache') ?? join(dirname(resolve(setDir)), 'validate-cache')), publicIndexPath: flag('--public-index'),
    targetTokens: num('--target-tokens', DEFAULTS.targetTokens), tolerance: num('--tolerance', DEFAULTS.tolerance),
    windowTokens: num('--window-tokens', DEFAULTS.windowTokens), overlapTokens: num('--overlap-tokens', DEFAULTS.overlapTokens),
    concurrency: num('--concurrency', DEFAULTS.concurrency),
  };
  if (!existsSync(join(opts.setDir, 'conversations'))) throw new ValidateError(`${opts.setDir} holds no conversations/`);
  const geminiKey = process.env.GEMINI_API_KEY, anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!fake && (!geminiKey || !anthropicKey)) throw new ValidateError('paid candidate validation needs GEMINI_API_KEY and ANTHROPIC_API_KEY');
  const clients = fake ? VALIDATOR_IDS.map(id => fakeClient(`fake-${id}`)) : [recordingGeminiClient(geminiKey!), recordingAnthropicClient(anthropicKey!)];
  const plan = planCandidates(opts, clients, buildPublicIndex(opts.beamDir, opts.publicIndexPath), regroupWindows);
  const paid = !fake && plan.calls.some(c => !c.cached);
  if (paid) requirePaidArm(argv, { arm: 'rs1 validate-candidates', estimateUsd: plan.estimateUsd });
  const started = paid ? startPaidRun('rs1-validate-candidates', { ...budgetOptionsFrom(argv), estimateUsd: plan.estimateUsd }) : null;
  try {
    const report = await runPlan(plan, clients, opts.concurrency);
    for (const line of summaryLines(report, writeCandidateReport(opts.reportPath, report))) console.log(line);
    return 0;
  } finally {
    if (started) { started.guard.uninstall(); started.run.close(); }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: Error) => {
    const known = error instanceof ValidateError || error instanceof PaidArmRefusal || error instanceof BudgetExceededError || error instanceof WindowRefusal;
    process.stderr.write(known ? `rs1-validate-candidates refused: ${error.message}\n` : `rs1-validate-candidates error class=${error.name} sha256=${sha256(String(error.message)).slice(0, 16)}\n`);
    process.exit(2);
  });
}
