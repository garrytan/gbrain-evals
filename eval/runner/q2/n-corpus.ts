/**
 * Q2 set N (G1, G4): natural text in four strata.
 *
 *   beam       BEAM-1M sealed conversations (eval/decisions/splits/beam-1m.json), rendered one page per session by the
 *              memory-qa BEAM loader, as H3 rendered chats
 *   vault      public markdown notes vaults, per-file hashes in the manifest
 *   templates  a public markdown template collection, per-file hashes in the manifest
 *   stress     custodian-generated chats and notes in the shapes behind H3's failures
 *
 * Custody format: `n-manifest.json` beside the files,
 *   { "id", "strata": [{ "id": "beam"|"vault"|"templates"|"stress", "license", "source", "commit"?, "files": [{ "path", "sha256" }] }] }
 * where the beam stratum lists `conversation_ids` instead of files. Amendment 1 excludes BEAM-1M `1m-1`, `1m-6` and
 * `1m-26`: the loader drops them if listed and records the exclusion for the receipt. Every custody file read appends a line to the
 * access log beside it, and every file's bytes must hash to the manifest before they are parsed.
 *
 * Development N (devNDocs) reads only development material: the vault's H3 dev part, BEAM dev conversations, and
 * the development stress and template pages under eval/data/q2-parser-gaps/.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { loadBeam, renderSessionPage, type Session } from '../memory-qa/corpus.ts';
import { loadSplit } from '../decisions/splits.ts';
import { loadDocs, type MintDoc } from '../line-grammar-junk-audit.ts';
import { appendAccessLog, openCustodyFile, sha256Hex } from '../sealed-confirmation-lib.ts';

export const N_STRATA = ['beam', 'vault', 'templates', 'stress'] as const;
export type NStratum = typeof N_STRATA[number];
export const N_LIST_LINE_FLOOR = 500_000;
/** Preregistration amendment 1 (2026-10-06): BEAM-1M sealed conversations opened by another wave, never part of N. */
export const BEAM_AMENDMENT_1_EXCLUDED: readonly string[] = ['1m-1', '1m-6', '1m-26'];
export const STRESS_SHAPED_FLOOR = 2_000;
const REPO = resolve(import.meta.dir, '../../..');
export const DEV_MATERIAL_DIR = join(REPO, 'eval/data/q2-parser-gaps');

export interface NManifest {
  id: string;
  strata: Array<{ id: NStratum; license: string; source: string; commit?: string; files?: Array<{ path: string; sha256: string }>; conversation_ids?: string[] }>;
}

export function validateNManifest(m: unknown): string[] {
  const p: string[] = [];
  const x = m as NManifest;
  if (typeof x?.id !== 'string' || !Array.isArray(x.strata)) return ['n-manifest.json needs "id" and "strata": [...]'];
  const seen = new Set<string>();
  for (const s of x.strata) {
    if (!N_STRATA.includes(s.id)) p.push(`stratum ${s.id}: id must be one of ${N_STRATA.join(', ')}`);
    if (seen.has(s.id)) p.push(`stratum ${s.id}: listed twice`);
    seen.add(s.id);
    if (typeof s.license !== 'string' || typeof s.source !== 'string') p.push(`stratum ${s.id}: needs license and source`);
    if (s.id === 'beam') {
      if (!Array.isArray(s.conversation_ids) || !s.conversation_ids.length) p.push('stratum beam: needs conversation_ids (BEAM-1M sealed ids) instead of files');
    } else {
      if (!Array.isArray(s.files) || !s.files.length) p.push(`stratum ${s.id}: needs files [{ path, sha256 }]`);
      for (const f of s.files ?? []) {
        if (typeof f.path !== 'string' || isAbsolute(f.path) || normalize(f.path).startsWith('..')) p.push(`stratum ${s.id}: file path ${f.path} must be relative to the manifest and stay inside its directory`);
        if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? '')) p.push(`stratum ${s.id}: ${f.path} needs a sha256`);
      }
    }
  }
  return p;
}

const slugPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'x';

/** A chat file (`{ "turns": [{ "role"|"speaker", "content" }] }` or a bare array of turns) as a page; other text as is. */
export function renderNFile(path: string, text: string): string {
  if (!path.endsWith('.json')) return text;
  const parsed = JSON.parse(text) as unknown;
  const turns = (Array.isArray(parsed) ? parsed : (parsed as { turns?: unknown[] }).turns) as Array<{ role?: string; speaker?: string; content?: string }> | undefined;
  if (!Array.isArray(turns)) throw new Error(`${path}: a .json file in N must be a chat ({ "turns": [...] } or an array of turns)`);
  return renderSessionPage({ id: path, turns: turns.map(t => ({ speaker: String(t.speaker ?? t.role ?? 'unknown'), content: String(t.content ?? '') })) });
}

/** BEAM sessions as pages, one per session, H3's chat rendering. */
export function beamPages(conversations: Array<{ id: string; sessions: Session[] }>): MintDoc[] {
  return conversations.flatMap(c => c.sessions.map(s => ({
    id: `beam:${c.id}:${s.id}`, corpus: 'beam', slug: `chat/${createHash('sha256').update(`beam\u0000${c.id}\u0000${s.id}`).digest('hex').slice(0, 16)}`, content: renderSessionPage(s),
  })));
}

export interface NLoad { manifest_sha256: string; manifest_id: string; docs: MintDoc[]; beam_excluded: { rule: string; listed_and_dropped: string[]; conversations_kept: number } | null; strata: Array<{ id: NStratum; files: number; license: string; source: string; commit: string | null }> }

/**
 * Load the custodian's N set. The manifest is opened through the access log; each file is hash-checked and logged
 * before parsing; beam ids must all be BEAM-1M sealed conversations.
 */
export function loadNSet(dir: string, custody: { decisionId: string; purpose: string }, deps: { loadBeam?: (ids: Set<string>) => Array<{ id: string; sessions: Session[] }> } = {}): NLoad {
  const manifestPath = join(dir, 'n-manifest.json');
  const { bytes, sha256 } = openCustodyFile({ file: manifestPath, flag: '--n-dir', decisionId: custody.decisionId, purpose: custody.purpose });
  const m = JSON.parse(bytes.toString('utf8')) as NManifest;
  const problems = validateNManifest(m);
  if (problems.length) throw new Error(`n-manifest.json (sha256 ${sha256}) is not valid; ask the custodian to fix it: ${problems.join('; ')}`);
  const docs: MintDoc[] = [];
  let beamExcluded: NLoad['beam_excluded'] = null;
  for (const s of m.strata) {
    if (s.id === 'beam') {
      const sealed = new Set(loadSplit('beam-1m').sealed);
      const notSealed = s.conversation_ids!.filter(id => !sealed.has(id));
      if (notSealed.length) throw new Error(`stratum beam lists ${notSealed.length} id(s) that are not BEAM-1M sealed conversations (eval/decisions/splits/beam-1m.json); only sealed ids belong in N`);
      const dropped = s.conversation_ids!.filter(id => BEAM_AMENDMENT_1_EXCLUDED.includes(id));
      const ids = new Set(s.conversation_ids!.filter(id => !BEAM_AMENDMENT_1_EXCLUDED.includes(id)));
      beamExcluded = { rule: `preregistration amendment 1: ${BEAM_AMENDMENT_1_EXCLUDED.join(', ')} are excluded from the beam stratum`, listed_and_dropped: dropped, conversations_kept: ids.size };
      appendAccessLog(join(dir, 'access-log.jsonl'), { action: 'open', purpose: `${custody.purpose}: BEAM-1M sealed conversations (${ids.size})`, decision_id: custody.decisionId, labels_sha256: 'public-split-file', run_sha256: null });
      docs.push(...beamPages((deps.loadBeam ?? (x => loadBeam('1m', x).conversations))(ids)));
      continue;
    }
    for (const f of s.files!) {
      const path = join(dir, f.path);
      if (!existsSync(path)) throw new Error(`stratum ${s.id}: ${f.path} is listed in n-manifest.json but missing beside it; ask the custodian for the complete set`);
      const fileBytes = readFileSync(path);
      const got = sha256Hex(fileBytes);
      if (got !== f.sha256) throw new Error(`stratum ${s.id}: ${f.path} hashes to ${got}, not the manifest's ${f.sha256}; the custody copy changed, stop and tell the custodian`);
      appendAccessLog(join(dirname(path), 'access-log.jsonl'), { action: 'open', purpose: custody.purpose, decision_id: custody.decisionId, labels_sha256: got, run_sha256: null });
      docs.push({ id: `${s.id}:${f.path}`, corpus: s.id, slug: `${s.id === 'stress' ? 'notes' : s.id}/${slugPart(f.path.replace(/\.(md|markdown|txt|json)$/, ''))}-${got.slice(0, 6)}`, content: renderNFile(f.path, fileBytes.toString('utf8')) });
    }
  }
  return { manifest_sha256: sha256, manifest_id: m.id, docs, beam_excluded: beamExcluded, strata: m.strata.map(s => ({ id: s.id, files: s.id === 'beam' ? beamExcluded?.conversations_kept ?? 0 : s.files?.length ?? 0, license: s.license, source: s.source, commit: s.commit ?? null })) };
}

/** Development pages committed under eval/data/q2-parser-gaps/<sub>/ (stress shapes and templates written for dev). */
export function devMaterialPages(sub: 'dev-stress' | 'dev-templates', corpus: NStratum): MintDoc[] {
  const dir = join(DEV_MATERIAL_DIR, sub);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /\.(md|json)$/.test(f)).sort().map(f => ({
    id: `${corpus}:${f}`, corpus, slug: `${corpus === 'stress' ? 'notes' : corpus}/dev-${slugPart(f.replace(/\.(md|json)$/, ''))}`, content: renderNFile(f, readFileSync(join(dir, f), 'utf8')),
  }));
}

/** Development N: H3's vault dev part, BEAM dev conversations, and the dev stress and template pages. */
export function devNDocs(strata: readonly NStratum[] = N_STRATA, deps: { loadBeam?: (ids: Set<string>) => Array<{ id: string; sessions: Session[] }> } = {}): MintDoc[] {
  const out: MintDoc[] = [];
  if (strata.includes('vault')) out.push(...loadDocs('blue-book', 'dev').map(d => ({ ...d, corpus: 'vault' })));
  if (strata.includes('beam')) out.push(...beamPages((deps.loadBeam ?? (x => loadBeam('1m', x).conversations))(new Set(loadSplit('beam-1m').dev))));
  if (strata.includes('templates')) out.push(...devMaterialPages('dev-templates', 'templates'));
  if (strata.includes('stress')) out.push(...devMaterialPages('dev-stress', 'stress'));
  return out;
}
