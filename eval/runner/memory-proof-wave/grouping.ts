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
 * `resealManifest` re-splits validation and sealed with a fresh salt, dev
 * held fixed, when the private file may have been seen before any open.
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

export type GroupRole = 'primary' | 'secondary';
/**
 * Which strata the manifest covers, and why. The October 5 decision after the
 * power simulation moved BEAM 100k from the reserve into the primary endpoint.
 */
export const GROUPS: Array<{ group: GroupRole; strata: string[]; note: string }> = [
  { group: 'primary', strata: ['beam/100k', 'beam/500k', 'beam/1m'], note: 'Primary non-inferiority test, margin 3.0 points: BEAM 100k + 500k + 1M, 18 dev / 18 validation / 54 sealed conversations (100k 4/4/12, 500k 7/7/21, 1M 7/7/21).' },
  { group: 'secondary', strata: ['personamem/32k', 'lifebench/en'], note: 'Descriptive rows, each its own dataset: PersonaMem 32k grouped by persona (all histories of a persona together), LifeBench grouped by user.' },
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
  /** Every reseal, oldest first. After a reseal, dev ids are fixed by the commit and only validation and sealed follow the current salt. */
  reseals?: ResealEntry[];
}
export interface ResealEntry {
  date: string;
  reason: string;
  rule: string;
  previous_private_file: Commitment;
  previous_salt_sha256: string;
  previous_commitments: Record<string, { validation: string; sealed: string }>;
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

export const RESEAL_RULE = 'Dev ids stay exactly as committed. Per stratum, the other clusters are ordered by HMAC-SHA256(new salt, "<stratum>/<cluster id>") as lowercase hex, ascending; the first round(0.2 G) are validation and the rest sealed, where G counts every cluster in the stratum, so the counts are unchanged. Commitments use the new salt.';

/** Validation and sealed ids for one stratum with dev held fixed: the non-dev clusters ordered by the salt. */
export function assignNonDev(salt: Buffer, stratum: string, clusters: ClusterRef[], dev: string[]): { validation: string[]; sealed: string[] } {
  const devSet = new Set(dev);
  if (dev.some(id => !clusters.some(c => c.id === id))) throw new Error(`${stratum}: dev ids not in the cluster list`);
  const rest = clusters.map(c => c.id).filter(id => !devSet.has(id));
  const order = rest.sort((a, b) => { const x = clusterRank(salt, stratum, a), y = clusterRank(salt, stratum, b); return x < y ? -1 : x > y ? 1 : 0; });
  const n = splitCounts(clusters.length);
  if (dev.length !== n.dev) throw new Error(`${stratum}: ${dev.length} dev ids, the rule gives ${n.dev}`);
  const sort = (xs: string[]) => [...xs].sort(naturalCompare);
  return { validation: sort(order.slice(0, n.validation)), sealed: sort(order.slice(n.validation)) };
}

/**
 * Re-split every stratum's non-dev clusters into validation and sealed with a
 * fresh salt, for use when the private file may have been seen before any
 * validation or sealed open. Dev ids, cluster lists and counts stay as
 * committed; strata are regrouped by GROUPS. The reseal entry keeps the old
 * commitments so the history is auditable.
 */
export function resealManifest(m: PublicManifest, salt: Buffer, o: { date: string; reason: string }): { manifest: PublicManifest; privateFile: PrivateFile; privateBytes: Buffer } {
  if (!o.reason.trim()) throw new Error('a reseal needs a reason');
  if (sha256Hex(salt) === m.salt_sha256) throw new Error('a reseal needs a new salt');
  const old = new Map(m.groups.flatMap(g => g.strata).map(s => [s.stratum, s]));
  const listed = GROUPS.flatMap(g => g.strata);
  const missing = [...old.keys()].filter(k => !listed.includes(k));
  if (missing.length || listed.some(k => !old.has(k))) throw new Error(`reseal keeps the same strata; manifest has ${[...old.keys()].join(', ')}, GROUPS has ${listed.join(', ')}`);
  const privateStrata: PrivateFile['strata'] = [];
  const groups = GROUPS.map(g => ({
    group: g.group, note: g.note,
    strata: g.strata.map(key => {
      const s = old.get(key)!;
      const a = assignNonDev(salt, key, s.clusters, s.dev.ids);
      const q = (ids: string[]) => ids.reduce((t, id) => t + s.clusters.find(c => c.id === id)!.questions, 0);
      privateStrata.push({ stratum: key, validation: a.validation, sealed: a.sealed });
      return {
        ...s,
        validation: { count: a.validation.length, questions: q(a.validation), commitment: splitCommitment(salt, key, 'validation', a.validation) },
        sealed: { count: a.sealed.length, questions: q(a.sealed), commitment: splitCommitment(salt, key, 'sealed', a.sealed) },
      } satisfies PublicStratum;
    }),
  }));
  const privateFile: PrivateFile = { schema: PRIVATE_SCHEMA, salt: salt.toString('hex'), strata: privateStrata };
  const privateBytes = Buffer.from(JSON.stringify(privateFile, null, 2) + '\n');
  const entry: ResealEntry = {
    date: o.date, reason: o.reason, rule: RESEAL_RULE,
    previous_private_file: m.private_file, previous_salt_sha256: m.salt_sha256,
    previous_commitments: Object.fromEntries([...old.values()].map(s => [s.stratum, { validation: s.validation.commitment, sealed: s.sealed.commitment }])),
  };
  const manifest: PublicManifest = {
    ...m, groups,
    salt_sha256: sha256Hex(salt),
    private_file: { file: PRIVATE_FILE_NAME, sha256: sha256Hex(privateBytes), bytes: privateBytes.length },
    reseals: [...(m.reseals ?? []), entry],
  };
  return { manifest, privateFile, privateBytes };
}

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
  const resealed = (m.reseals?.length ?? 0) > 0;
  for (const g of m.groups) for (const s of g.strata) {
    const priv = p.strata.find(x => x.stratum === s.stratum);
    if (!priv) { problems.push(`${s.stratum}: missing from private file`); continue; }
    const a = resealed ? assignNonDev(salt, s.stratum, s.clusters, s.dev.ids) : assignStratum(salt, s.stratum, s.grouping, s.clusters);
    if (!resealed && canonicalJson((a as StratumAssignment).dev) !== canonicalJson(s.dev.ids)) problems.push(`${s.stratum}: dev ids differ from the salted rule`);
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
