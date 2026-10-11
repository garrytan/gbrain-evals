/**
 * Q2 set Q (G6): the custodian's question file and career-chronicle corpus.
 *
 *   q-questions.json   { "id", "templates": { "questions": [{ "id", "pair", "corpus": "amara"|"career",
 *                        "type": "relational"|"temporal", "answerable": true|false, "question", "answer" }] } }
 *   career-corpus/     one markdown or text file per raw document, with career-manifest.json listing
 *                      { "files" (or "documents"): [{ "path", "sha256" }], "owner"?, "today"? }
 * Every custody file is access-logged and hash-checked before parsing. Pair keys are shared across models (one pair
 * key per question pair, the cluster for the crossed bootstrap).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { appendAccessLog, manifestFiles, openCustodyFile, sha256Hex } from '../sealed-confirmation-lib.ts';

export type QCorpus = 'amara' | 'career';
export interface QQuestion { id: string; pair: string; corpus: QCorpus; type: 'relational' | 'temporal'; answerable: boolean; question: string; answer: string }

export function validateQuestions(qs: unknown): string[] {
  if (!Array.isArray(qs)) return ['templates.questions must be an array'];
  const p: string[] = [];
  const ids = new Set<string>();
  for (const q of qs as QQuestion[]) {
    if (!q?.id || !q.pair || !q.question || typeof q.answer !== 'string') p.push(`question ${q?.id ?? '?'}: needs id, pair, question and answer`);
    if (q.corpus !== 'amara' && q.corpus !== 'career') p.push(`question ${q.id}: corpus must be amara or career`);
    if (q.type !== 'relational' && q.type !== 'temporal') p.push(`question ${q.id}: type must be relational or temporal`);
    if (typeof q.answerable !== 'boolean') p.push(`question ${q.id}: answerable must be true or false`);
    if (ids.has(q.id)) p.push(`question ${q.id}: duplicate id`);
    ids.add(q.id);
  }
  const byPair = new Map<string, Set<string>>();
  for (const q of qs as QQuestion[]) (byPair.get(q.pair) ?? byPair.set(q.pair, new Set()).get(q.pair)!).add(q.corpus);
  for (const [pair, cs] of byPair) if (cs.size > 1) p.push(`pair ${pair} spans corpora; a pair belongs to one corpus stratum`);
  return p;
}

export function loadQuestionsFile(file: string, custody: { decisionId: string; purpose: string }): { set_id: string; sha256: string; questions: QQuestion[] } {
  const { bytes, sha256 } = openCustodyFile({ file, flag: '--questions-file', decisionId: custody.decisionId, purpose: custody.purpose });
  const parsed = JSON.parse(bytes.toString('utf8')) as { id: string; templates: { questions: QQuestion[] } };
  const problems = validateQuestions(parsed?.templates?.questions);
  if (problems.length) throw new Error(`q-questions.json (sha256 ${sha256}) is not valid; ask the custodian to fix it: ${problems.slice(0, 10).join('; ')}`);
  return { set_id: parsed.id, sha256, questions: parsed.templates.questions };
}

export interface CareerCorpus { manifest_sha256: string; docs: Array<{ path: string; content: string }>; owner: string | null; today: string | null }

export function loadCareerCorpus(dir: string, custody: { decisionId: string; purpose: string }): CareerCorpus {
  const { bytes, sha256 } = openCustodyFile({ file: join(dir, 'career-manifest.json'), flag: '--career-dir', decisionId: custody.decisionId, purpose: custody.purpose });
  const m = JSON.parse(bytes.toString('utf8')) as { owner?: string; today?: string } & Record<string, unknown>;
  const docs = manifestFiles(m, ['files', 'documents'], `career-manifest.json (sha256 ${sha256})`).map(f => {
    if (isAbsolute(f.path) || normalize(f.path).startsWith('..')) throw new Error(`career-manifest.json: ${f.path} must be relative and stay inside the corpus directory`);
    const path = join(dir, f.path);
    if (!existsSync(path)) throw new Error(`career corpus: ${f.path} is listed but missing; ask the custodian for the complete corpus`);
    const b = readFileSync(path);
    const got = sha256Hex(b);
    if (got !== f.sha256) throw new Error(`career corpus: ${f.path} hashes to ${got}, not the manifest's ${f.sha256}; the custody copy changed, stop and tell the custodian`);
    appendAccessLog(join(dirname(path), 'access-log.jsonl'), { action: 'open', purpose: custody.purpose, decision_id: custody.decisionId, labels_sha256: got, run_sha256: null });
    return { path: f.path, content: b.toString('utf8') };
  });
  return { manifest_sha256: sha256, docs, owner: m.owner ?? null, today: m.today ?? null };
}
