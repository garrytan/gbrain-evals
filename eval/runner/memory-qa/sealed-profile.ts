/**
 * Sealed execution profile for memory-qa custodian cells (plan "Sealed
 * execution profile"; Astra review 3).
 *
 * A sealed cell writes everything (rows, answers, reader contexts, vendor
 * traces, the QA and embedding caches) inside one custodian-owned root, never
 * in the repository and never in the shared home-directory caches. Only
 * `exportAggregates` crosses back out: preregistered aggregate fields, each a
 * finite number, a boolean, a hex hash or a value from a fixed vocabulary, so
 * no answer, source id, exception text, context or filename can ride along.
 *
 *   bun eval/runner/memory-qa/sealed-profile.ts export --receipt <custody>/receipt.json --out <public file>
 *   bun eval/runner/memory-qa/sealed-profile.ts export-cell --cell <custody memory-qa output> --out <public dir>
 *     (a multi-arm cell: one allowlisted file per arm, named by the arm id from the public arms file)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const SHARED_CACHE_ROOT = join(homedir(), '.cache', 'gbrain-evals');

const real = (p: string) => { const abs = resolve(p); try { return realpathSync(abs); } catch { return abs; } };
const inside = (child: string, parent: string) => { const r = relative(real(parent), real(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

export interface SealedPaths { custodyRoot: string; output: string; qaCache: string; embedCache: string }

/** The cache locations a sealed cell must use: inside its own custody root, never shared. */
export function sealedPaths(custodyRoot: string, output: string): SealedPaths {
  return { custodyRoot: resolve(custodyRoot), output: resolve(output), qaCache: join(resolve(custodyRoot), 'cache', 'qa'), embedCache: join(resolve(custodyRoot), 'cache', 'embed') };
}

/** Throws unless every destination sits inside the custody root, outside the repository and outside the shared caches. */
export function checkSealedDestinations(p: SealedPaths): void {
  const problems: string[] = [];
  if (inside(p.custodyRoot, REPO_ROOT) || inside(REPO_ROOT, p.custodyRoot)) problems.push('the custody root overlaps the repository');
  if (inside(p.custodyRoot, SHARED_CACHE_ROOT) || inside(SHARED_CACHE_ROOT, p.custodyRoot)) problems.push('the custody root overlaps the shared gbrain-evals cache');
  for (const [name, path] of [['output', p.output], ['QA cache', p.qaCache], ['embedding cache', p.embedCache]] as const) {
    if (!inside(path, p.custodyRoot)) problems.push(`the ${name} is outside the custody root`);
    if (inside(path, REPO_ROOT)) problems.push(`the ${name} is inside the repository`);
    if (inside(path, SHARED_CACHE_ROOT)) problems.push(`the ${name} is inside the shared cache`);
  }
  if (problems.length) throw new Error(`sealed profile refused: ${problems.join('; ')}`);
}

const HEX = /^[0-9a-f]{64}$/;
const VOCAB: Record<string, readonly string[]> = {
  kind: ['memory-qa-arm'], split: ['dev', 'sealed'], run_status: ['complete', 'partial', 'invalid'], context: ['native', 'rehydrated'],
  'policy.mode': ['vendor-default', 'fixed-evidence'],
  benchmark: ['locomo', 'lme-s', 'beam-100k', 'beam-500k', 'beam-1m', 'fixture', 'custody'],
  'system.name': ['gbrain', 'gbrain-shootout', 'fake', 'extract-first', 'temporal-graph', 'graph-pipeline', 'agent-runtime', 'markdown-notes', 'memory-bank', 'full-context', 'no-memory', 'plain-hybrid'],
};
const HASHES = ['run_config_hash', 'manifest_sha256'];
const NUMERIC_PREFIXES = ['schema_version', 'selection.questions_expected', 'selection.conversations', 'counts.', 'summary.', 'outcomes.', 'cost.usd', 'ingest.', 'comparison_complete'];

function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  else out[prefix] = value;
  return out;
}

/** The allowlisted aggregate view of a sealed receipt. Anything not provably an aggregate is dropped, never copied. */
export function exportAggregates(receipt: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(flatten(receipt))) {
    if (VOCAB[path]) { if (typeof v === 'string' && VOCAB[path].includes(v)) out[path] = v; continue; }
    if (HASHES.includes(path)) { if (typeof v === 'string' && HEX.test(v)) out[path] = v; continue; }
    if (!NUMERIC_PREFIXES.some(p => p.endsWith('.') ? path.startsWith(p) : path === p)) continue;
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || v === null) out[path] = v;
  }
  return out;
}

const ARM_ID = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * Export a sealed multi-arm cell: `<cell>/arms/<arm id>/receipt.json` becomes `<out>/<arm id>.json`, each through
 * `exportAggregates`. Arm ids come from the public arms file; any other directory name is refused, not copied.
 */
export function exportCell(cellDir: string, outDir: string): string[] {
  const armsDir = join(cellDir, 'arms');
  if (inside(outDir, cellDir)) throw new Error('the export directory must be outside the sealed cell output');
  const arms = existsSync(armsDir) ? readdirSync(armsDir).filter(a => existsSync(join(armsDir, a, 'receipt.json'))).sort() : [];
  if (!arms.length) throw new Error(`${cellDir} holds no arm receipts (arms/<id>/receipt.json)`);
  const bad = arms.filter(a => !ARM_ID.test(a));
  if (bad.length) throw new Error(`${bad.length} arm director${bad.length === 1 ? 'y has' : 'ies have'} a name outside [A-Za-z0-9._-]; nothing was exported`);
  mkdirSync(outDir, { recursive: true });
  for (const a of arms) writeFileSync(join(outDir, `${a}.json`), JSON.stringify(exportAggregates(JSON.parse(readFileSync(join(armsDir, a, 'receipt.json'), 'utf8'))), null, 2) + '\n');
  return arms;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] === 'export-cell' && one('--cell') && one('--out')) {
    const arms = exportCell(resolve(one('--cell')!), resolve(one('--out')!));
    console.log(`exported ${arms.length} arms`);
    process.exit(0);
  }
  if (argv[0] !== 'export' || !one('--receipt') || !one('--out')) { console.error('usage: bun eval/runner/memory-qa/sealed-profile.ts export --receipt <custody receipt.json> --out <file>'); process.exit(2); }
  const out = resolve(one('--out')!);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(exportAggregates(JSON.parse(readFileSync(one('--receipt')!, 'utf8'))), null, 2) + '\n');
  console.log(out);
}
