/**
 * Sealed confirmation set generator (plan amendment 1).
 *
 * Builds a LongMemEval-style corpus from scratch: fictional personas, a
 * planned timeline of chat sessions, five questions per persona (one each of
 * single-session fact, multi-session aggregation, temporal reasoning,
 * knowledge update and abstention) and generic filler sessions. Labels (gold
 * session ids and answers) come from the generation ledger, never from any
 * system under test.
 *
 * The generator model is OpenAI gpt-6-sol. Earlier gbrain-evals corpora were
 * written by Claude Opus 4.5; LongMemEval itself was written with Llama 3 70B
 * Instruct plus GPT-4o question proposals and human edits.
 *
 * Output (private, never committed):
 *   <out>/questions.json   system-under-test input, allowlisted fields only
 *   <out>/labels.json      gold answers and session ids
 *   <out>/ledger.json      every seed, plan, attempt, audit and id mapping
 *   <out>/spend.jsonl      reservation ledger for every paid request
 *   <out>/cache/           content-addressed API responses (resume for free)
 * Output (public): --manifest <path>, aggregate counts and SHA-256 commitments.
 *
 * Run:
 *   bun eval/generators/sealed-confirmation-gen.ts --out ~/.capy/work/sealed/v1 \
 *     --personas 30 --seed 20260929 --cap-usd 38 --manifest eval/data/sealed-confirmation-v1/manifest.json
 *   add --only 1 for a one-persona pilot (writes no manifest).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  AUDIT_MODEL, AUDIT_SCHEMA, AUDIT_SYSTEM, FILLER_SYSTEM, FILLER_TOPICS, FILLER_VARIANTS, GENERATOR_MODEL, HOBBIES, HOUSEHOLDS,
  LIFE_ARCS, OCCUPATIONS, PLAN_SCHEMA, PLAN_SYSTEM, PROMPT_TEXTS, SESSION_SYSTEM, TURNS_SCHEMA, auditUser, fillerUser, planUser,
  sessionUser, type PlanSeed,
} from './sealed-confirmation-prompts.ts';
import {
  LABELS_SCHEMA, LlmClient, QUESTIONS_SCHEMA, QUESTION_TYPES, SpendLedger, canonicalJson, mapPool, sha256File, sha256Hex,
  validateLabelsFile, validateQuestionsFile, type Haystack, type LabelsFile, type QuestionType, type QuestionsFile, type SealedLabel,
  type Turn,
} from '../runner/sealed-confirmation-lib.ts';

export const GENERATOR_VERSION = 'sealed-confirmation-gen-v1';
export const FILLERS_PER_HAYSTACK = 35;
const PLAN_ATTEMPTS = 3;
const SESSION_ATTEMPTS = 3;

// ─── Plan types and validation ────────────────────────────────────

export interface PlanSession { key: string; date: string; topic: string; user_goal: string }
export interface PlanFact { key: string; session_key: string; statement: string; event_date: string | null; purpose: 'question_evidence' | 'near_miss' | 'background' }
export interface PlanQuestion {
  type: QuestionType; question: string; answer: string; evidence_fact_keys: string[]; evidence_session_keys: string[];
  question_date: string; must_never_state: string; rationale: string;
}
export interface Plan {
  persona: { name: string; age: number; occupation: string; home_description: string; household: string; hobbies: string[]; voice: string };
  sessions: PlanSession[];
  facts: PlanFact[];
  questions: PlanQuestion[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string | null) => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/** Structural checks on a persona plan. Returns problems; empty means the plan is usable. */
export function validatePlan(plan: Plan): string[] {
  const p: string[] = [];
  const sessions = plan.sessions ?? [];
  if (sessions.length < 18 || sessions.length > 22) p.push(`need 18-22 sessions, got ${sessions.length}`);
  const sessionByKey = new Map<string, PlanSession>();
  sessions.forEach((s, i) => {
    if (sessionByKey.has(s.key)) p.push(`duplicate session key ${s.key}`);
    sessionByKey.set(s.key, s);
    if (!validDate(s.date)) p.push(`session ${s.key} has invalid date ${s.date}`);
    if (i > 0 && !(s.date > sessions[i - 1].date)) p.push(`session dates must strictly increase (${sessions[i - 1].key} ${sessions[i - 1].date} then ${s.key} ${s.date})`);
  });
  const factByKey = new Map<string, PlanFact>();
  const factsPerSession = new Map<string, number>();
  for (const f of plan.facts ?? []) {
    if (factByKey.has(f.key)) p.push(`duplicate fact key ${f.key}`);
    factByKey.set(f.key, f);
    const s = sessionByKey.get(f.session_key);
    if (!s) { p.push(`fact ${f.key} names unknown session ${f.session_key}`); continue; }
    factsPerSession.set(f.session_key, (factsPerSession.get(f.session_key) ?? 0) + 1);
    if (f.event_date !== null && (!validDate(f.event_date) || f.event_date > s.date)) p.push(`fact ${f.key} event_date ${f.event_date} must be a valid date on or before its session date ${s.date}`);
  }
  for (const s of sessions) {
    const n = factsPerSession.get(s.key) ?? 0;
    if (n < 1 || n > 3) p.push(`session ${s.key} must carry 1-3 facts, has ${n}`);
  }
  if ((plan.facts ?? []).filter(f => f.purpose === 'near_miss').length < 4) p.push('need at least four near_miss facts');
  const lastDate = sessions.length ? sessions[sessions.length - 1].date : '';
  const types = (plan.questions ?? []).map(q => q.type);
  for (const t of QUESTION_TYPES) if (types.filter(x => x === t).length !== 1) p.push(`need exactly one ${t} question`);
  if ((plan.questions ?? []).length !== 5) p.push(`need exactly five questions, got ${(plan.questions ?? []).length}`);
  const usedEvidence = new Map<string, string>();
  for (const q of plan.questions ?? []) {
    if (!validDate(q.question_date) || !(q.question_date > lastDate)) p.push(`${q.type}: question_date ${q.question_date} must be after the last session ${lastDate}`);
    const facts = q.evidence_fact_keys.map(k => factByKey.get(k));
    if (facts.some(f => !f)) { p.push(`${q.type}: unknown evidence fact key`); continue; }
    for (const k of q.evidence_fact_keys) {
      const prior = usedEvidence.get(k);
      if (prior && prior !== q.type) p.push(`fact ${k} is evidence for both ${prior} and ${q.type}`);
      usedEvidence.set(k, q.type);
    }
    const derived = [...new Set(facts.map(f => f!.session_key))].sort();
    const listed = [...new Set(q.evidence_session_keys)].sort();
    if (canonicalJson(derived) !== canonicalJson(listed)) p.push(`${q.type}: evidence_session_keys ${listed.join(',')} disagree with the sessions of its facts ${derived.join(',')}`);
    if (q.type !== 'abstention' && facts.some(f => f!.purpose !== 'question_evidence')) p.push(`${q.type}: evidence facts must have purpose question_evidence`);
    const n = derived.length;
    const bad = (q.type === 'single-session-user' && n !== 1) || (q.type === 'multi-session' && (n < 2 || n > 4))
      || (q.type === 'temporal-reasoning' && (n < 1 || n > 3)) || (q.type === 'knowledge-update' && n < 2) || (q.type === 'abstention' && n < 1);
    if (bad) p.push(`${q.type}: wrong number of evidence sessions (${n})`);
    if (q.type === 'abstention' ? !q.must_never_state.trim() : q.must_never_state.trim() !== '') p.push(`${q.type}: must_never_state must be ${q.type === 'abstention' ? 'set' : 'empty'}`);
    if (!q.question.trim() || !q.answer.trim()) p.push(`${q.type}: empty question or answer`);
  }
  return p;
}

// ─── Seeds ────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const LETTERS = 'ABCDEFGHIJKLMNOPRSTVWZ'.split('');

export function personaSeeds(n: number, seed: number): PlanSeed[] {
  if (n > OCCUPATIONS.length || n * 3 > HOBBIES.length || n > LIFE_ARCS.length) throw new Error(`seed lists support at most ${Math.min(OCCUPATIONS.length, Math.floor(HOBBIES.length / 3), LIFE_ARCS.length)} personas`);
  const rng = mulberry32(seed);
  const occupations = shuffle(OCCUPATIONS, rng);
  const hobbies = shuffle(HOBBIES, rng);
  const arcs = shuffle(LIFE_ARCS, rng);
  const pairs = shuffle(LETTERS.flatMap(g => LETTERS.map(s => [g, s] as const)), rng);
  const start = Date.parse('2025-01-06T00:00:00Z');
  const span = Date.parse('2026-03-31T00:00:00Z') - start;
  return Array.from({ length: n }, (_, i) => ({
    persona_index: i + 1,
    given_initial: pairs[i][0],
    surname_initial: pairs[i][1],
    occupation: occupations[i],
    hobbies: hobbies.slice(i * 3, i * 3 + 3),
    life_arc: arcs[i],
    household: HOUSEHOLDS[Math.floor(rng() * HOUSEHOLDS.length)],
    start_date: new Date(start + Math.floor(rng() * span / 86400000) * 86400000).toISOString().slice(0, 10),
  }));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekday = (d: string) => WEEKDAYS[new Date(d + 'T00:00:00Z').getUTCDay()];

/** LongMemEval's timestamp format: "2023/05/20 (Sat) 02:21". */
export function lmeDate(d: string, minutes: number): string {
  const day = weekday(d).slice(0, 3);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${d.replace(/-/g, '/')} (${day}) ${hh}:${mm}`;
}

export function personaSheet(plan: Plan): string {
  const p = plan.persona;
  return `${p.name}, ${p.age}, ${p.occupation}. ${p.household}. Home: ${p.home_description}. Hobbies: ${p.hobbies.join(', ')}. Writing voice: ${p.voice}`;
}

export function transcript(turns: Turn[]): string {
  return turns.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
}

function checkTurns(turns: Turn[]): string[] {
  const p: string[] = [];
  if (turns.length < 8) p.push(`too few turns (${turns.length})`);
  turns.forEach((t, i) => { if (t.role !== (i % 2 === 0 ? 'user' : 'assistant')) p.push(`turn ${i + 1} should be ${i % 2 === 0 ? 'user' : 'assistant'}`); });
  if (turns.some(t => !t.content.trim())) p.push('empty turn');
  return p;
}

// ─── Generation ───────────────────────────────────────────────────

interface SessionAttempt { turns: Turn[]; audit: unknown; problems: string[] }
interface SessionRecord { persona_index: number; key: string; attempts: SessionAttempt[]; final: Turn[]; audit_passed: boolean }
interface PersonaRecord { seed: PlanSeed; plan_attempts: Array<{ plan: Plan | null; problems: string[] }>; plan: Plan | null }

interface Opts { out: string; personas: number; seed: number; capUsd: number; only: number | null; manifest: string | null; concurrency: number }

function parseArgs(argv: string[]): Opts {
  const arg = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const out = arg('--out');
  if (!out) throw new Error('--out <private dir> is required');
  return {
    out: resolve(out.replace(/^~/, process.env.HOME ?? '~')),
    personas: Number(arg('--personas') ?? 30),
    seed: Number(arg('--seed') ?? 20260929),
    capUsd: Number(arg('--cap-usd') ?? 38),
    only: arg('--only') ? Number(arg('--only')) : null,
    manifest: arg('--manifest'),
    concurrency: Number(arg('--concurrency') ?? 8),
  };
}

function openaiBody(model: string, effort: string, system: string, user: string, schemaName: string, schema: unknown, maxOut: number) {
  return {
    model,
    reasoning: { effort },
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
    max_output_tokens: maxOut,
  };
}

async function generatePlan(llm: LlmClient, seed: PlanSeed): Promise<PersonaRecord> {
  const rec: PersonaRecord = { seed, plan_attempts: [], plan: null };
  let feedback = '';
  for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
    const user = planUser(seed) + feedback;
    let plan: Plan | null = null;
    let problems: string[];
    try {
      const r = await llm.openai(`plan p${seed.persona_index} a${attempt}`, openaiBody(GENERATOR_MODEL, 'medium', PLAN_SYSTEM, user, 'persona_plan', PLAN_SCHEMA, 24000), 2500);
      plan = JSON.parse(r.text) as Plan;
      problems = validatePlan(plan);
    } catch (e: any) {
      problems = [`generation error: ${String(e?.message ?? e).slice(0, 300)}`];
    }
    rec.plan_attempts.push({ plan, problems });
    if (problems.length === 0) { rec.plan = plan; return rec; }
    feedback = `\n\nA previous attempt was rejected for these reasons; produce a complete new plan that fixes them:\n${problems.map(x => `- ${x}`).join('\n')}`;
  }
  return rec;
}

async function writeSession(llm: LlmClient, personaIndex: number, plan: Plan, s: PlanSession): Promise<SessionRecord> {
  const required = plan.facts.filter(f => f.session_key === s.key);
  const evidenceKeys = new Set(plan.questions.flatMap(q => q.evidence_fact_keys));
  const others = plan.facts.filter(f => f.session_key !== s.key);
  const neverState = plan.questions.filter(q => q.type === 'abstention').map(q => q.must_never_state);
  const leakChecks = others.filter(f => evidenceKeys.has(f.key) || f.purpose === 'near_miss');
  const brief = {
    persona_sheet: personaSheet(plan), date: s.date, weekday: weekday(s.date), topic: s.topic, user_goal: s.user_goal,
    required: required.map(f => ({ statement: f.statement, event_date: f.event_date })),
    forbidden: others.map(f => f.statement),
    never_state: neverState,
  };
  const rec: SessionRecord = { persona_index: personaIndex, key: s.key, attempts: [], final: [], audit_passed: false };
  let feedback = '';
  for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt++) {
    let turns: Turn[] = [];
    let audit: unknown = null;
    const problems: string[] = [];
    try {
      const w = await llm.openai(`session p${personaIndex} ${s.key} a${attempt}`, openaiBody(GENERATOR_MODEL, 'low', SESSION_SYSTEM, sessionUser(brief) + feedback, 'chat_session', TURNS_SCHEMA, 12000), 2000);
      turns = (JSON.parse(w.text) as { turns: Turn[] }).turns;
      problems.push(...checkTurns(turns));
      const statements = [...required.map(f => withDate(f)), ...leakChecks.map(f => withDate(f))];
      const a = await llm.openai(`audit p${personaIndex} ${s.key} a${attempt}`,
        openaiBody(AUDIT_MODEL, 'low', AUDIT_SYSTEM, auditUser(s.date, weekday(s.date), transcript(turns), statements, neverState), 'fact_audit', AUDIT_SCHEMA, 8000), 4000);
      const parsed = JSON.parse(a.text) as { statements: Array<{ index: number; verdict: string }>; details: Array<{ index: number; revealed: boolean }> };
      audit = parsed;
      const verdict = (i: number) => parsed.statements.find(x => x.index === i + 1)?.verdict ?? 'missing';
      required.forEach((f, i) => { if (verdict(i) !== 'stated') problems.push(`required fact not conveyed (${verdict(i)}): ${f.statement}`); });
      leakChecks.forEach((f, i) => { if (verdict(required.length + i) === 'stated') problems.push(`fact from another session leaked: ${f.statement}`); });
      neverState.forEach((d, i) => { if (parsed.details.find(x => x.index === i + 1)?.revealed !== false) problems.push(`revealed a detail that must stay unknown: ${d}`); });
    } catch (e: any) {
      problems.push(`generation error: ${String(e?.message ?? e).slice(0, 300)}`);
    }
    rec.attempts.push({ turns, audit, problems });
    if (turns.length) rec.final = turns;
    if (problems.length === 0) { rec.audit_passed = true; return rec; }
    feedback = `\n\nA previous draft was rejected for these reasons; write a new chat that fixes them:\n${problems.map(x => `- ${x}`).join('\n')}`;
  }
  return rec;
}

const withDate = (f: PlanFact) => f.event_date ? `${f.statement} (this happened on ${f.event_date})` : f.statement;

async function writeFiller(llm: LlmClient, topic: string, variant: string, index: number): Promise<{ index: number; topic: string; variant: string; turns: Turn[]; problems: string[] }> {
  try {
    const r = await llm.openai(`filler ${index}`, openaiBody(GENERATOR_MODEL, 'none', FILLER_SYSTEM, fillerUser(topic, variant), 'chat_session', TURNS_SCHEMA, 8000), 400);
    const turns = (JSON.parse(r.text) as { turns: Turn[] }).turns;
    return { index, topic, variant, turns, problems: checkTurns(turns) };
  } catch (e: any) {
    return { index, topic, variant, turns: [], problems: [`generation error: ${String(e?.message ?? e).slice(0, 300)}`] };
  }
}

// ─── Assembly ─────────────────────────────────────────────────────

export interface AssembleInput {
  setId: string;
  salt: string;
  seed: number;
  personas: Array<{ index: number; plan: Plan; sessions: Map<string, { turns: Turn[]; audit_passed: boolean }> }>;
  fillers: Array<{ index: number; turns: Turn[] }>;
}

/** Turn plans, written sessions and fillers into the questions and labels files, with opaque ids. */
export function assemble(input: AssembleInput): { questions: QuestionsFile; labels: LabelsFile; idMap: Record<string, string> } {
  const rng = mulberry32(input.seed ^ 0x5eed);
  const id = (prefix: string, key: string) => `${prefix}-${sha256Hex(`${input.salt}:${key}`).slice(0, 12)}`;
  const idMap: Record<string, string> = {};
  const haystacks: Haystack[] = [];
  const questions: QuestionsFile['questions'] = [];
  const labels: SealedLabel[] = [];
  const usableFillers = input.fillers.filter(f => f.turns.length > 0);
  for (const persona of input.personas) {
    const hay = id('hay', `p${persona.index}`);
    idMap[`p${persona.index}`] = hay;
    const sessionId = (key: string) => (idMap[`p${persona.index}:${key}`] ??= id('ses', `p${persona.index}:${key}`));
    const minuteOf = () => 7 * 60 + Math.floor(rng() * 15 * 60);
    const sessions = persona.plan.sessions.map(s => ({ session_id: sessionId(s.key), date: lmeDate(s.date, minuteOf()), turns: persona.sessions.get(s.key)!.turns }));
    const first = Date.parse(persona.plan.sessions[0].date + 'T00:00:00Z');
    const last = Date.parse(persona.plan.sessions[persona.plan.sessions.length - 1].date + 'T00:00:00Z');
    for (const f of shuffle(usableFillers, rng).slice(0, FILLERS_PER_HAYSTACK)) {
      const day = new Date(first + Math.floor(rng() * ((last - first) / 86400000 + 1)) * 86400000).toISOString().slice(0, 10);
      sessions.push({ session_id: sessionId(`filler-${f.index}`), date: lmeDate(day, minuteOf()), turns: f.turns });
    }
    sessions.sort((a, b) => a.date.localeCompare(b.date));
    haystacks.push({ haystack_id: hay, sessions });
    for (const q of persona.plan.questions) {
      const qid = id('scq', `p${persona.index}:${q.type}`);
      idMap[`p${persona.index}:q:${q.type}`] = qid;
      questions.push({ question_id: qid, haystack_id: hay, question: q.question, question_date: lmeDate(q.question_date, 18 * 60 + Math.floor(rng() * 300)) });
      const gold = [...new Set(q.evidence_session_keys)].map(sessionId);
      const flags = q.evidence_session_keys.filter(k => !persona.sessions.get(k)!.audit_passed).map(k => `evidence_session_audit_failed:${sessionId(k)}`);
      labels.push({
        question_id: qid, question_type: q.type, abstention: q.type === 'abstention', answer: q.answer,
        answer_session_ids: q.type === 'abstention' ? [] : gold,
        related_session_ids: q.type === 'abstention' ? gold : [],
        audit_flags: flags,
      });
    }
  }
  const order = shuffle(questions.map((_, i) => i), rng);
  return {
    questions: { schema: QUESTIONS_SCHEMA, set_id: input.setId, haystacks: shuffle(haystacks, rng), questions: order.map(i => questions[i]) },
    labels: { schema: LABELS_SCHEMA, set_id: input.setId, labels: order.map(i => labels[i]) },
    idMap,
  };
}

// ─── Main ─────────────────────────────────────────────────────────

function gitHead(): string {
  try { return execSync('git rev-parse HEAD', { cwd: import.meta.dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  mkdirSync(o.out, { recursive: true });
  const ledgerPath = join(o.out, 'ledger.json');
  const prior = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null;
  const salt: string = prior?.salt ?? randomBytes(16).toString('hex');
  const setId = `sealed-confirmation-v1-${o.seed}`;
  const spend = new SpendLedger(join(o.out, 'spend.jsonl'), o.capUsd);
  const llm = new LlmClient({ ledger: spend, cacheDir: join(o.out, 'cache') });
  const seeds = personaSeeds(o.personas, o.seed).filter(s => o.only === null || s.persona_index <= o.only);
  const log = (m: string) => process.stderr.write(`[sealed-gen] ${m} (spent $${spend.spentUsd.toFixed(4)})\n`);

  log(`planning ${seeds.length} personas`);
  const personas = await mapPool(seeds, o.concurrency, s => generatePlan(llm, s));
  const planned = personas.filter(p => p.plan);
  log(`plans: ${planned.length}/${personas.length} valid`);

  const jobs = planned.flatMap(p => p.plan!.sessions.map(s => ({ p, s })));
  let done = 0;
  const sessionRecords = await mapPool(jobs, o.concurrency, async ({ p, s }) => {
    const r = await writeSession(llm, p.seed.persona_index, p.plan!, s);
    if (++done % 20 === 0) log(`sessions ${done}/${jobs.length}`);
    return r;
  });
  log(`sessions: ${sessionRecords.filter(r => r.audit_passed).length}/${sessionRecords.length} passed audit`);

  const fillerSpecs = (o.only === null ? FILLER_TOPICS : FILLER_TOPICS.slice(0, 22)).flatMap(t => FILLER_VARIANTS.map(v => ({ t, v })));
  const fillers = await mapPool(fillerSpecs, o.concurrency, (f, i) => writeFiller(llm, f.t, f.v, i + 1));
  log(`fillers: ${fillers.filter(f => f.problems.length === 0).length}/${fillers.length} clean`);

  const complete = planned.filter(p => p.plan!.sessions.every(s => sessionRecords.find(r => r.persona_index === p.seed.persona_index && r.key === s.key)?.final.length));
  const { questions, labels, idMap } = assemble({
    setId, salt, seed: o.seed,
    personas: complete.map(p => ({
      index: p.seed.persona_index, plan: p.plan!,
      sessions: new Map(sessionRecords.filter(r => r.persona_index === p.seed.persona_index).map(r => [r.key, { turns: r.final, audit_passed: r.audit_passed }])),
    })),
    fillers: fillers.filter(f => f.problems.length === 0),
  });
  const problems = [...validateQuestionsFile(questions), ...validateLabelsFile(labels, questions)];
  if (problems.length) throw new Error(`assembled files are invalid:\n${problems.join('\n')}`);

  const generationDate = new Date().toISOString().slice(0, 10);
  writeFileSync(join(o.out, 'questions.json'), JSON.stringify(questions, null, 1) + '\n');
  writeFileSync(join(o.out, 'labels.json'), JSON.stringify(labels, null, 1) + '\n');
  const ledger = {
    generator_version: GENERATOR_VERSION, generation_date: generationDate, git_head: gitHead(), salt, seed: o.seed, set_id: setId,
    models: { generator: GENERATOR_MODEL, audit: AUDIT_MODEL }, personas, sessions: sessionRecords, fillers, id_map: idMap,
    dropped_personas: personas.filter(p => !complete.includes(p)).map(p => p.seed.persona_index),
    spend_usd: spend.spentUsd,
  };
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1) + '\n');
  log(`wrote ${questions.questions.length} questions over ${questions.haystacks.length} haystacks to ${o.out}`);
  if (ledger.dropped_personas.length) log(`WARNING: personas without a complete session set: ${ledger.dropped_personas.join(', ')}`);

  if (o.manifest && o.only === null) {
    const manifest = buildManifest({ out: o.out, questions, labels, ledger, generationDate });
    mkdirSync(join(o.manifest, '..'), { recursive: true });
    writeFileSync(o.manifest, JSON.stringify(manifest, null, 2) + '\n');
    log(`manifest: ${o.manifest}`);
  }
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

export function buildManifest(a: { out: string; questions: QuestionsFile; labels: LabelsFile; ledger: any; generationDate: string }) {
  const byType = Object.fromEntries(QUESTION_TYPES.map(t => [t, a.labels.labels.filter(l => l.question_type === t).length]));
  const goldPerType = Object.fromEntries(QUESTION_TYPES.map(t => [t, stats(a.labels.labels.filter(l => l.question_type === t).map(l => (l.abstention ? l.related_session_ids : l.answer_session_ids).length))]));
  const chars = a.questions.haystacks.map(h => h.sessions.reduce((n, s) => n + s.turns.reduce((m, t) => m + t.content.length, 0), 0));
  const sessions = a.ledger.sessions as SessionRecord[];
  const promptHashes = Object.fromEntries(Object.entries(PROMPT_TEXTS).map(([k, v]) => [k, sha256Hex(v)]));
  return {
    set: 'sealed-confirmation-v1',
    status: 'sealed',
    generation_date: a.generationDate,
    generator_version: GENERATOR_VERSION,
    generator_git_head: a.ledger.git_head,
    generator_source_sha256: {
      'eval/generators/sealed-confirmation-gen.ts': sha256File(join(import.meta.dir, 'sealed-confirmation-gen.ts')),
      'eval/generators/sealed-confirmation-prompts.ts': sha256File(join(import.meta.dir, 'sealed-confirmation-prompts.ts')),
      'eval/runner/sealed-confirmation-lib.ts': sha256File(join(import.meta.dir, '..', 'runner', 'sealed-confirmation-lib.ts')),
    },
    prompt_sha256: promptHashes,
    models: a.ledger.models,
    seed: a.ledger.seed,
    counts: {
      personas: a.questions.haystacks.length,
      questions: a.questions.questions.length,
      answerable_questions: a.labels.labels.filter(l => !l.abstention).length,
      by_type: byType,
      gold_sessions_per_question: goldPerType,
      sessions_per_haystack: stats(a.questions.haystacks.map(h => h.sessions.length)),
      persona_sessions_per_haystack: stats(a.questions.haystacks.map(h => h.sessions.length - FILLERS_PER_HAYSTACK)),
      characters_per_haystack: stats(chars),
      approx_tokens_per_haystack_chars_div_4: stats(chars.map(c => Math.round(c / 4))),
      filler_pool: (a.ledger.fillers as unknown[]).length,
      fillers_per_haystack: FILLERS_PER_HAYSTACK,
    },
    generation_quality: {
      plan_attempts: (a.ledger.personas as PersonaRecord[]).map(p => p.plan_attempts.length),
      persona_sessions_written: sessions.length,
      persona_sessions_passing_audit: sessions.filter(s => s.audit_passed).length,
      session_attempts_total: sessions.reduce((n, s) => n + s.attempts.length, 0),
      questions_with_audit_flags: a.labels.labels.filter(l => l.audit_flags.length > 0).length,
      dropped_personas: a.ledger.dropped_personas,
    },
    generation_cost_usd: Number(a.ledger.spend_usd.toFixed(4)),
    commitments: {
      'questions.json': { sha256: sha256File(join(a.out, 'questions.json')), bytes: readFileSync(join(a.out, 'questions.json')).length },
      'labels.json': { sha256: sha256File(join(a.out, 'labels.json')), bytes: readFileSync(join(a.out, 'labels.json')).length },
      'ledger.json': { sha256: sha256File(join(a.out, 'ledger.json')), bytes: readFileSync(join(a.out, 'ledger.json')).length },
    },
  };
}

if (import.meta.main) {
  main().catch(e => { process.stderr.write(`[sealed-gen] FATAL: ${e?.stack ?? e}\n`); process.exit(1); });
}
