/**
 * LongMemEval items as validate.ts input (the SOTA loop's answerability check, W1-b). Each LongMemEval-S item becomes
 * its own one-conversation set in the layout eval/custody/rs1/validate.ts reads, so the BEAM support check (two
 * validators, gemini-3.8-flash and claude-haiku-5-5) runs on LongMemEval unchanged. One set per item, because
 * LongMemEval-S haystacks share filler sessions: in one set, validate.ts's conversation near-duplicate gate would drop
 * most of them.
 *
 *   bun eval/runner/sota/lme-support.ts build --beam-dir <public BEAM checkout> --out <dir> [--ids a,b | --suite lme-s-hard]
 *   bun eval/runner/sota/lme-support.ts collect --out <dir> --verdicts <file>
 *
 * build writes <out>/sets/<question id>/conversations/c001/, an empty public index (<out>/empty-index.bin, so the BEAM
 * contamination gates pass trivially: LongMemEval is not BEAM) and <out>/build.json (ids, message numbers and counts).
 * Each set's chat is the item's whole haystack, 98,000 to 106,000 cl100k tokens on lme-s-hard (about 115,000 in
 * LongMemEval's own count), numbered from 1 in haystack order, with a
 * "session" message before each session that carries its date, because temporal and knowledge-update answers depend on
 * when a session happened. The question carries the date it was asked for the same reason.
 *
 *   - A non-abstention item cites every message of its answer sessions (LongMemEval's gold evidence), date lines
 *     included, so the validators see what the oracle reader will see. Its has_answer turns, a subset LongMemEval marks,
 *     are recorded in build.json and are not what validate.ts checks.
 *   - An abstention item (question id ending _abs) cites nothing, so validate.ts scans the whole haystack for an answer
 *     (its absence gate).
 *   - Each item takes the slot of the BEAM ability closest to its LongMemEval type (SLOT_FOR), so validate.ts reads the
 *     reference answer from that ability's field.
 *
 * Run validate.ts once per set, with the empty index and a wide length gate (build prints the command), writing
 * <out>/reports/<question id>.json. collect then writes the verdicts as a nightly-item-support/1 file: per item, each
 * validator's verdict, the gates and the cited count; ids and gates only. collect exits 1 unless every item has a verdict
 * from both validators and none errored.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ANSWER_FIELD, Bloom, fakeClient, planValidation, publicSources, VALIDATOR_IDS, type Ability, type PublicIndex, type Report } from '../../custody/rs1/validate.ts';
import { readBeamPaths } from '../../custody/rs1/beam-paths.ts';
import { loadSplit } from '../decisions/splits.ts';
import { LME_S_FILE, readDatasetFile } from '../memory-qa/corpus.ts';
import { loadDevSet } from '../nightly/devset.ts';
import { encodingCount } from '../systems/render-v2.ts';

export const LME_SUPPORT_SCHEMA = 'sota-lme-support-build/1';
export const CID = 'c001';
/** The length gate validate.ts applies: about 100,000 cl100k tokens per LongMemEval-S haystack, with room either way. */
export const TARGET_TOKENS = 100_000;
export const TOLERANCE = 0.9;

export interface LmeRecord {
  question_id: string; question_type: string; question: string; question_date?: string; answer?: unknown;
  answer_session_ids: string[]; haystack_session_ids: string[]; haystack_dates?: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
}
export interface Message { id: number; role: string; content: string }

/** The BEAM ability whose reference-answer field and prompt fit each LongMemEval question type. */
export const SLOT_FOR: Record<string, Ability> = Object.fromEntries([
  ['single-session-user', 'information_extraction'],
  ['single-session-assistant', 'information_extraction'],
  ['single-session-preference', 'preference_following'],
  ['multi-session', 'multi_session_reasoning'],
  ['temporal-reasoning', 'temporal_reasoning'],
  ['knowledge-update', 'knowledge_update'],
] as const);

export interface BuiltItem {
  id: string;
  question_type: string;
  abstention: boolean;
  slot: string;
  sessions: number;
  messages: number;
  tokens: number;
  /** Inclusive message-number ranges of the answer sessions, date line first, in haystack order. */
  answer_sessions: Array<[number, number]>;
  /** Message numbers of the turns LongMemEval marks has_answer. */
  has_answer: number[];
  /** Messages the item cites: every message of its answer sessions, or 0 for an abstention item. */
  cited: number;
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export const isAbstention = (r: Pick<LmeRecord, 'question_id'>) => r.question_id.endsWith('_abs');

/** One item's chat, its validate.ts item and what build.json records about it. */
export function itemSet(r: LmeRecord): { chat: Message[]; slot: string; item: Record<string, unknown>; built: BuiltItem } {
  const abstention = isAbstention(r);
  const ability: Ability | undefined = abstention ? 'abstention' : SLOT_FOR[r.question_type];
  if (!ability) throw new Error(`${r.question_id}: no slot for question type ${r.question_type}`);
  const answers = new Set(r.answer_session_ids);
  const missing = r.answer_session_ids.filter(s => !r.haystack_session_ids.includes(s));
  if (missing.length) throw new Error(`${r.question_id}: ${missing.length} answer sessions are not in the haystack`);
  const chat: Message[] = [];
  const ranges: Array<[number, number]> = [];
  const hasAnswer: number[] = [];
  r.haystack_sessions.forEach((turns, s) => {
    const first = chat.length + 1;
    chat.push({ id: first, role: 'session', content: `Session date: ${r.haystack_dates?.[s] ?? 'unknown'}` });
    for (const t of turns) {
      chat.push({ id: chat.length + 1, role: t.role, content: t.content });
      if (t.has_answer) hasAnswer.push(chat.length);
    }
    if (answers.has(r.haystack_session_ids[s]!)) ranges.push([first, chat.length]);
  });
  const cited = abstention ? [] : ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
  const slot = `${ability}#0`;
  const question = r.question_date ? `(Asked on ${r.question_date}.) ${r.question}` : r.question;
  const item = { question, [ANSWER_FIELD[ability]]: String(r.answer ?? ''), ...(abstention ? {} : { source_chat_ids: cited }) };
  return {
    chat, slot, item,
    built: { id: r.question_id, question_type: r.question_type, abstention, slot, sessions: r.haystack_sessions.length, messages: chat.length,
      tokens: chat.reduce((n, m) => n + encodingCount('cl100k_base', m.content), 0), answer_sessions: ranges, has_answer: hasAnswer, cited: cited.length },
  };
}

/** Writes one item's set in the layout validate.ts's loadConversation reads, and returns the set directory. */
export function writeItemSet(root: string, r: LmeRecord): { dir: string; built: BuiltItem } {
  const { chat, slot, item, built } = itemSet(r);
  const dir = join(root, 'sets', r.question_id);
  const conv = join(dir, 'conversations', CID);
  for (const sub of ['beam/1', 'selection', 'rubric/1']) mkdirSync(join(conv, sub), { recursive: true });
  writeFileSync(join(conv, 'beam', '1', 'chat.json'), JSON.stringify(chat));
  writeFileSync(join(conv, 'selection', '1.json'), JSON.stringify({ slots: { [slot]: r.question_id } }));
  writeFileSync(join(conv, 'rubric', '1', `${slot}.json`), JSON.stringify({ item }));
  writeFileSync(join(conv, 'manifest.json'), JSON.stringify({ steps: { 'select@1': { status: 'done' }, 'rubric@1': { status: 'done' } } }));
  return { dir, built };
}

/**
 * An empty public 13-gram index in validate.ts's cache format, keyed to the BEAM checkout's file list so
 * buildPublicIndex loads it instead of indexing BEAM. LongMemEval text is not BEAM text, so no item can be a public BEAM
 * copy; an empty index makes both contamination gates pass without reading BEAM.
 */
export function writeEmptyIndex(beamDir: string, path: string): void {
  const sources = publicSources(beamDir);
  const bloom = Bloom.forCount(0);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bloom.bits);
  writeFileSync(`${path}.json`, JSON.stringify({ schema: 'rs1-public-13gram/v1', sources_sha256: sha256(sources.map(p => `${relative(beamDir, p)} ${statSync(p).size}\n`).join('')), m: bloom.m, k: bloom.k, ngrams: 0, questions: [] }));
}

/** The same empty index in memory, for planning without a BEAM checkout. */
export const emptyIndex = (): PublicIndex => ({ bloom: Bloom.forCount(0), questions: new Set(), paths: [], sources: 0, ngrams: 0, sourcesSha256: '', sourceListSha256: readBeamPaths().sha256 });

export function selectRecords(records: LmeRecord[], ids: readonly string[]): LmeRecord[] {
  const sealed = new Set(loadSplit('lme-s').sealed);
  const refused = ids.filter(id => sealed.has(id));
  if (refused.length) throw new Error(`${refused.length} ids are in the sealed LongMemEval-S split`);
  const byId = new Map(records.map(r => [r.question_id, r]));
  const unknown = ids.filter(id => !byId.has(id));
  if (unknown.length) throw new Error(`${unknown.length} ids are not LongMemEval-S questions: ${unknown.slice(0, 3).join(', ')}`);
  return ids.map(id => byId.get(id)!);
}

/** validate.ts's worst-case price for every set, from its own planner with fake clients priced as the real validators. */
export function worstCaseUsd(setDirs: string[]): number {
  const clients = VALIDATOR_IDS.map(id => fakeClient(`fake-${id}`));
  return setDirs.reduce((sum, setDir) => sum + planValidation({ setDir, beamDir: '', reportPath: '', targetTokens: TARGET_TOKENS, tolerance: TOLERANCE,
    windowTokens: 60_000, overlapTokens: 2_000, concurrency: 1 }, clients, emptyIndex()).estimateUsd, 0);
}

export function build(o: { records: LmeRecord[]; ids: readonly string[]; out: string; beamDir: string | null }): { items: BuiltItem[]; worstCaseUsd: number } {
  const chosen = selectRecords(o.records, o.ids);
  const written = chosen.map(r => writeItemSet(o.out, r));
  if (o.beamDir) writeEmptyIndex(o.beamDir, join(o.out, 'empty-index.bin'));
  const items = written.map(w => w.built);
  const usd = worstCaseUsd(written.map(w => w.dir));
  writeFileSync(join(o.out, 'build.json'), JSON.stringify({ schema: LME_SUPPORT_SCHEMA, dataset: { path: LME_S_FILE.path, sha256: LME_S_FILE.sha256 },
    validate_sha256: sha256(readFileSync(resolve(import.meta.dir, '../../custody/rs1/validate.ts'))), target_tokens: TARGET_TOKENS, tolerance: TOLERANCE, items }, null, 1) + '\n');
  return { items, worstCaseUsd: usd };
}

// ─── collect ─────────────────────────────────────────────────────────

export type Verdict = 'supported' | 'unsupported' | 'validator_error';
export interface SupportItem { checked: boolean; verdicts?: Record<string, Verdict>; gates?: string[]; cited?: number; source: string; reason?: string }

/** One item's verdicts from its validate.ts report: a support:, absence: or validator_error: gate names the validator. */
export function itemVerdict(built: BuiltItem, report: Report | null): SupportItem {
  const source = 'sota-w1-validate';
  if (!report) return { checked: false, source, reason: 'no validate report' };
  const conv = report.conversations[CID];
  const result = conv?.items[built.slot];
  if (!conv || !result) return { checked: false, source, reason: conv ? `conversation ${conv.status}: ${conv.reasons.join(', ')}` : 'the report has no conversation' };
  const gates = [...result.gates].sort();
  const verdicts = Object.fromEntries(report.validators.map(v => [v,
    gates.includes(`validator_error:${v}`) ? 'validator_error' : gates.includes(`support:${v}`) || gates.includes(`absence:${v}`) ? 'unsupported' : 'supported'] as const));
  const uncited = gates.includes('uncited');
  return { checked: true, ...(uncited ? {} : { verdicts }), gates, cited: built.cited, source };
}

export function collect(out: string): { file: Record<string, unknown>; complete: boolean; counts: Record<string, number> } {
  const b = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8')) as { schema: string; items: BuiltItem[]; validate_sha256: string };
  if (b.schema !== LME_SUPPORT_SCHEMA) throw new Error(`${out}/build.json is not a ${LME_SUPPORT_SCHEMA} file`);
  const reports = new Map(b.items.map(i => {
    const path = join(out, 'reports', `${i.id}.json`);
    return [i.id, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Report : null];
  }));
  const validators = [...new Set([...reports.values()].flatMap(r => r?.validators ?? []))];
  const items = Object.fromEntries(b.items.map(i => [i.id, itemVerdict(i, reports.get(i.id)!)]));
  const counts: Record<string, number> = { items: b.items.length, checked: 0, both_supported: 0, both_unsupported: 0, one_unsupported: 0, uncited: 0, validator_error: 0, unchecked: 0 };
  for (const x of Object.values(items)) {
    if (!x.checked) { counts.unchecked!++; continue; }
    counts.checked!++;
    if (!x.verdicts) { counts.uncited!++; continue; }
    const v = Object.values(x.verdicts);
    if (v.includes('validator_error')) counts.validator_error!++;
    else if (v.every(y => y === 'unsupported')) counts.both_unsupported!++;
    else if (v.every(y => y === 'supported')) counts.both_supported!++;
    else counts.one_unsupported!++;
  }
  const complete = validators.length === 2 && counts.unchecked === 0 && counts.validator_error === 0
    && Object.values(items).every(x => !x.verdicts || Object.keys(x.verdicts).length === 2);
  const file = {
    schema: 'nightly-item-support/1', suite: 'lme-s-hard',
    about: `Whether each lme-s-hard item's reference answer is supported by its answer sessions (every message of them, session dates included), from validate.ts (sha256 ${b.validate_sha256}) run once per item on eval/runner/sota/lme-support.ts sets with an empty public index. A gate support:<validator> means that validator found the answer unsupported; for an abstention item, absence:<validator> means that validator found an answer somewhere in the haystack. Ids and gates only.`,
    validators, items,
  };
  return { file, complete, counts };
}

// ─── CLI ─────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag('--out');
  if (!out) throw new Error('--out <dir> is required');
  if (argv[0] === 'build') {
    const beamDir = flag('--beam-dir');
    if (!beamDir) throw new Error('--beam-dir <public BEAM checkout> is required: validate.ts keys its public index to that checkout');
    const suite = flag('--suite') ?? 'lme-s-hard';
    const ids = flag('--ids')?.split(',').filter(Boolean) ?? loadDevSet().suites.find(s => s.id === suite)?.items.map(i => i.id);
    if (!ids?.length) throw new Error(`the dev set has no suite ${suite}`);
    const records = JSON.parse(readDatasetFile(LME_S_FILE, 'lme-s')) as LmeRecord[];
    const r = build({ records, ids, out: resolve(out), beamDir: resolve(beamDir) });
    const tokens = r.items.map(i => i.tokens).sort((a, b) => a - b);
    console.log(`lme-support build items=${r.items.length} abstention=${r.items.filter(i => i.abstention).length} tokens_min=${tokens[0]} tokens_max=${tokens.at(-1)} worst_case_usd=${r.worstCaseUsd.toFixed(3)}`);
    console.log(`per set: bun eval/custody/rs1/validate.ts --set ${resolve(out)}/sets/<id> --beam-dir ${resolve(beamDir)} --report ${resolve(out)}/reports/<id>.json --public-index ${resolve(out)}/empty-index.bin --cache ${resolve(out)}/cache --target-tokens ${TARGET_TOKENS} --tolerance ${TOLERANCE} (--fake | --paid ...)`);
    return 0;
  }
  if (argv[0] === 'collect') {
    const verdicts = flag('--verdicts');
    if (!verdicts) throw new Error('--verdicts <file> is required');
    const r = collect(resolve(out));
    mkdirSync(dirname(resolve(verdicts)), { recursive: true });
    const text = JSON.stringify(r.file, null, 1) + '\n';
    writeFileSync(resolve(verdicts), text);
    console.log(`lme-support collect ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ')} complete=${r.complete} sha256=${sha256(text)}`);
    return r.complete ? 0 : 1;
  }
  throw new Error('usage: lme-support.ts build|collect --out <dir> ...');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error: Error) => { console.error(`lme-support refused: ${error.message}`); process.exit(2); });
}
