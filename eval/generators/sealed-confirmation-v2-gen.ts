/**
 * Sealed confirmation set v2 generator: a held-out set hard enough that five
 * retrieved chunks cannot cover the evidence (see sealed-confirmation-v2-prompts.ts).
 *
 * Same custody design as v1: fictional personas, a planned timeline of chat
 * sessions, questions whose labels come from the generation ledger (never from
 * a system under test), per-session fact audits, opaque ids, SHA-256
 * commitments, private files. What changes: 15-17 long sessions per persona
 * over 8-12 months, 30 long fillers per haystack (about LongMemEval-S size),
 * and five questions per persona that each need several sessions: two
 * multi-session (3-5 sessions each), one long-range temporal (2-4 sessions
 * spanning 90+ days), one knowledge update changed at least twice (3+
 * sessions), one abstention.
 *
 * Output (private, never committed):
 *   <out>/questions.json  <out>/labels.json  <out>/ledger.json  <out>/spend.jsonl  <out>/cache/
 * Output (public): --manifest <path>.
 *
 *   bun eval/generators/sealed-confirmation-v2-gen.ts generate --out ~/.capy/work/sealed-v2set \
 *     --personas 40 --seed 20261001 --cap-usd 48 --manifest eval/data/sealed-confirmation-v2/manifest.json
 *   bun eval/generators/sealed-confirmation-v2-gen.ts solvability --out ~/.capy/work/sealed-v2set \
 *     --cap-usd 60 --public eval/data/sealed-confirmation-v2/solvability.json
 * add --only N to generate a pilot of the first N personas (writes no manifest).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  AUDIT_MODEL_V2, AUDIT_SCHEMA, AUDIT_SYSTEM, FILLER_MODEL_V2, FILLER_SYSTEM_V2, FILLER_TOPICS_V2, FILLER_VARIANTS_V2, GENERATOR_MODEL_V2,
  HOBBIES_V2, HOUSEHOLDS_V2, SESSION_MODEL_V2, LIFE_ARCS_V2, OCCUPATIONS_V2, PLAN_SCHEMA_V2, PLAN_SYSTEM_V2, PROMPT_TEXTS_V2, QUESTION_SLOTS_V2, SESSION_SYSTEM_V2,
  TURNS_SCHEMA, auditUser, fillerUserV2, planUserV2, sessionUserV2, type PlanSeedV2,
} from './sealed-confirmation-v2-prompts.ts';
import { lmeDate, mulberry32, personaSheet, shuffle, transcript, weekday, type Plan, type PlanFact, type PlanSession } from './sealed-confirmation-gen.ts';
import {
  LABELS_SCHEMA, LlmClient, QUESTIONS_SCHEMA, QUESTION_TYPES, SpendLedger, appendAccessLog, canonicalJson, mapPool, readerPrompt, sha256File,
  sha256Hex, validateLabelsFile, validateQuestionsFile, type Haystack, type LabelsFile, type QuestionsFile, type SealedLabel, type Turn,
} from '../runner/sealed-confirmation-lib.ts';

export const GENERATOR_VERSION_V2 = 'sealed-confirmation-gen-v2';
export const FILLERS_PER_HAYSTACK_V2 = 30;
const PLAN_ATTEMPTS = 3;
const SESSION_ATTEMPTS = 3;
const DAY = 86400000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string | null) => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

/** Structural checks on a v2 persona plan. Empty means usable. */
export function validatePlanV2(plan: Plan): string[] {
  const p: string[] = [];
  const sessions = plan.sessions ?? [];
  if (sessions.length < 15 || sessions.length > 17) p.push(`need 15-17 sessions, got ${sessions.length}`);
  const sessionByKey = new Map<string, PlanSession>();
  sessions.forEach((s, i) => {
    if (sessionByKey.has(s.key)) p.push(`duplicate session key ${s.key}`);
    sessionByKey.set(s.key, s);
    if (!validDate(s.date)) p.push(`session ${s.key} has invalid date ${s.date}`);
    if (i > 0 && !(s.date > sessions[i - 1].date)) p.push(`session dates must strictly increase (${sessions[i - 1].key} ${sessions[i - 1].date} then ${s.key} ${s.date})`);
  });
  if (sessions.length > 1 && validDate(sessions[0].date) && validDate(sessions[sessions.length - 1].date)) {
    const span = days(sessions[0].date, sessions[sessions.length - 1].date);
    if (span < 225 || span > 380) p.push(`sessions must span eight to twelve months (${span} days)`);
  }
  const factByKey = new Map<string, PlanFact>();
  const perSession = new Map<string, number>();
  for (const f of plan.facts ?? []) {
    if (factByKey.has(f.key)) p.push(`duplicate fact key ${f.key}`);
    factByKey.set(f.key, f);
    const s = sessionByKey.get(f.session_key);
    if (!s) { p.push(`fact ${f.key} names unknown session ${f.session_key}`); continue; }
    perSession.set(f.session_key, (perSession.get(f.session_key) ?? 0) + 1);
    if (f.event_date !== null && (!validDate(f.event_date) || f.event_date > s.date)) p.push(`fact ${f.key} event_date ${f.event_date} must be a valid date on or before its session date ${s.date}`);
  }
  for (const s of sessions) { const n = perSession.get(s.key) ?? 0; if (n < 2 || n > 4) p.push(`session ${s.key} must carry 2-4 facts, has ${n}`); }
  const nearMiss = (plan.facts ?? []).filter(f => f.purpose === 'near_miss');
  if (nearMiss.length < 6 || new Set(nearMiss.map(f => f.session_key)).size < 4) p.push('need at least six near_miss facts over at least four sessions');
  const questions = plan.questions ?? [];
  const types = questions.map(q => q.type);
  if (questions.length !== 5) p.push(`need exactly five questions, got ${questions.length}`);
  for (const t of ['multi-session', 'temporal-reasoning', 'knowledge-update', 'abstention'] as const) {
    const want = QUESTION_SLOTS_V2.filter(x => x === t).length;
    if (types.filter(x => x === t).length !== want) p.push(`need exactly ${want} ${t} question(s)`);
  }
  if (types.includes('single-session-user' as never)) p.push('v2 has no single-session questions');
  const lastDate = sessions.length ? sessions[sessions.length - 1].date : '';
  const usedEvidence = new Map<string, number>();
  questions.forEach((q, qi) => {
    const tag = `${q.type}#${qi + 1}`;
    if (!validDate(q.question_date) || !(q.question_date > lastDate)) p.push(`${tag}: question_date ${q.question_date} must be after the last session ${lastDate}`);
    const facts = q.evidence_fact_keys.map(k => factByKey.get(k));
    if (facts.some(f => !f)) { p.push(`${tag}: unknown evidence fact key`); return; }
    for (const k of q.evidence_fact_keys) {
      const prior = usedEvidence.get(k);
      if (prior !== undefined && prior !== qi) p.push(`fact ${k} is evidence for two questions`);
      usedEvidence.set(k, qi);
    }
    const derived = [...new Set(facts.map(f => f!.session_key))].sort();
    const listed = [...new Set(q.evidence_session_keys)].sort();
    if (canonicalJson(derived) !== canonicalJson(listed)) p.push(`${tag}: evidence_session_keys ${listed.join(',')} disagree with the sessions of its facts ${derived.join(',')}`);
    if (q.type !== 'abstention' && facts.some(f => f!.purpose !== 'question_evidence')) p.push(`${tag}: evidence facts must have purpose question_evidence`);
    const n = derived.length;
    const dates = derived.map(k => sessionByKey.get(k)?.date ?? '').filter(Boolean).sort();
    const span = dates.length > 1 ? days(dates[0], dates[dates.length - 1]) : 0;
    if (q.type === 'multi-session' && (n < 3 || n > 5 || span < 60)) p.push(`${tag}: needs 3-5 evidence sessions at least 60 days apart (${n} sessions, ${span} days)`);
    if (q.type === 'temporal-reasoning' && (n < 2 || n > 4 || span < 90)) p.push(`${tag}: needs 2-4 evidence sessions spanning at least 90 days (${n} sessions, ${span} days)`);
    if (q.type === 'knowledge-update' && (n < 3 || span < 30)) p.push(`${tag}: needs at least 3 evidence sessions (an initial value and two changes) spanning 30+ days (${n}, ${span} days)`);
    if (q.type === 'abstention' && n < 2) p.push(`${tag}: needs at least 2 related sessions`);
    if (q.type === 'abstention' ? !q.must_never_state.trim() : q.must_never_state.trim() !== '') p.push(`${tag}: must_never_state must be ${q.type === 'abstention' ? 'set' : 'empty'}`);
    if (!q.question.trim() || !q.answer.trim()) p.push(`${tag}: empty question or answer`);
  });
  const multi = questions.filter(q => q.type === 'multi-session');
  if (multi.length === 2 && multi[0].evidence_fact_keys.some(k => multi[1].evidence_fact_keys.includes(k))) p.push('the two multi-session questions share evidence facts');
  return p;
}

// ─── Seeds ────────────────────────────────────────────────────────

const LETTERS = 'ABCDEFGHIJKLMNOPRSTVWZ'.split('');

export function personaSeedsV2(n: number, seed: number): PlanSeedV2[] {
  if (n > OCCUPATIONS_V2.length || n * 3 > HOBBIES_V2.length || n > LIFE_ARCS_V2.length) throw new Error(`v2 seed lists support at most ${Math.min(OCCUPATIONS_V2.length, Math.floor(HOBBIES_V2.length / 3), LIFE_ARCS_V2.length)} personas`);
  const rng = mulberry32(seed);
  const occupations = shuffle(OCCUPATIONS_V2, rng);
  const hobbies = shuffle(HOBBIES_V2, rng);
  const arcs = shuffle(LIFE_ARCS_V2, rng);
  const pairs = shuffle(LETTERS.flatMap(g => LETTERS.map(s => [g, s] as const)), rng);
  const start = Date.parse('2024-09-02T00:00:00Z');
  const span = Date.parse('2025-12-31T00:00:00Z') - start;
  return Array.from({ length: n }, (_, i) => ({
    persona_index: i + 1, given_initial: pairs[i][0], surname_initial: pairs[i][1], occupation: occupations[i],
    hobbies: hobbies.slice(i * 3, i * 3 + 3), life_arc: arcs[i], household: HOUSEHOLDS_V2[Math.floor(rng() * HOUSEHOLDS_V2.length)],
    start_date: new Date(start + Math.floor(rng() * span / DAY) * DAY).toISOString().slice(0, 10),
  }));
}

function checkTurns(turns: Turn[], minTurns: number): string[] {
  const p: string[] = [];
  if (turns.length < minTurns) p.push(`too few turns (${turns.length}, need ${minTurns})`);
  turns.forEach((t, i) => { if (t.role !== (i % 2 === 0 ? 'user' : 'assistant')) p.push(`turn ${i + 1} should be ${i % 2 === 0 ? 'user' : 'assistant'}`); });
  if (turns.some(t => !t.content.trim())) p.push('empty turn');
  return p;
}

// ─── Generation ───────────────────────────────────────────────────

interface SessionAttempt { turns: Turn[]; audit: unknown; problems: string[] }
export interface SessionRecord { persona_index: number; key: string; attempts: SessionAttempt[]; final: Turn[]; audit_passed: boolean }
interface PersonaRecord { seed: PlanSeedV2; plan_attempts: Array<{ plan: Plan | null; problems: string[] }>; plan: Plan | null }

function openaiBody(model: string, effort: string, system: string, user: string, schemaName: string, schema: unknown, maxOut: number) {
  return {
    model, reasoning: { effort },
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
    max_output_tokens: maxOut,
  };
}

async function generatePlan(llm: LlmClient, seed: PlanSeedV2): Promise<PersonaRecord> {
  const rec: PersonaRecord = { seed, plan_attempts: [], plan: null };
  let feedback = '';
  for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
    let plan: Plan | null = null;
    let problems: string[];
    try {
      const r = await llm.openai(`plan p${seed.persona_index} a${attempt}`, openaiBody(GENERATOR_MODEL_V2, 'medium', PLAN_SYSTEM_V2, planUserV2(seed) + feedback, 'persona_plan', PLAN_SCHEMA_V2, 32000), 3000);
      plan = JSON.parse(r.text) as Plan;
      problems = validatePlanV2(plan);
    } catch (e: any) {
      problems = [`generation error: ${String(e?.message ?? e).slice(0, 300)}`];
    }
    rec.plan_attempts.push({ plan, problems });
    if (problems.length === 0) { rec.plan = plan; return rec; }
    feedback = `\n\nA previous attempt was rejected for these reasons; produce a complete new plan that fixes them:\n${problems.map(x => `- ${x}`).join('\n')}`;
  }
  return rec;
}

const withDate = (f: PlanFact) => (f.event_date ? `${f.statement} (this happened on ${f.event_date})` : f.statement);

async function writeSession(llm: LlmClient, personaIndex: number, plan: Plan, s: PlanSession): Promise<SessionRecord> {
  const required = plan.facts.filter(f => f.session_key === s.key);
  const evidenceKeys = new Set(plan.questions.flatMap(q => q.evidence_fact_keys));
  const others = plan.facts.filter(f => f.session_key !== s.key);
  const neverState = plan.questions.filter(q => q.type === 'abstention').map(q => q.must_never_state);
  const leakChecks = others.filter(f => evidenceKeys.has(f.key) || f.purpose === 'near_miss');
  const brief = {
    persona_sheet: personaSheet(plan), date: s.date, weekday: weekday(s.date), topic: s.topic, user_goal: s.user_goal,
    required: required.map(f => ({ statement: f.statement, event_date: f.event_date })), forbidden: others.map(f => f.statement), never_state: neverState,
  };
  const rec: SessionRecord = { persona_index: personaIndex, key: s.key, attempts: [], final: [], audit_passed: false };
  let feedback = '';
  for (let attempt = 1; attempt <= SESSION_ATTEMPTS; attempt++) {
    let turns: Turn[] = [];
    let audit: unknown = null;
    const problems: string[] = [];
    try {
      const w = await llm.openai(`session p${personaIndex} ${s.key} a${attempt}`, openaiBody(SESSION_MODEL_V2, 'low', SESSION_SYSTEM_V2, sessionUserV2(brief) + feedback, 'chat_session', TURNS_SCHEMA, 16000), 2500);
      turns = (JSON.parse(w.text) as { turns: Turn[] }).turns;
      problems.push(...checkTurns(turns, 16));
      const statements = [...required.map(withDate), ...leakChecks.map(withDate)];
      const a = await llm.openai(`audit p${personaIndex} ${s.key} a${attempt}`,
        openaiBody(AUDIT_MODEL_V2, 'low', AUDIT_SYSTEM, auditUser(s.date, weekday(s.date), transcript(turns), statements, neverState), 'fact_audit', AUDIT_SCHEMA, 8000), 6000);
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

async function writeFiller(llm: LlmClient, topic: string, variant: string, index: number) {
  try {
    const r = await llm.openai(`filler ${index}`, openaiBody(FILLER_MODEL_V2, 'none', FILLER_SYSTEM_V2, fillerUserV2(topic, variant), 'chat_session', TURNS_SCHEMA, 12000), 400);
    const turns = (JSON.parse(r.text) as { turns: Turn[] }).turns;
    return { index, topic, variant, turns, problems: checkTurns(turns, 14) };
  } catch (e: any) {
    return { index, topic, variant, turns: [] as Turn[], problems: [`generation error: ${String(e?.message ?? e).slice(0, 300)}`] };
  }
}

// ─── Assembly ─────────────────────────────────────────────────────

export interface AssembleInputV2 {
  setId: string;
  salt: string;
  seed: number;
  personas: Array<{ index: number; plan: Plan; sessions: Map<string, { turns: Turn[]; audit_passed: boolean }> }>;
  fillers: Array<{ index: number; turns: Turn[] }>;
}

/** Plans, written sessions and fillers into the questions and labels files, with opaque ids. */
export function assembleV2(input: AssembleInputV2): { questions: QuestionsFile; labels: LabelsFile; idMap: Record<string, string> } {
  const rng = mulberry32(input.seed ^ 0x5eed2);
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
    for (const f of shuffle(usableFillers, rng).slice(0, FILLERS_PER_HAYSTACK_V2)) {
      const day = new Date(first + Math.floor(rng() * ((last - first) / DAY + 1)) * DAY).toISOString().slice(0, 10);
      sessions.push({ session_id: sessionId(`filler-${f.index}`), date: lmeDate(day, minuteOf()), turns: f.turns });
    }
    sessions.sort((a, b) => a.date.localeCompare(b.date));
    haystacks.push({ haystack_id: hay, sessions });
    persona.plan.questions.forEach((q, qi) => {
      const qid = id('scq', `p${persona.index}:q${qi + 1}:${q.type}`);
      idMap[`p${persona.index}:q${qi + 1}`] = qid;
      questions.push({ question_id: qid, haystack_id: hay, question: q.question, question_date: lmeDate(q.question_date, 18 * 60 + Math.floor(rng() * 300)) });
      const gold = [...new Set(q.evidence_session_keys)].map(sessionId);
      const flags = q.evidence_session_keys.filter(k => !persona.sessions.get(k)!.audit_passed).map(k => `evidence_session_audit_failed:${sessionId(k)}`);
      labels.push({
        question_id: qid, question_type: q.type, abstention: q.type === 'abstention', answer: q.answer,
        answer_session_ids: q.type === 'abstention' ? [] : gold, related_session_ids: q.type === 'abstention' ? gold : [], audit_flags: flags,
      });
    });
  }
  const order = shuffle(questions.map((_, i) => i), rng);
  return {
    questions: { schema: QUESTIONS_SCHEMA, set_id: input.setId, haystacks: shuffle(haystacks, rng), questions: order.map(i => questions[i]) },
    labels: { schema: LABELS_SCHEMA, set_id: input.setId, labels: order.map(i => labels[i]) },
    idMap,
  };
}

// ─── Chunk oracle ─────────────────────────────────────────────────

/** Session text the way gbrain's LongMemEval adapter renders a chat page body. */
export const sessionBody = (turns: Turn[]) => turns.map(t => `**${t.role}:** ${t.content}`).join('\n\n');

/**
 * Word windows approximating gbrain's recursive chunker (about 300 words with
 * a 50-word overlap). The oracle is generous on purpose: it is handed the
 * chunks that hold the ledger's evidence facts, which a retriever would still
 * have to find.
 */
export function chunkWords(text: string, size = 300, overlap = 50): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= size) return [words.join(' ')];
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    out.push(words.slice(i, i + size).join(' '));
    if (i + size >= words.length) break;
  }
  return out;
}

const contentWords = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9$.,:'-]+/g)?.map(w => w.replace(/[.,:']+$/, '')).filter(w => w.length > 3 || /\d/.test(w)) ?? []);

/** The chunk of a session that best matches a fact statement (most shared content words; earliest on ties). */
export function bestChunk(chunks: string[], statement: string): number {
  const want = contentWords(statement);
  let best = 0, score = -1;
  chunks.forEach((c, i) => {
    const have = contentWords(c);
    let n = 0;
    for (const w of want) if (have.has(w)) n++;
    if (n > score) { score = n; best = i; }
  });
  return best;
}

export interface OracleChunk { session_id: string; date: string; chunk_index: number; text: string }

/** Up to k chunks: the best chunk for each evidence fact, deduplicated, in session time order. */
export function chunkOracle(evidence: Array<{ session_id: string; date: string; turns: Turn[]; statements: string[] }>, k = 5): { chunks: OracleChunk[]; needed: number } {
  const picked: OracleChunk[] = [];
  const seen = new Set<string>();
  for (const s of [...evidence].sort((a, b) => a.date.localeCompare(b.date))) {
    const chunks = chunkWords(sessionBody(s.turns));
    for (const st of s.statements) {
      const i = bestChunk(chunks, st);
      const key = `${s.session_id}#${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push({ session_id: s.session_id, date: s.date, chunk_index: i, text: chunks[i] });
    }
  }
  return { chunks: picked.slice(0, k), needed: picked.length };
}

// ─── Manifest ─────────────────────────────────────────────────────

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

export function buildManifestV2(a: { out: string; questions: QuestionsFile; labels: LabelsFile; ledger: any; generationDate: string }) {
  const byType = Object.fromEntries(QUESTION_TYPES.map(t => [t, a.labels.labels.filter(l => l.question_type === t).length]));
  const gold = (t: string) => a.labels.labels.filter(l => l.question_type === t).map(l => (l.abstention ? l.related_session_ids : l.answer_session_ids).length);
  const goldPerType = Object.fromEntries(QUESTION_TYPES.filter(t => byType[t] > 0).map(t => [t, stats(gold(t))]));
  const chars = a.questions.haystacks.map(h => h.sessions.reduce((n, s) => n + s.turns.reduce((m, t) => m + t.content.length, 0), 0));
  const personaChars = (a.ledger.sessions as SessionRecord[]).map(s => s.final.reduce((n, t) => n + t.content.length, 0));
  const sessions = a.ledger.sessions as SessionRecord[];
  return {
    set: 'sealed-confirmation-v2',
    status: 'sealed',
    purpose: 'held-out confirmation hard enough that five retrieved chunks cannot cover the evidence; see docs/benchmarks/2026-10-01-sealed-confirmation-v2-protocol.md',
    generation_date: a.generationDate,
    generator_version: GENERATOR_VERSION_V2,
    generator_git_head: a.ledger.git_head,
    generator_source_sha256: Object.fromEntries(['eval/generators/sealed-confirmation-v2-gen.ts', 'eval/generators/sealed-confirmation-v2-prompts.ts', 'eval/generators/sealed-confirmation-gen.ts', 'eval/generators/sealed-confirmation-prompts.ts', 'eval/runner/sealed-confirmation-lib.ts']
      .map(f => [f, sha256File(join(import.meta.dir, '../..', f))])),
    prompt_sha256: Object.fromEntries(Object.entries(PROMPT_TEXTS_V2).map(([k, v]) => [k, sha256Hex(v)])),
    models: a.ledger.models,
    seed: a.ledger.seed,
    counts: {
      personas: a.questions.haystacks.length,
      questions: a.questions.questions.length,
      answerable_questions: a.labels.labels.filter(l => !l.abstention).length,
      by_type: byType,
      gold_sessions_per_question: goldPerType,
      sessions_per_haystack: stats(a.questions.haystacks.map(h => h.sessions.length)),
      persona_sessions_per_haystack: stats(a.questions.haystacks.map(h => h.sessions.length - FILLERS_PER_HAYSTACK_V2)),
      characters_per_haystack: stats(chars),
      approx_tokens_per_haystack_chars_div_4: stats(chars.map(c => Math.round(c / 4))),
      approx_tokens_per_persona_session_chars_div_4: stats(personaChars.map(c => Math.round(c / 4))),
      filler_pool: (a.ledger.fillers as unknown[]).length,
      fillers_per_haystack: FILLERS_PER_HAYSTACK_V2,
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
    commitments: Object.fromEntries(['questions.json', 'labels.json', 'ledger.json'].map(f => [f, { sha256: sha256File(join(a.out, f)), bytes: readFileSync(join(a.out, f)).length }])),
  };
}

// ─── Commands ─────────────────────────────────────────────────────

function gitHead(): string {
  try { return execSync('git rev-parse HEAD', { cwd: import.meta.dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; }
}

const arg = (argv: string[], n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const outDir = (argv: string[]) => { const o = arg(argv, '--out'); if (!o) throw new Error('--out <private dir> is required'); return resolve(o.replace(/^~/, process.env.HOME ?? '~')); };

async function generate(argv: string[]) {
  const out = outDir(argv);
  const personasN = Number(arg(argv, '--personas') ?? 40);
  const seed = Number(arg(argv, '--seed') ?? 20261001);
  const only = arg(argv, '--only') ? Number(arg(argv, '--only')) : null;
  const concurrency = Number(arg(argv, '--concurrency') ?? 8);
  mkdirSync(out, { recursive: true });
  const ledgerPath = join(out, 'ledger.json');
  const prior = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : null;
  const salt: string = prior?.salt ?? (existsSync(join(out, 'salt')) ? readFileSync(join(out, 'salt'), 'utf8').trim() : randomBytes(16).toString('hex'));
  writeFileSync(join(out, 'salt'), salt);
  const setId = `sealed-confirmation-v2-${seed}`;
  const spend = new SpendLedger(join(out, 'spend.jsonl'), Number(arg(argv, '--cap-usd') ?? 48));
  const llm = new LlmClient({ ledger: spend, cacheDir: join(out, 'cache') });
  const seeds = personaSeedsV2(personasN, seed).filter(s => only === null || s.persona_index <= only);
  const log = (m: string) => process.stderr.write(`[sealed-v2] ${m} (spent $${spend.spentUsd.toFixed(4)})\n`);

  log(`planning ${seeds.length} personas`);
  const personas = await mapPool(seeds, concurrency, s => generatePlan(llm, s));
  const planned = personas.filter(p => p.plan);
  log(`plans: ${planned.length}/${personas.length} valid`);
  const jobs = planned.flatMap(p => p.plan!.sessions.map(s => ({ p, s })));
  let done = 0;
  const sessionRecords = await mapPool(jobs, concurrency, async ({ p, s }) => {
    const r = await writeSession(llm, p.seed.persona_index, p.plan!, s);
    if (++done % 25 === 0) log(`sessions ${done}/${jobs.length}`);
    return r;
  });
  log(`sessions: ${sessionRecords.filter(r => r.audit_passed).length}/${sessionRecords.length} passed audit`);
  const fillerSpecs = (only === null ? FILLER_TOPICS_V2 : FILLER_TOPICS_V2.slice(0, 16)).flatMap(t => FILLER_VARIANTS_V2.map(v => ({ t, v })));
  const fillers = await mapPool(fillerSpecs, concurrency, (f, i) => writeFiller(llm, f.t, f.v, i + 1));
  log(`fillers: ${fillers.filter(f => f.problems.length === 0).length}/${fillers.length} clean`);

  const complete = planned.filter(p => p.plan!.sessions.every(s => sessionRecords.find(r => r.persona_index === p.seed.persona_index && r.key === s.key)?.final.length));
  const { questions, labels, idMap } = assembleV2({
    setId, salt, seed,
    personas: complete.map(p => ({ index: p.seed.persona_index, plan: p.plan!, sessions: new Map(sessionRecords.filter(r => r.persona_index === p.seed.persona_index).map(r => [r.key, { turns: r.final, audit_passed: r.audit_passed }])) })),
    fillers: fillers.filter(f => f.problems.length === 0),
  });
  const problems = [...validateQuestionsFile(questions), ...validateLabelsFile(labels, questions)];
  if (problems.length) throw new Error(`assembled files are invalid:\n${problems.join('\n')}`);
  const generationDate = new Date().toISOString().slice(0, 10);
  writeFileSync(join(out, 'questions.json'), JSON.stringify(questions, null, 1) + '\n');
  writeFileSync(join(out, 'labels.json'), JSON.stringify(labels, null, 1) + '\n');
  const ledger = {
    generator_version: GENERATOR_VERSION_V2, generation_date: generationDate, git_head: gitHead(), salt, seed, set_id: setId,
    models: { plan: GENERATOR_MODEL_V2, session: SESSION_MODEL_V2, audit: AUDIT_MODEL_V2, filler: FILLER_MODEL_V2 }, personas, sessions: sessionRecords, fillers, id_map: idMap,
    dropped_personas: personas.filter(p => !complete.includes(p)).map(p => p.seed.persona_index), spend_usd: spend.spentUsd,
  };
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 1) + '\n');
  log(`wrote ${questions.questions.length} questions over ${questions.haystacks.length} haystacks to ${out}`);
  if (ledger.dropped_personas.length) log(`WARNING: personas without a complete session set: ${ledger.dropped_personas.join(', ')}`);
  const manifestPath = arg(argv, '--manifest');
  if (manifestPath && only === null) {
    const manifest = buildManifestV2({ out, questions, labels, ledger, generationDate });
    mkdirSync(join(manifestPath, '..'), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    log(`manifest: ${manifestPath}`);
  }
}

/**
 * Pre-seal solvability, reported and never used to delete items: the sealed
 * protocol's official-prompt reader (Sonnet 4.6, temperature 0) and judge,
 * given (a) every gold session whole, (b) the chunk oracle, (c) no memory.
 * Opening the labels is logged in the access log.
 */
async function solvability(argv: string[]) {
  const out = outDir(argv);
  const { readAnswer, judge } = await import('../runner/sealed-confirmation.ts');
  const q: QuestionsFile = JSON.parse(readFileSync(join(out, 'questions.json'), 'utf8'));
  const labelsPath = join(out, 'labels.json');
  appendAccessLog(join(out, 'access-log.jsonl'), { action: 'solvability', purpose: 'pre-seal solvability check (whole gold sessions, chunk oracle, no memory)', decision_id: null, labels_sha256: sha256File(labelsPath), run_sha256: null });
  const labels: LabelsFile = JSON.parse(readFileSync(labelsPath, 'utf8'));
  const ledger = JSON.parse(readFileSync(join(out, 'ledger.json'), 'utf8'));
  const spend = new SpendLedger(join(out, 'solvability-spend.jsonl'), Number(arg(argv, '--cap-usd') ?? 14));
  const llm = new LlmClient({ ledger: spend, cacheDir: join(out, 'cache') });
  const sessions = new Map(q.haystacks.flatMap(h => h.sessions.map(s => [s.session_id, s] as const)));
  const qById = new Map(q.questions.map(x => [x.question_id, x]));
  // Evidence statements per question, from the plan (the ledger's id map ties plan keys to opaque ids).
  const idMap: Record<string, string> = ledger.id_map;
  const statements = new Map<string, Map<string, string[]>>();
  for (const p of ledger.personas as PersonaRecord[]) {
    if (!p.plan) continue;
    p.plan.questions.forEach((pq, qi) => {
      const qid = idMap[`p${p.seed.persona_index}:q${qi + 1}`];
      if (!qid) return;
      const m = new Map<string, string[]>();
      for (const k of pq.evidence_fact_keys) {
        const f = p.plan!.facts.find(x => x.key === k)!;
        const sid = idMap[`p${p.seed.persona_index}:${f.session_key}`];
        m.set(sid, [...(m.get(sid) ?? []), f.statement]);
      }
      statements.set(qid, m);
    });
  }
  const rows = await mapPool(labels.labels, Number(arg(argv, '--concurrency') ?? 6), async l => {
    const question = qById.get(l.question_id)!;
    const goldIds = l.abstention ? l.related_session_ids : l.answer_session_ids;
    const gold = goldIds.map(id => sessions.get(id)!);
    const oracle = await readAnswer(llm, `v2 oracle ${l.question_id}`, readerPrompt(question.question, question.question_date, gold));
    const ev = gold.map(s => ({ session_id: s.session_id, date: s.date, turns: s.turns, statements: statements.get(l.question_id)?.get(s.session_id) ?? [] }));
    const co = chunkOracle(ev, 5);
    const chunkSessions = co.chunks.map(c => ({ date: c.date, turns: [{ role: 'user' as const, content: c.text }] }));
    const chunkAns = await readAnswer(llm, `v2 chunk-oracle ${l.question_id}`, readerPrompt(question.question, question.question_date, chunkSessions));
    const noMem = await readAnswer(llm, `v2 nomem ${l.question_id}`, readerPrompt(question.question, question.question_date, []));
    return {
      question_id: l.question_id, question_type: l.question_type, gold_sessions: goldIds.length, evidence_chunks_needed: co.needed,
      oracle_correct: await judge(llm, `v2 judge-oracle ${l.question_id}`, l.question_type, question.question, l.answer, oracle.text),
      chunk_oracle_correct: await judge(llm, `v2 judge-chunk ${l.question_id}`, l.question_type, question.question, l.answer, chunkAns.text),
      no_memory_correct: await judge(llm, `v2 judge-nomem ${l.question_id}`, l.question_type, question.question, l.answer, noMem.text),
      truncated: oracle.truncated || chunkAns.truncated || noMem.truncated,
    };
  });
  writeFileSync(join(out, 'solvability-private.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const byType: Record<string, { n: number; oracle_correct: number; chunk_oracle_correct: number; no_memory_correct: number; evidence_chunks_needed_median: number }> = {};
  for (const t of [...new Set(rows.map(r => r.question_type))].sort()) {
    const rs = rows.filter(r => r.question_type === t);
    byType[t] = { n: rs.length, oracle_correct: rs.filter(r => r.oracle_correct).length, chunk_oracle_correct: rs.filter(r => r.chunk_oracle_correct).length, no_memory_correct: rs.filter(r => r.no_memory_correct).length, evidence_chunks_needed_median: stats(rs.map(r => r.evidence_chunks_needed)).median };
  }
  const summary = {
    set: 'sealed-confirmation-v2', reader: 'claude-sonnet-4-6 (sealed protocol reader: official LongMemEval reading prompt, temperature 0, 2048 output tokens)', judge: 'gpt-4o-2024-08-06 (official evaluate_qa.py prompts)',
    chunk_oracle: 'at most five ~300-word chunks (50-word overlap) from the gold sessions, one per evidence fact chosen by word overlap with the ledger statement, in time order; generous, since a retriever would still have to find them',
    n: rows.length, oracle_correct: rows.filter(r => r.oracle_correct).length, chunk_oracle_correct: rows.filter(r => r.chunk_oracle_correct).length, no_memory_correct: rows.filter(r => r.no_memory_correct).length,
    questions_needing_more_than_5_chunks: rows.filter(r => r.evidence_chunks_needed > 5).length, truncated_reader_outputs: rows.filter(r => r.truncated).length,
    by_type: byType, cost_usd: Number(spend.spentUsd.toFixed(4)), note: 'Reported, never used to delete items.',
  };
  const pub = arg(argv, '--public');
  if (pub) { mkdirSync(join(pub, '..'), { recursive: true }); writeFileSync(pub, JSON.stringify(summary, null, 2) + '\n'); }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = ({ generate, solvability } as Record<string, (a: string[]) => Promise<void>>)[cmd];
  if (!fn) { process.stderr.write('usage: sealed-confirmation-v2-gen.ts generate|solvability ...\n'); process.exit(2); }
  fn(rest).catch(e => { process.stderr.write(`[sealed-v2] FATAL: ${e?.stack ?? e}\n`); process.exit(1); });
}
