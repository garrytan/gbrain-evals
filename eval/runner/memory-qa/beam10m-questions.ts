/**
 * BEAM-10M probing questions, evaluator side, for the custodian only (Q1
 * PLAN §4.2, §4.8.10). Every call appends a custody access-log line before a
 * question file is read, and the caller must hold the custody log path; the
 * corpus side (beam10m-corpus.ts) never imports this module.
 *
 * Questions keep loadBeam's shape: id `<conversation>:<ability>:<index>`,
 * the reference from the first of `answer`, `ideal_response`, `ideal_answer`,
 * `ideal_summary`, `expected_compliance`, the rubric list, and gold sessions
 * from `source_chat_ids` (message ids) through the corpus loader's
 * message-to-session map. A message id that occurs in more than one session
 * (a plan restarting its ids) maps to every session holding it and is
 * counted, so the custodian can see the ambiguity before freeze.
 *
 * `beam10mExclusions()` lists the questions the split file removes from the
 * confirmatory cohort (with reasons); loading keeps them so exposure stays
 * auditable, and the statistics drop them.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideError } from '../decisions/errors.ts';
import { appendAccessLog } from '../sealed-confirmation-lib.ts';
import { BEAM10M_MANIFEST, type Beam10mCorpus } from './beam10m-corpus.ts';
import type { MemoryQuestion } from './corpus.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

interface QuestionsManifest { conversations: Array<{ conversation: string; questions_path: string; questions_sha256: string | null }> }

function messageIds(src: unknown): number[] {
  if (Array.isArray(src)) return src.flatMap(messageIds);
  if (typeof src === 'number') return [src];
  if (typeof src === 'string' && /^\d+$/.test(src.trim())) return [Number(src)];
  if (src && typeof src === 'object') return Object.values(src).flatMap(messageIds);
  return [];
}

export interface Beam10mQuestionStats { questions: number; by_ability: Record<string, number>; ambiguous_gold: number; unmapped_source_ids: number }

export function loadBeam10mQuestions(corpus: Beam10mCorpus, custody: { log: string; decisionId: string; purpose: string }, opts: { manifestPath?: string; root?: string } = {}): { questions: MemoryQuestion[]; stats: Beam10mQuestionStats } {
  if (!custody.log) throw decideError({ code: 'CUSTODY_MISSING', message: 'BEAM-10M questions need the custody access log', why: 'every opening of sealed questions is logged',
    fix: { next: 'ask_user', user_message: 'only the custodian loads BEAM-10M questions, with GBRAIN_EVALS_CUSTODY_LOG set' } });
  const m = JSON.parse(readFileSync(opts.manifestPath ?? join(REPO_ROOT, BEAM10M_MANIFEST), 'utf8')) as QuestionsManifest;
  const root = opts.root ?? process.env.GBRAIN_EVALS_DATASETS ?? join(homedir(), 'datasets', 'gbrain-evals');
  const questions: MemoryQuestion[] = [];
  const stats: Beam10mQuestionStats = { questions: 0, by_ability: {}, ambiguous_gold: 0, unmapped_source_ids: 0 };
  for (const conv of corpus.conversations) {
    const entry = m.conversations.find(c => c.conversation === conv.id);
    if (!entry?.questions_sha256) throw decideError({ code: 'NOT_YET_AVAILABLE', message: `beam-10m: no pinned question file for ${conv.id}`, why: 'the custodian fills the manifest before any question is read',
      fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'fetch', '--write'] } });
    const path = join(root, entry.questions_path);
    if (!existsSync(path)) throw decideError({ code: 'DATASET_MISSING', message: `beam-10m: ${path} is not on this machine`, why: 'BEAM-10M question files exist only on the custody host',
      fix: { next: 'ask_user', user_message: 'run BEAM-10M scoring on the custody host' } });
    appendAccessLog(custody.log, { action: 'open', purpose: `beam-10m questions ${conv.id}: ${custody.purpose}`, decision_id: custody.decisionId, labels_sha256: entry.questions_sha256, run_sha256: null });
    const bytes = readFileSync(path);
    const got = sha256(bytes);
    if (got !== entry.questions_sha256) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `beam-10m: ${entry.questions_path} has SHA-256 ${got.slice(0, 12)}, expected ${entry.questions_sha256.slice(0, 12)}`,
      why: 'only the pinned bytes are scored', fix: { next: 'tell_user_to_run', argv: ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'fetch'] } });
    const pq = (JSON.parse(bytes.toString('utf8')) as { probing_questions: Record<string, Array<Record<string, unknown>>> }).probing_questions;
    const ofMessage = corpus.sessionsOfMessage.get(conv.id) ?? new Map<number, string[]>();
    for (const [ability, items] of Object.entries(pq)) {
      items.forEach((item, i) => {
        const ids = messageIds(item.source_chat_ids);
        const mapped = ids.map(id => ofMessage.get(id) ?? []);
        stats.unmapped_source_ids += mapped.filter(s => !s.length).length;
        if (mapped.some(s => s.length > 1)) stats.ambiguous_gold++;
        const abstention = ability === 'abstention';
        const reference = item.answer ?? item.ideal_response ?? item.ideal_answer ?? item.ideal_summary ?? item.expected_compliance;
        questions.push({ id: `${conv.id}:${ability}:${i}`, conversation: conv.id, question: String(item.question), category: ability, gold: abstention ? [] : [...new Set(mapped.flat())], abstention,
          answer: reference === undefined ? undefined : String(reference), rubric: Array.isArray(item.rubric) ? item.rubric.map(String) : undefined });
        stats.by_ability[ability] = (stats.by_ability[ability] ?? 0) + 1;
      });
    }
  }
  stats.questions = questions.length;
  return { questions, stats };
}

/** Questions the BEAM-10M split removes from the confirmatory cohort, with reasons. */
export function beam10mExclusions(): Array<{ question: string; reason: string }> {
  const split = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/decisions/splits/beam-10m.json'), 'utf8')) as { exclusions?: Array<{ question: string; reason: string }> };
  return split.exclusions ?? [];
}
