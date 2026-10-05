/**
 * Grouping manifest for the memory proof wave (plan item A2).
 *
 * Every dataset is split by its independent unit (a BEAM conversation, a
 * PersonaMem persona with all its histories, a LifeBench user), never by
 * question. Within each stratum the clusters are ordered by
 * HMAC-SHA256(salt, "<stratum>/<cluster id>"); the first 20% go to dev, the
 * next 20% to validation and the rest are sealed. The order depends only on
 * the salt, so the split is deterministic and seeded, and nobody without the
 * salt can predict it.
 *
 * What is public (committed): every cluster id, the dev ids, counts, a
 * salted SHA-256 commitment for each validation and sealed id list, the
 * salt's hash and the private file's commitment. What is private (kept
 * with the sealed-confirmation files, outside the repository): the salt and
 * the validation and sealed ids. Opening validation or sealed ids goes
 * through `openSplit`, which checks the private file against its commitment
 * and appends to the access log, reusing the sealed-confirmation machinery.
 * Opening sealed ids also needs a decision id and a committed
 * preregistration.
 *
 * The datasets themselves are public. Once validation ids are opened, the
 * sealed ids are the complement of dev and validation, so the protection is
 * procedural: the commitment proves the split was fixed before tuning, and
 * the log records every open.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { appendAccessLog, assertCommitment, canonicalJson, sha256Hex, type Commitment } from '../sealed-confirmation-lib.ts';
import { naturalCompare, type PowerInputs } from './harness-inputs.ts';

export const MANIFEST_SCHEMA = 'gbrain-evals/mpw-grouping/v1';
export const PRIVATE_SCHEMA = 'gbrain-evals/mpw-grouping-private/v1';
export const PUBLIC_MANIFEST_PATH = 'eval/data/memory-proof-wave/grouping-manifest.json';
export const PRIVATE_FILE_NAME = 'grouping-private.json';
export const SPLITS = ['dev', 'validation', 'sealed'] as const;
export type Split = typeof SPLITS[number];
export const SHARES = { dev: 0.2, validation: 0.2 } as const;

export type GroupRole = 'primary' | 'secondary' | 'reserve';
/** Which strata the manifest covers, and why. BEAM 100k is a reserve: committed now so it is untouched, used only if the preregistration adopts it before any sealed cell. */
export const GROUPS: Array<{ group: GroupRole; strata: string[]; note: string }> = [
  { group: 'primary', strata: ['beam/500k', 'beam/1m'], note: 'Primary non-inferiority test: BEAM 500k + 1M, 14 dev / 14 validation / 42 sealed conversations.' },
  { group: 'secondary', strata: ['personamem/32k', 'lifebench/en'], note: 'Secondary rows, each its own dataset: PersonaMem 32k grouped by persona (all histories of a persona together), LifeBench grouped by user.' },
  { group: 'reserve', strata: ['beam/100k'], note: 'Reserve: same rule, not part of any claim unless the preregistration adopts it before any sealed cell runs.' },
];

export interface ClusterRef { id: string; histories: string[]; questions: number }
export interface StratumAssignment { stratum: string; grouping: string; clusters: ClusterRef[]; dev: string[]; validation: string[]; sealed: string[] }

export function splitCounts(G: number): Record<Split, number> {
  const dev = Math.round(SHARES.dev * G), validation = Math.round(SHARES.validation * G);
  return { dev, validation, sealed: G - dev - validation };
}

export function clusterRank(salt: Buffer, stratum: string, id: string): string {
  return createHmac('sha256', salt).update(`${stratum}/${id}`).digest('hex');
}

/** Deterministic assignment of one stratum's clusters from the salt. */
export function assignStratum(salt: Buffer, stratum: string, grouping: string, clusters: ClusterRef[]): StratumAssignment {
  const ids = clusters.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${stratum}: duplicate cluster ids`);
  const order = [...ids].sort((a, b) => { const x = clusterRank(salt, stratum, a), y = clusterRank(salt, stratum, b); return x < y ? -1 : x > y ? 1 : 0; });
  const n = splitCounts(ids.length);
  const sort = (xs: string[]) => [...xs].sort(naturalCompare);
  return {
    stratum, grouping, clusters: [...clusters].sort((a, b) => naturalCompare(a.id, b.id)),
    dev: sort(order.slice(0, n.dev)),
    validation: sort(order.slice(n.dev, n.dev + n.validation)),
    sealed: sort(order.slice(n.dev + n.validation)),
  };
}

/** Salted commitment to one split's ids: verifiable once the salt is published, unguessable before. */
export function splitCommitment(salt: Buffer, stratum: string, split: Split, ids: string[]): string {
  return sha256Hex(canonicalJson({ salt: salt.toString('hex'), stratum, split, ids: [...ids].sort(naturalCompare) }));
}

export interface PublicStratum {
  stratum: string;
  grouping: string;
  queries_file: { path: string; sha256: string };
  clusters: ClusterRef[];
  dev: { count: number; questions: number; ids: string[] };
  validation: { count: number; questions: number; commitment: string };
  sealed: { count: number; questions: number; commitment: string };
}
export interface PublicManifest {
  schema: typeof MANIFEST_SCHEMA;
  status: 'sealed';
  created: string;
  rule: string;
  harness: { lock: string; commit: string };
  inputs: { path: string; sha256: string };
  salt_sha256: string;
  private_file: Commitment;
  access_log: string;
  groups: Array<{ group: GroupRole; note: string; strata: PublicStratum[] }>;
}
export interface PrivateFile {
  schema: typeof PRIVATE_SCHEMA;
  salt: string;
  strata: Array<{ stratum: string; validation: string[]; sealed: string[] }>;
}

export const RULE = 'Per stratum, order clusters by HMAC-SHA256(salt, "<stratum>/<cluster id>") as lowercase hex, ascending. The first round(0.2 G) are dev, the next round(0.2 G) validation, the rest sealed. Each validation and sealed commitment is SHA-256 of canonical JSON {ids (sorted), salt (hex), split, stratum}.';

export function buildManifest(inputs: PowerInputs, inputsRef: { path: string; sha256: string }, salt: Buffer, created: string): { manifest: PublicManifest; privateFile: PrivateFile; privateBytes: Buffer } {
  const privateStrata: PrivateFile['strata'] = [];
  const groups = GROUPS.map(g => ({
    group: g.group, note: g.note,
    strata: g.strata.map(key => {
      const d = inputs.datasets[key];
      if (!d) throw new Error(`inputs have no dataset ${key}`);
      const refs = d.clusters.map(c => ({ id: c.id, histories: c.histories, questions: c.items.length }));
      const a = assignStratum(salt, key, d.grouping, refs);
      const q = (ids: string[]) => ids.reduce((s, id) => s + refs.find(r => r.id === id)!.questions, 0);
      privateStrata.push({ stratum: key, validation: a.validation, sealed: a.sealed });
      return {
        stratum: key, grouping: d.grouping, queries_file: d.queries_file, clusters: a.clusters,
        dev: { count: a.dev.length, questions: q(a.dev), ids: a.dev },
        validation: { count: a.validation.length, questions: q(a.validation), commitment: splitCommitment(salt, key, 'validation', a.validation) },
        sealed: { count: a.sealed.length, questions: q(a.sealed), commitment: splitCommitment(salt, key, 'sealed', a.sealed) },
      } satisfies PublicStratum;
    }),
  }));
  const privateFile: PrivateFile = { schema: PRIVATE_SCHEMA, salt: salt.toString('hex'), strata: privateStrata };
  const privateBytes = Buffer.from(JSON.stringify(privateFile, null, 2) + '\n');
  const manifest: PublicManifest = {
    schema: MANIFEST_SCHEMA, status: 'sealed', created, rule: RULE,
    harness: { lock: 'eval/data/memory-proof-wave/harness.lock.json', commit: inputs.harness.commit },
    inputs: inputsRef,
    salt_sha256: sha256Hex(salt),
    private_file: { file: PRIVATE_FILE_NAME, sha256: sha256Hex(privateBytes), bytes: privateBytes.length },
    access_log: 'access-log.jsonl, kept beside the private file; every validation or sealed open appends one line',
    groups,
  };
  return { manifest, privateFile, privateBytes };
}

export function newSalt(): Buffer { return randomBytes(32); }

/** Problems with the public manifest alone: counts, disjointness and that dev ids are real clusters. */
export function checkPublic(m: PublicManifest): string[] {
  const problems: string[] = [];
  if (m.schema !== MANIFEST_SCHEMA) problems.push(`schema ${m.schema}`);
  for (const g of m.groups) for (const s of g.strata) {
    const all = new Set(s.clusters.map(c => c.id));
    if (all.size !== s.clusters.length) problems.push(`${s.stratum}: duplicate cluster ids`);
    const n = splitCounts(all.size);
    if (s.dev.count !== n.dev || s.validation.count !== n.validation || s.sealed.count !== n.sealed) problems.push(`${s.stratum}: counts ${s.dev.count}/${s.validation.count}/${s.sealed.count}, rule gives ${n.dev}/${n.validation}/${n.sealed}`);
    if (s.dev.ids.length !== s.dev.count || s.dev.ids.some(id => !all.has(id))) problems.push(`${s.stratum}: dev ids do not match the cluster list`);
    const total = s.clusters.reduce((t, c) => t + c.questions, 0);
    if (s.dev.questions + s.validation.questions + s.sealed.questions !== total) problems.push(`${s.stratum}: question counts do not add up`);
  }
  return problems;
}

/** Full check with the private file: commitment, salt, recomputed assignment and every split commitment. */
export function checkPrivate(m: PublicManifest, privatePath: string): string[] {
  const bytes = assertCommitment(privatePath, m.private_file);
  const p = JSON.parse(bytes.toString('utf8')) as PrivateFile;
  const salt = Buffer.from(p.salt, 'hex');
  const problems = checkPublic(m);
  if (sha256Hex(salt) !== m.salt_sha256) problems.push('salt does not match salt_sha256');
  for (const g of m.groups) for (const s of g.strata) {
    const a = assignStratum(salt, s.stratum, s.grouping, s.clusters);
    const priv = p.strata.find(x => x.stratum === s.stratum);
    if (!priv) { problems.push(`${s.stratum}: missing from private file`); continue; }
    if (canonicalJson(a.dev) !== canonicalJson(s.dev.ids)) problems.push(`${s.stratum}: dev ids differ from the salted rule`);
    if (canonicalJson(a.validation) !== canonicalJson(priv.validation)) problems.push(`${s.stratum}: validation ids differ from the salted rule`);
    if (canonicalJson(a.sealed) !== canonicalJson(priv.sealed)) problems.push(`${s.stratum}: sealed ids differ from the salted rule`);
    if (splitCommitment(salt, s.stratum, 'validation', priv.validation) !== s.validation.commitment) problems.push(`${s.stratum}: validation commitment mismatch`);
    if (splitCommitment(salt, s.stratum, 'sealed', priv.sealed) !== s.sealed.commitment) problems.push(`${s.stratum}: sealed commitment mismatch`);
  }
  return problems;
}

export interface OpenRequest {
  split: Split;
  strata: string[];
  purpose: string;
  privatePath?: string;
  accessLogPath?: string;
  decisionId?: string | null;
  /** Path and bytes of the committed preregistration; required for sealed. */
  preregistration?: { path: string; bytes: Buffer; committed: boolean };
}

/**
 * Return the ids of one split for the named strata. Dev needs nothing.
 * Validation needs the private file and a purpose, and logs the open.
 * Sealed also needs a decision id and a preregistration committed to git,
 * whose hash goes into the log line.
 */
export function openSplit(m: PublicManifest, r: OpenRequest): Record<string, string[]> {
  const strata = m.groups.flatMap(g => g.strata).filter(s => r.strata.includes(s.stratum));
  const unknown = r.strata.filter(k => !strata.some(s => s.stratum === k));
  if (unknown.length) throw new Error(`unknown strata: ${unknown.join(', ')}`);
  if (r.split === 'dev') return Object.fromEntries(strata.map(s => [s.stratum, s.dev.ids]));
  if (!r.purpose.trim()) throw new Error(`--purpose is required to open ${r.split} ids`);
  if (!r.privatePath || !r.accessLogPath) throw new Error(`opening ${r.split} ids needs --private <${PRIVATE_FILE_NAME}> and --access-log <access-log.jsonl>`);
  let preregistration_sha256: string | undefined;
  if (r.split === 'sealed') {
    if (!r.decisionId?.trim()) throw new Error('--decision-id is required to open sealed ids: every sealed open is a named, preregistered decision');
    if (!r.preregistration) throw new Error('--preregistration <docs/benchmarks/...-preregistration.md> is required to open sealed ids');
    if (!r.preregistration.committed) throw new Error(`${r.preregistration.path} is not committed; commit the preregistration before opening sealed ids`);
    if (/\bTODO\b/.test(r.preregistration.bytes.toString('utf8'))) throw new Error(`${r.preregistration.path} still has TODO markers; fill every value before opening sealed ids`);
    preregistration_sha256 = sha256Hex(r.preregistration.bytes);
  }
  const bytes = assertCommitment(r.privatePath, m.private_file);
  const p = JSON.parse(bytes.toString('utf8')) as PrivateFile;
  const split = r.split;
  const entry = { action: 'open' as const, purpose: `${r.split} ids for ${r.strata.join(', ')}: ${r.purpose}`, decision_id: r.decisionId ?? null, labels_sha256: m.private_file.sha256, run_sha256: null, ...(preregistration_sha256 ? { preregistration_sha256 } : {}) };
  appendAccessLog(r.accessLogPath, entry);
  return Object.fromEntries(strata.map(s => {
    const ids = p.strata.find(x => x.stratum === s.stratum)?.[split];
    if (!ids) throw new Error(`${s.stratum}: missing from private file`);
    return [s.stratum, ids];
  }));
}

export function loadManifest(path = PUBLIC_MANIFEST_PATH): PublicManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PublicManifest;
}

export function writePrivate(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}
