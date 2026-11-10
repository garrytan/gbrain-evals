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
 *       [--window-tokens 60000] [--overlap-tokens 2000] [--concurrency 8]
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
 *     each validator about all of the conversation's abstention candidates in one prompt.
 * There is no duplicate gate among candidates: the select step skips a repeated question within an ability, and
 * validate.ts applies its duplicate gate to the selection.
 *
 * A validator call that errors or answers in the wrong shape leaves its conversation "incomplete": rerun, and replies
 * already cached are not bought again. Otherwise the conversation is "checked". The select step refuses a conversation
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
  ABILITIES, absencePrompt, ANSWER_FIELD, anthropicClient, buildPublicIndex, chunkMessages, DEFAULTS, fakeClient, geminiClient,
  ITEMS_PER_ABILITY, ngrams, normalize, runCalls, singleSourceShares, supportPrompt, THRESHOLDS, ValidateError, VALIDATOR_IDS,
  type Ability, type Message, type ModelClient, type Options, type PublicIndex,
} from './validate.ts';

/** validate.ts's reply-cache version, part of every cache file name, so both scripts read and write the same entries. */
const CACHE_VERSION = 'rs1-validate-cache/v2';
/** validate.ts's output allowance per call, which runCalls sends; the worst-case price assumes every reply uses it. */
const MAX_OUTPUT_TOKENS = 8192;
/** validate.ts's per-message framing in a window prompt ("[id N] ROLE: "), in cl100k tokens. */
const MESSAGE_FRAME_TOKENS = 8;

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

interface Call { client: number; prompt: string; tokens: number; cacheFile: string | null; cached: boolean; kind: 'support' | 'absence'; settle: (reply: string | null) => boolean }
export interface CandidateResult { pass: boolean; gates: string[] }
export interface CandidateConversation {
  status: 'checked' | 'drop' | 'incomplete' | 'unfinished';
  reasons: string[];
  chat_sha256: string | null;
  tokens: number | null;
  contamination_share: number | null;
  windows: number;
  candidates: Record<string, CandidateResult>;
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
export interface CandidatePlan { calls: Call[]; estimateUsd: number; finish: (run: { errors: number; cached: number }) => CandidateReport }

export function planCandidates(opts: Options, clients: ModelClient[], index: PublicIndex): CandidatePlan {
  if (clients.length !== 2 || clients[0].id.split(':')[0] === clients[1].id.split(':')[0]) throw new ValidateError('validation needs two validators from different families');
  const root = join(opts.setDir, 'conversations');
  const cids = existsSync(root) ? readdirSync(root).filter(n => /^c\d{3,}$/.test(n)).sort() : [];
  const results: Record<string, CandidateConversation> = {};
  /** Each checked conversation's normalized candidate questions, held in memory only, for the fillable count. */
  const questions = new Map<string, Map<string, string>>();
  const calls: Call[] = [];
  const low = Math.round(opts.targetTokens * (1 - opts.tolerance)), high = Math.round(opts.targetTokens * (1 + opts.tolerance));
  const call = (client: number, prompt: string, tokens: number, kind: Call['kind'], settle: Call['settle']) => {
    const cacheFile = opts.cacheDir ? join(opts.cacheDir, `${sha256(`${CACHE_VERSION}\0${clients[client].id}\0${prompt}`)}.json`) : null;
    calls.push({ client, prompt, tokens, cacheFile, cached: !!cacheFile && existsSync(cacheFile), kind, settle });
  };

  const measured = cids.flatMap(cid => {
    const result: CandidateConversation = { status: 'unfinished', reasons: [], chat_sha256: null, tokens: null, contamination_share: null, windows: 0, candidates: {}, passed: {} };
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
        call(c, prompt, tokens, 'support', reply => {
          const supported = reply === null ? undefined : jsonObject(reply)?.supported;
          if (typeof supported !== 'boolean') { fail(`validator_error:${clients[c].id}`); return false; }
          if (!supported) fail(`support:${clients[c].id}`);
          return true;
        });
      }
    }

    if (!abstention.length) continue;
    const windows = chunkMessages(contentTokens.map(t => t + MESSAGE_FRAME_TOKENS), opts.windowTokens, opts.overlapTokens);
    result.windows = windows.length;
    for (const [start, end] of windows) {
      const prompt = absencePrompt(conv.messages.slice(start, end), abstention.map(a => a.question));
      const tokens = contentTokens.slice(start, end).reduce((s, t) => s + t + MESSAGE_FRAME_TOKENS, 300);
      for (let c = 0; c < 2; c++) {
        call(c, prompt, tokens, 'absence', reply => {
          const answered = reply === null ? undefined : jsonObject(reply)?.answered;
          const usableReply = Array.isArray(answered);
          abstention.forEach((a, i) => {
            const gate = !usableReply ? `validator_error:${clients[c].id}` : answered.includes(i + 1) ? `absence:${clients[c].id}` : null;
            const item = result.candidates[a.key];
            if (gate) { item.pass = false; if (!item.gates.includes(gate)) item.gates.push(gate); }
          });
          return usableReply;
        });
      }
    }
  }

  // validate.ts's worst case: Claude counts about 1.47 tokens per cl100k token (the Claude 5 calibration in
  // eval/runner/systems/render-v2.ts), every reply uses its whole output allowance, and long-prompt rates apply above
  // their threshold.
  const estimateUsd = calls.filter(c => !c.cached).reduce((s, c) => {
    const id = clients[c.client].id.replace(/^fake-/, '');
    const p = chatPrice(id) ?? (() => { throw new ValidateError(`no price for ${id}`); })();
    const input = (id.startsWith('anthropic:') ? 1.47 : 1) * c.tokens;
    const rates = p.long && input > p.long.above_input_tokens ? p.long : p;
    return s + (input * rates.input + MAX_OUTPUT_TOKENS * rates.output) / 1e6;
  }, 0);

  const finish = (run: { errors: number; cached: number }): CandidateReport => {
    const of = (kind: Call['kind']) => calls.filter(c => c.kind === kind);
    const totals: Record<string, number> = {
      conversations: cids.length, checked: 0, drop: 0, incomplete: 0, unfinished: 0, fillable: 0, candidates: 0, pass: 0, fail: 0,
      calls: calls.length, support_calls: of('support').length, absence_calls: of('absence').length,
      support_tokens: of('support').reduce((s, c) => s + c.tokens, 0), absence_tokens: of('absence').reduce((s, c) => s + c.tokens, 0),
      cached_calls: run.cached, validator_errors: run.errors, windows: 0,
    };
    const abilities = Object.fromEntries(ABILITIES.map(a => [a, { pass: 0, fail: 0 }]));
    for (const [cid, result] of Object.entries(results)) {
      totals.windows += result.windows;
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
      params: { target_tokens: opts.targetTokens, tolerance: opts.tolerance, window_tokens: opts.windowTokens, overlap_tokens: opts.overlapTokens, contamination_max: THRESHOLDS.contamination_max, item_contamination_max: THRESHOLDS.item_contamination_max },
      public_index: { sources: index.sources, ngrams: index.ngrams, sources_sha256: index.sourcesSha256, source_list_sha256: index.sourceListSha256 },
      conversations: results,
      totals,
      abilities,
    };
  };
  return { calls, estimateUsd, finish };
}

export async function validateCandidates(opts: Options, clients: ModelClient[], index = buildPublicIndex(opts.beamDir, opts.publicIndexPath)): Promise<CandidateReport> {
  const plan = planCandidates(opts, clients, index);
  return plan.finish(await runCalls(plan.calls, clients, opts.concurrency));
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
  const clients = fake ? VALIDATOR_IDS.map(id => fakeClient(`fake-${id}`)) : [geminiClient(geminiKey!), anthropicClient(anthropicKey!)];
  const plan = planCandidates(opts, clients, buildPublicIndex(opts.beamDir, opts.publicIndexPath));
  const paid = !fake && plan.calls.some(c => !c.cached);
  if (paid) requirePaidArm(argv, { arm: 'rs1 validate-candidates', estimateUsd: plan.estimateUsd });
  const started = paid ? startPaidRun('rs1-validate-candidates', { ...budgetOptionsFrom(argv), estimateUsd: plan.estimateUsd }) : null;
  try {
    const report = plan.finish(await runCalls(plan.calls, clients, opts.concurrency));
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
