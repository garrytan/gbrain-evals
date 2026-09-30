/**
 * Loads gbrain modules from a checkout (GBRAIN_DIR) the way the R1 driver did,
 * and records the checkout's identity: commit, tree, dirty diff, and the
 * hashes of the parser, chunker, search and delivery code that shape the
 * evidence. The study measures the code that ships, so the candidate stage is
 * imported from the pinned checkout, never re-implemented here.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './data.ts';

/** Files whose bytes decide chunk text, ranking or delivered evidence. */
export const EVIDENCE_CODE_FILES = [
  'src/core/import-file.ts',
  'src/core/markdown.ts',
  'src/core/remote-body.ts',
  'src/core/chunkers/recursive.ts',
  'src/core/chunkers/token-estimate.ts',
  'src/core/search/hybrid.ts',
  'src/core/search/evidence-delivery.ts',
  'src/core/search/output-redaction.ts',
  'src/eval/longmemeval/adapter.ts',
  'src/eval/longmemeval/reader.ts',
  'src/eval/longmemeval/sanitize.ts',
  'src/eval/longmemeval/judge.ts',
];
export const PARSER_FILES = ['src/core/import-file.ts', 'src/core/markdown.ts', 'src/core/remote-body.ts', 'src/core/chunkers/recursive.ts', 'src/eval/longmemeval/adapter.ts'];

export interface GbrainIdentity {
  dir_label: 'GBRAIN_DIR';
  commit: string;
  tree: string;
  dirty: boolean;
  dirty_sha256: string | null;
  version: string | null;
  code_sha256: Record<string, string | null>;
  parser_sha256: string;
  evidence_code_sha256: string;
}

const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();

export function gbrainIdentity(dir: string): GbrainIdentity {
  const status = git(dir, ['status', '--porcelain', '--untracked-files=normal', '--', 'src']);
  const diff = status ? git(dir, ['diff', 'HEAD', '--', 'src']) + '\n' + status : '';
  const code: Record<string, string | null> = {};
  for (const f of EVIDENCE_CODE_FILES) code[f] = existsSync(join(dir, f)) ? sha256(readFileSync(join(dir, f))) : null;
  const joined = (files: string[]) => sha256(files.map(f => `${f}:${code[f] ?? (existsSync(join(dir, f)) ? sha256(readFileSync(join(dir, f))) : 'absent')}`).join('\n'));
  let version: string | null = null;
  try { version = readFileSync(join(dir, 'VERSION'), 'utf8').trim(); } catch { /* no VERSION file */ }
  return {
    dir_label: 'GBRAIN_DIR', commit: git(dir, ['rev-parse', 'HEAD']), tree: git(dir, ['rev-parse', 'HEAD^{tree}']),
    dirty: status.length > 0, dirty_sha256: status ? sha256(diff) : null, version, code_sha256: code,
    parser_sha256: joined(PARSER_FILES), evidence_code_sha256: joined(EVIDENCE_CODE_FILES),
  };
}

export function resolveGbrainDir(explicit?: string | null): string {
  const dir = resolve(explicit ?? process.env.GBRAIN_DIR ?? '');
  if (!explicit && !process.env.GBRAIN_DIR) throw new Error('set GBRAIN_DIR (or --gbrain-dir) to the gbrain checkout under test');
  if (!existsSync(join(dir, 'src/cli.ts'))) throw new Error(`${dir} is not a gbrain checkout`);
  return dir;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface GbrainModules {
  dir: string;
  harness: { createBenchmarkBrain: () => Promise<any>; resetTables: (e: any) => Promise<void>; brainRecycler?: (first: any, every: number, create: () => Promise<any>, configure: (e: any) => Promise<void>) => { next(): Promise<any>; close(): Promise<void> }; LME_BRAIN_RECYCLE_EVERY?: number };
  adapter: { haystackToPages: (q: any) => Array<{ slug: string; content: string }> };
  metrics: { sessionIdFromSlug: (slug: string) => string; buildSlugToRawMap: (q: any) => Map<string, string[]>; rawSessionId: (slug: string, map: Map<string, string[]>) => string };
  importFile: { importFromContent: (engine: any, slug: string, content: string, opts: any) => Promise<unknown> };
  hybrid: { hybridSearch: (engine: any, query: string, opts: any) => Promise<any[]> };
  embedCache: { EmbeddingCache: new (path: string) => any; installEmbedCache: (cache: any, opts: any) => { uninstall(): void; model: string; dims: number } };
  reader: { READER_NOTES_SYSTEM_TEXT: string; READER_MAX_SESSION_CHARS: number; buildReaderUserText: (i: { question: string; questionDate?: string; rendered: string }) => string };
  sanitize: { renderChatBlock: (s: Array<{ session_id: string; date?: string; body: string }>, o: { maxSessionChars?: number }) => { rendered: string; truncatedCount: number } };
  tokens: { estimateTokens: (s: string) => number };
  gateway: { configureGateway: (c: any) => void; chat: (opts: any) => Promise<any> };
  buildGatewayConfig: (c: any) => any;
  judge: { judgeRow: (input: any, ctx: any) => Promise<any> };
  judgeRunner: { BudgetLedger: new (a: any, b: any) => any };
  evidence: null | { assembleEvidenceForHits: (engine: any, input: any) => Promise<{ results: any[]; delivery: any; unresolved: any[] }>; evidenceFingerprint: (results: any[]) => string };
}

export async function loadGbrain(dir: string, opts: { requireEvidence?: boolean } = {}): Promise<GbrainModules> {
  const imp = (p: string) => import(join(dir, p));
  const [harness, adapter, metrics, importFile, hybrid, embedCache, reader, sanitize, tokens, gateway, bgc, judge, judgeRunner] = await Promise.all([
    imp('src/eval/longmemeval/harness.ts'), imp('src/eval/longmemeval/adapter.ts'), imp('src/eval/longmemeval/metrics.ts'),
    imp('src/core/import-file.ts'), imp('src/core/search/hybrid.ts'), imp('src/eval/shared/embed-cache.ts'),
    imp('src/eval/longmemeval/reader.ts'), imp('src/eval/longmemeval/sanitize.ts'), imp('src/core/chunkers/token-estimate.ts'),
    imp('src/core/ai/gateway.ts'), imp('src/core/ai/build-gateway-config.ts'), imp('src/eval/longmemeval/judge.ts'), imp('src/eval/shared/judge-runner.ts'),
  ]);
  let evidence: GbrainModules['evidence'] = null;
  if (existsSync(join(dir, 'src/core/search/evidence-delivery.ts'))) {
    const mod = await imp('src/core/search/evidence-delivery.ts');
    if (typeof mod.assembleEvidenceForHits === 'function' && typeof mod.evidenceFingerprint === 'function') evidence = mod;
  }
  if (opts.requireEvidence && !evidence) throw new Error(`${dir} has no src/core/search/evidence-delivery.ts exporting assembleEvidenceForHits and evidenceFingerprint`);
  return { dir, harness, adapter, metrics, importFile, hybrid, embedCache, reader, sanitize, tokens, gateway, buildGatewayConfig: bgc.buildGatewayConfig, judge, judgeRunner, evidence };
}

export function configureGbrainGateway(g: GbrainModules, embeddingModel = 'openai:text-embedding-3-large', dims = 1536) {
  g.gateway.configureGateway(g.buildGatewayConfig({ embedding_model: embeddingModel, embedding_dimensions: dims }));
}
