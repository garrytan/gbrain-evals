/**
 * Dataset access, the pilot/confirmatory split and the gold-evidence cluster
 * map for the evidence-delivery study.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DecisionManifest } from './decision.ts';

export const REPO_ROOT = join(import.meta.dir, '../../..');
export const STUDY_DIR = join(REPO_ROOT, 'docs/benchmarks/2026-09-30-evidence-delivery');
export const CLUSTER_MAP_PATH = join(STUDY_DIR, 'cluster-map.json');

export interface Turn { role: 'user' | 'assistant'; content: string; has_answer?: boolean }
export interface LmeQuestion {
  question_id: string; question_type: string; question: string; question_date: string; answer: string | number;
  answer_session_ids: string[]; haystack_dates: string[]; haystack_session_ids: string[]; haystack_sessions: Turn[][];
}

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export function loadDataset(path: string, expectedSha256: string): LmeQuestion[] {
  if (!existsSync(path)) throw new Error(`dataset not found at ${path}; download longmemeval_s_cleaned.json (see the preregistration)`);
  const bytes = readFileSync(path);
  const got = sha256(bytes);
  if (got !== expectedSha256) throw new Error(`dataset sha256 ${got} differs from the manifest's ${expectedSha256}`);
  return JSON.parse(bytes.toString('utf8'));
}

export function pilotIds(m: DecisionManifest): string[] {
  const bytes = readFileSync(join(REPO_ROOT, m.data.pilot.path));
  if (sha256(bytes) !== m.data.pilot.sha256) throw new Error('pilot id file differs from the manifest commitment');
  return bytes.toString('utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

export interface ClusterMap { schema: 'gbrain-evals/evidence-delivery-clusters/v1'; dataset_sha256: string; rule: string; clusters: Record<string, string> }

/** Union-find over shared gold evidence sessions; a cluster is named by its smallest question id. */
export function buildClusterMap(questions: LmeQuestion[], datasetSha: string): ClusterMap {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const owner = new Map<string, string>();
  for (const q of questions) parent.set(q.question_id, q.question_id);
  for (const q of questions) {
    for (const s of q.answer_session_ids) {
      const o = owner.get(s);
      if (o === undefined) owner.set(s, q.question_id);
      else {
        const [a, b] = [find(o), find(q.question_id)].sort();
        parent.set(b, a);
      }
    }
  }
  const members = new Map<string, string[]>();
  for (const q of questions) members.set(find(q.question_id), [...(members.get(find(q.question_id)) ?? []), q.question_id]);
  const clusters: Record<string, string> = {};
  for (const ids of members.values()) {
    const name = [...ids].sort()[0];
    for (const id of ids) clusters[id] = name;
  }
  const sorted = Object.fromEntries(Object.keys(clusters).sort().map(k => [k, clusters[k]]));
  return { schema: 'gbrain-evals/evidence-delivery-clusters/v1', dataset_sha256: datasetSha, rule: 'questions whose gold evidence sessions overlap form one cluster; named by the smallest member id', clusters: sorted };
}

export function loadClusterMap(path = CLUSTER_MAP_PATH): Record<string, string> {
  return (JSON.parse(readFileSync(path, 'utf8')) as ClusterMap).clusters;
}
