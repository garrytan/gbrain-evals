/**
 * RS1 fallback probe (GST-1886, GBEV-3's grant of 2026-11-17). Before the fallback validator is built, this asks
 * claude-sonnet-5-5 a few of the exact prompts claude-haiku-5-5 refused in a candidate check. For each it keeps only how
 * the reply ended: the stop reason, stop_details.category, the output token count, the kinds of content block, and
 * whether the reply has the shape the prompt asks for. It never keeps the reply text or the answer, writes nothing to the
 * reply cache, and changes no report, selection or set file.
 *
 *   bun eval/custody/rs1/probe-fallback.ts --set <out>/set --beam-dir <out>/tooling/beam --candidates <candidates.json>
 *       --pick <cid>:<kind>:<n>[,...] --out <probe.json> [--public-index <file>]
 *       (--fake | --paid --budget-run-id <id> --budget-ledger <RS1 ledger> --paid-window <unit> --window-cap-usd <n>)
 *
 * A pick names the n-th (from 1) refusal by claude-haiku-5-5 of one kind (support, absence or absence_single) in one
 * conversation's validator_errors, in the candidate report's order. The probe rebuilds every Haiku prompt with
 * validate-candidates.ts's own plan, over the same set and with the report's own length and window parameters, and with
 * no reply cache, so no call is cached and every window is planned batched and then regrouped. It matches each pick by
 * conversation, kind, candidate key and window, and requires the rebuilt prompt's cl100k count and the conversation's
 * chat SHA-256 to equal the report's. Any pick it can't match refuses the probe (exit 2) before any call.
 *
 * --fake answers with validate.ts's keyless stand-in, so a dry run shows which prompts the picks resolve to without a key
 * or a paid window. --paid follows validate-candidates.ts's paid path: the granted paid window, requirePaidArm with the
 * worst-case estimate, then startPaidRun, whose fetch guard prices and reserves each request in the budget ledger before
 * it is sent. Each pick is asked once, one at a time, and a refused request is not asked again.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BudgetExceededError, budgetOptionsFrom, chatPrice, startPaidRun } from '../../runner/budget-ledger.ts';
import { acceptsTemperature } from '../../runner/openai-judge-shim.ts';
import { ledgerCaps, PaidArmRefusal, requirePaidArm, requireRs1Window, WindowRefusal } from '../../runner/paid-arm.ts';
import { planCandidates, type CandidateReport, type RecordingClient, type StopRecord } from './validate-candidates.ts';
import { buildPublicIndex, DEFAULTS, fakeClient, VALIDATOR_IDS, type Options, type PublicIndex } from './validate.ts';

export const FALLBACK_MODEL = 'claude-sonnet-5-5';
export const FALLBACK_ID = `anthropic:${FALLBACK_MODEL}`;
/** validate.ts's output allowance per call. */
const MAX_OUTPUT_TOKENS = 8192;
const KINDS = ['support', 'absence', 'absence_single'] as const;
type Kind = (typeof KINDS)[number];

export class ProbeError extends Error {}

export interface Pick { conversation: string; kind: Kind; n: number }
/** A resolved pick: where the refused prompt sits, its size, how Haiku's reply ended, and the prompt itself (memory only). */
export interface Resolved extends Pick { candidate: string | null; window: number | null; prompt_tokens: number; haiku: StopRecord; prompt: string }
/** How the fallback's reply ended: provider words and numbers only. */
export interface FallbackRecord extends StopRecord { category: string; shape: 'ok' | 'wrong' | 'none' }

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');
const vocab = (v: unknown) => (typeof v === 'string' && /^[A-Za-z_]{1,40}$/.test(v) ? v : v === undefined || v === null ? 'none' : 'other');
const tokenCount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parsePicks(spec: string): Pick[] {
  const picks = spec.split(',').map(part => {
    const m = /^(c\d{3,}):(support|absence|absence_single):([1-9]\d*)$/.exec(part.trim());
    if (!m) throw new ProbeError(`--pick takes <cid>:<kind>:<n> items, not ${JSON.stringify(part)}`);
    return { conversation: m[1], kind: m[2] as Kind, n: Number(m[3]) };
  });
  if (new Set(picks.map(p => `${p.conversation}:${p.kind}:${p.n}`)).size !== picks.length) throw new ProbeError('--pick names a prompt twice');
  return picks;
}

const at = (cid: string, kind: string, candidate: string | null, window: number | null) => `${cid}|${kind}|${candidate ?? ''}|${window ?? ''}`;

/**
 * Every Haiku prompt of the set, keyed by conversation, kind, candidate and window: validate-candidates.ts's plan with no
 * cache, each Haiku call settled as unusable with a record that carries its index, then every window regrouped.
 */
function haikuPrompts(opts: Options, index: PublicIndex): { prompts: Map<string, { prompt: string; tokens: number }>; chats: Record<string, string | null> } {
  const stops = new Map<string, StopRecord>();
  const asked: string[] = [];
  const haiku: RecordingClient = { id: VALIDATOR_IDS[1], stops, complete: async () => { throw new ProbeError('the probe never sends a Haiku prompt'); } };
  const plan = planCandidates({ ...opts, cacheDir: undefined }, [fakeClient(VALIDATOR_IDS[0]), haiku], index, Number.MAX_SAFE_INTEGER);
  const settle = (calls: typeof plan.calls) => {
    for (const c of calls) {
      if (c.client !== 1) continue;
      stops.set(c.prompt, { stop: 'probe', output_tokens: asked.length, blocks: [] });
      asked.push(c.prompt);
      c.settle('');
    }
  };
  settle(plan.calls);
  settle(plan.regroup());
  const report = plan.finish({ errors: 0, cached: 0 });
  const prompts = new Map<string, { prompt: string; tokens: number }>();
  for (const [cid, conv] of Object.entries(report.conversations)) {
    for (const e of conv.validator_errors) {
      if (e.validator !== VALIDATOR_IDS[1] || e.stop !== 'probe') continue;
      prompts.set(at(cid, e.kind, e.candidate, e.window), { prompt: asked[e.output_tokens!], tokens: e.prompt_tokens });
    }
  }
  return { prompts, chats: Object.fromEntries(Object.entries(report.conversations).map(([cid, c]) => [cid, c.chat_sha256])) };
}

/** The picked refusals in the report, each matched to its rebuilt prompt; refuses on any mismatch. */
export function resolvePicks(opts: Options, index: PublicIndex, report: CandidateReport, picks: Pick[]): Resolved[] {
  for (const key of ['target_tokens', 'tolerance', 'window_tokens', 'overlap_tokens'] as const) {
    if (typeof report.params?.[key] !== 'number') throw new ProbeError(`the candidate report has no ${key}`);
  }
  const planned: Options = { ...opts, targetTokens: report.params.target_tokens, tolerance: report.params.tolerance, windowTokens: report.params.window_tokens, overlapTokens: report.params.overlap_tokens };
  const { prompts, chats } = haikuPrompts(planned, index);
  return picks.map(pick => {
    const conv = report.conversations[pick.conversation];
    if (!conv) throw new ProbeError(`${pick.conversation} is not in the candidate report`);
    if (!conv.chat_sha256 || chats[pick.conversation] !== conv.chat_sha256) throw new ProbeError(`${pick.conversation}'s chat is not the one the candidate report checked`);
    const refusals = conv.validator_errors.filter(e => e.validator === VALIDATOR_IDS[1] && e.stop === 'refusal' && e.kind === pick.kind);
    const entry = refusals[pick.n - 1];
    if (!entry) throw new ProbeError(`${pick.conversation} has ${refusals.length} Haiku refusal(s) of kind ${pick.kind}, not ${pick.n}`);
    const rebuilt = prompts.get(at(pick.conversation, entry.kind, entry.candidate, entry.window));
    if (!rebuilt) throw new ProbeError(`${pick.conversation}:${pick.kind}:${pick.n} names a prompt the set no longer plans`);
    if (rebuilt.tokens !== entry.prompt_tokens) throw new ProbeError(`${pick.conversation}:${pick.kind}:${pick.n} rebuilds at ${rebuilt.tokens} tokens, not the report's ${entry.prompt_tokens}`);
    return { ...pick, candidate: entry.candidate, window: entry.window, prompt_tokens: entry.prompt_tokens, haiku: { stop: entry.stop, output_tokens: entry.output_tokens, blocks: entry.blocks }, prompt: rebuilt.prompt };
  });
}

/** validate.ts's Anthropic request with the fallback model: no temperature (Claude 5 rejects it), the same output allowance. */
export const fallbackRequest = (prompt: string, maxTokens: number) => ({
  url: 'https://api.anthropic.com/v1/messages',
  body: { model: FALLBACK_MODEL, max_tokens: maxTokens, ...(acceptsTemperature(FALLBACK_MODEL) ? { temperature: 0 } : {}), messages: [{ role: 'user', content: prompt }] },
});

export type Ask = (prompt: string) => Promise<{ text: string | null; ended: Omit<FallbackRecord, 'shape'> }>;

/** The paid fallback: global fetch, so the paid run's guard prices and reserves the request; an error names no body. */
export function fallbackAsk(apiKey: string): Ask {
  return async prompt => {
    const none = (stop: string) => ({ text: null, ended: { stop, category: 'none', output_tokens: null, blocks: [] } });
    const { url, body } = fallbackRequest(prompt, MAX_OUTPUT_TOKENS);
    let res: Response;
    try { res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) }); } catch (error) {
      if (error instanceof BudgetExceededError) throw error;
      return none('send_error');
    }
    if (!res.ok) return none(`http_${res.status}`);
    let reply: any;
    try { reply = await res.json(); } catch { return none('bad_reply'); }
    const content = Array.isArray(reply?.content) ? reply.content : [];
    return {
      text: content.filter((b: { type?: unknown }) => b.type === 'text').map((b: { text?: unknown }) => String(b.text ?? '')).join(''),
      ended: { stop: vocab(reply?.stop_reason), category: vocab(reply?.stop_details?.category), output_tokens: tokenCount(reply?.usage?.output_tokens), blocks: [...new Set(content.map((b: { type?: unknown }) => vocab(b.type)))].sort() as string[] },
    };
  };
}

/** validate.ts's keyless stand-in under the fallback's id, for dry runs and tests. */
export function fakeAsk(): Ask {
  const fake = fakeClient(`fake-${FALLBACK_ID}`);
  return async prompt => {
    const text = await fake.complete(prompt, MAX_OUTPUT_TOKENS);
    return { text, ended: { stop: 'end_turn', category: 'none', output_tokens: null, blocks: ['text'] } };
  };
}

function shapeOf(kind: Kind, text: string | null): FallbackRecord['shape'] {
  if (text === null) return 'none';
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  let v: Record<string, unknown> | null = null;
  try { v = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null; } catch { v = null; }
  const ok = kind === 'support' ? typeof v?.supported === 'boolean' : Array.isArray(v?.answered);
  return ok ? 'ok' : 'wrong';
}

export interface ProbeReport {
  schema: 'rs1-fallback-probe/v1';
  fallback: string;
  candidates_report_sha256: string;
  picks: Array<Omit<Resolved, 'prompt'> & { fallback: FallbackRecord }>;
  totals: Record<string, number>;
}

/** Asks each resolved prompt once, in order, and keeps only how each reply ended. */
export async function probe(resolved: Resolved[], ask: Ask, candidatesSha256: string): Promise<ProbeReport> {
  const picks: ProbeReport['picks'] = [];
  for (const { prompt, ...where } of resolved) {
    const { text, ended } = await ask(prompt);
    picks.push({ ...where, fallback: { ...ended, shape: shapeOf(where.kind, text) } });
  }
  const totals: Record<string, number> = { asked: picks.length, shape_ok: picks.filter(p => p.fallback.shape === 'ok').length };
  for (const p of picks) totals[`stop_${p.fallback.stop.toLowerCase()}`] = (totals[`stop_${p.fallback.stop.toLowerCase()}`] ?? 0) + 1;
  return { schema: 'rs1-fallback-probe/v1', fallback: FALLBACK_ID, candidates_report_sha256: candidatesSha256, picks, totals };
}

export function summaryLines(report: ProbeReport, reportSha256: string): string[] {
  const kv = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') || '-' : v}`).join(' ');
  return [
    ...report.picks.map(p => `rs1-fallback-probe ${kv({ pick: `${p.conversation}:${p.kind}:${p.n}`, candidate: p.candidate ?? '-', window: p.window ?? '-', prompt_tokens: p.prompt_tokens, haiku_stop: p.haiku.stop, stop: p.fallback.stop, category: p.fallback.category, output_tokens: p.fallback.output_tokens ?? '-', blocks: p.fallback.blocks, shape: p.fallback.shape })}`),
    `rs1-fallback-probe ${kv({ ...report.totals, fallback: report.fallback, candidates_sha256: report.candidates_report_sha256, report_sha256: reportSha256 })}`,
  ];
}

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const setDir = flag('--set'), beamDir = flag('--beam-dir'), candidatesPath = flag('--candidates'), outPath = flag('--out'), pickSpec = flag('--pick');
  if (!setDir || !beamDir || !candidatesPath || !outPath || !pickSpec) throw new ProbeError('--set, --beam-dir, --candidates, --pick and --out are required');
  const fake = argv.includes('--fake');
  if (fake === argv.includes('--paid')) throw new ProbeError('pass exactly one of --fake and --paid');
  requireRs1Window(argv, { what: 'the fallback probe', keyless: fake, caps: () => ledgerCaps(budgetOptionsFrom(argv).ledgerPath, flag('--budget-run-id')) });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!fake && !apiKey) throw new ProbeError('the paid fallback probe needs ANTHROPIC_API_KEY');
  const picks = parsePicks(pickSpec);
  const raw = readFileSync(resolve(candidatesPath), 'utf8');
  const report = JSON.parse(raw) as CandidateReport;
  if (report.schema !== 'rs1-candidates/v1') throw new ProbeError(`${candidatesPath} is not a candidate report`);
  const opts: Options = {
    setDir: resolve(setDir), beamDir: resolve(beamDir), reportPath: resolve(outPath), publicIndexPath: flag('--public-index'),
    targetTokens: DEFAULTS.targetTokens, tolerance: DEFAULTS.tolerance, windowTokens: DEFAULTS.windowTokens, overlapTokens: DEFAULTS.overlapTokens, concurrency: 1,
  };
  const resolved = resolvePicks(opts, buildPublicIndex(opts.beamDir, opts.publicIndexPath), report, picks);
  const price = chatPrice(FALLBACK_ID) ?? (() => { throw new ProbeError(`no price for ${FALLBACK_ID}`); })();
  const estimateUsd = resolved.reduce((s, r) => s + (1.47 * r.prompt_tokens * price.input + MAX_OUTPUT_TOKENS * price.output) / 1e6, 0);
  if (!fake) requirePaidArm(argv, { arm: 'rs1 fallback probe', estimateUsd });
  const started = fake ? null : startPaidRun('rs1-fallback-probe', { ...budgetOptionsFrom(argv), estimateUsd });
  try {
    const out = await probe(resolved, fake ? fakeAsk() : fallbackAsk(apiKey!), sha256(raw));
    mkdirSync(dirname(opts.reportPath), { recursive: true });
    const text = JSON.stringify(out, null, 2) + '\n';
    writeFileSync(opts.reportPath, text);
    for (const line of summaryLines(out, sha256(text))) console.log(line);
    return 0;
  } finally {
    if (started) { started.guard.uninstall(); started.run.close(); }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: Error) => {
    const known = error instanceof ProbeError || error instanceof PaidArmRefusal || error instanceof BudgetExceededError || error instanceof WindowRefusal;
    process.stderr.write(known ? `rs1-fallback-probe refused: ${error.message}\n` : `rs1-fallback-probe error class=${error.name} sha256=${sha256(String(error.message)).slice(0, 16)}\n`);
    process.exit(2);
  });
}
