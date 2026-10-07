/**
 * Launcher for one audited cell of the public agent-memory benchmark harness.
 *
 *   bun run harness:cell plan   <spec.json | cell-id>   free: resolve, write cell.json, print the cost estimate
 *   bun run harness:cell run    <spec.json | cell-id>   run a planned (or new) cell through the metering proxy
 *   bun run harness:cell resume <cell-id>               continue a cell; refuses when anything it depends on changed
 *   bun run harness:cell tune <cell-id> --grid <json>   retrieval-only knob sweep on an ingested cell (no answer or judge calls)
 *   bun run harness:cell cli    -- <harness CLI args>   the harness's own CLI with gbrain and comparator registered
 *
 * Flags: --stub-upstream (keyless: every model request goes to the local stub
 * upstream, against a throwaway ledger), --budget-ledger <path>,
 * --gbrain <checkout>[@ref] (or GBRAIN_UNDER_TEST), --cells-dir <dir>
 * (default eval/reports/harness-cells).
 *
 * A cell id is content-addressed: the sha256 of the dataset and schedule
 * manifest hashes, the harness commit and lock, the gbrain and comparator
 * identities, the resolved provider config, mode, lane, target, models,
 * prompt, scorer and wrapper revisions, budget and seal. Everything a cell
 * writes lives under `<cells-dir>/<cell-id>/`, so two configurations never
 * share a store, cache or output. A cell runs its stages once; `resume`
 * continues missing receipts only, and never re-runs a failed question.
 *
 * Models are set only through OMB_ANSWER_LLM / OMB_ANSWER_MODEL and
 * OMB_JUDGE_LLM / OMB_JUDGE_MODEL; children get a clean environment whose
 * provider keys are metering-proxy tokens, never real keys.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BudgetRun, budgetOptionsFrom, closeLedgers, initLedger, priceRequest } from './budget-ledger.ts';
import { gbrainSpecFrom, resolveGbrainUnderTest, productIdentityFor, type GbrainUnderTest } from './gbrain-under-test.ts';
import { ensureHarness, harnessProcessEnv, PROVIDER_DIR, REPO_ROOT, type HarnessInstall } from './harness-env.ts';

export const DEFAULT_CELLS_DIR = join(REPO_ROOT, 'eval/reports/harness-cells');
export const CELL_SCHEMA = 'mpw-cell-v1';
export const PROVIDERS = ['gbrain', 'comparator', 'bm25', 'qdrant', 'vanilla', 'full-context'] as const;
export const MODES = ['rag', 'agentic-rag', 'agent', 'retrieval'] as const;
export const SEALS = ['public', 'dev', 'validation', 'sealed', 'fixture'] as const;

export interface CellSpec {
  dataset: string;
  split: string;
  provider: (typeof PROVIDERS)[number];
  mode: (typeof MODES)[number];
  lane: 'raw' | 'facts' | 'combined';
  seal: (typeof SEALS)[number];
  /** Delivered-context target in cl100k tokens, or null for the system's own default (reported, not gated). */
  target_tokens: number | null;
  models: { answer: string; judge: string | null };
  budget_usd: number;
  questions: { limit?: number; ids?: string[]; units?: string[]; per_unit?: number };
  provider_config?: Record<string, unknown>;
  k?: number;
  /** Proxy credentials the gbrain child may use (default: voyage only, the zero-LLM write path). */
  gbrain_credentials?: string[];
  /** Spend the cell cannot meter, declared up front (e.g. a provider's own hosted API). */
  unmetered?: string[];
  note?: string;
}

export interface ResolvedCell {
  dataset: string; split: string; task_type: string; isolation_unit: string | null;
  schedule: string[]; schedule_sha256: string; dataset_manifest_sha256: string;
  questions: number; units: string[]; documents: number; document_tokens_cl100k: number;
  document_tokens_by_unit: Record<string, number>;
  timestamp_provenance: unknown; dataset_judge_model: string | null;
  judge_calls?: number;
  prompt_revision: string; scorer_revision: string; wrapper_revision: string;
}

export interface CellFile {
  schema: typeof CELL_SCHEMA;
  cell_id: string;
  identity: Record<string, unknown>;
  spec: CellSpec;
  resolved: ResolvedCell;
  planned_at: string;
  estimate: CellEstimate;
  reproduce: string;
}

// ─── spec ────────────────────────────────────────────────────────────

export function validateSpec(raw: unknown): CellSpec {
  const s = raw as CellSpec;
  const problems: string[] = [];
  if (!s || typeof s !== 'object') throw new Error('a cell spec must be a JSON object');
  if (!s.dataset || !s.split) problems.push('dataset and split are required');
  if (!PROVIDERS.includes(s.provider)) problems.push(`provider must be one of ${PROVIDERS.join(', ')}`);
  if (!MODES.includes(s.mode)) problems.push(`mode must be one of ${MODES.join(', ')}`);
  if (!['raw', 'facts', 'combined'].includes(s.lane)) problems.push('lane must be raw, facts or combined');
  if (!SEALS.includes(s.seal)) problems.push(`seal must be one of ${SEALS.join(', ')}`);
  if (s.target_tokens !== null && !(Number.isInteger(s.target_tokens) && s.target_tokens > 0)) problems.push('target_tokens must be a positive integer or null');
  if (!s.models || !/^[a-z-]+:.+/.test(s.models.answer ?? '') && s.mode !== 'retrieval') problems.push('models.answer must be "<llm>:<model>"');
  if (s.models?.judge !== null && s.models?.judge !== undefined && !/^[a-z-]+:.+/.test(s.models.judge)) problems.push('models.judge must be "<llm>:<model>" or null');
  if (!(typeof s.budget_usd === 'number' && s.budget_usd > 0)) problems.push('budget_usd must be a positive number');
  if (!s.questions || typeof s.questions !== 'object') problems.push('questions selection is required');
  if (problems.length) throw new Error(`invalid cell spec: ${problems.join('; ')}`);
  return s;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]])) : val);

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** What the cell id commits to. */
export function cellIdentity(spec: CellSpec, resolved: ResolvedCell, pins: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: CELL_SCHEMA,
    dataset: spec.dataset, split: spec.split,
    dataset_manifest_sha256: resolved.dataset_manifest_sha256,
    schedule_sha256: resolved.schedule_sha256,
    pins,
    provider: spec.provider,
    provider_config: spec.provider_config ?? {},
    gbrain_credentials: spec.provider === 'gbrain' ? (spec.gbrain_credentials ?? ['voyage']) : null,
    mode: spec.mode, lane: spec.lane, seal: spec.seal, k: spec.k ?? null,
    target_tokens: spec.target_tokens,
    models: spec.models,
    prompt_revision: resolved.prompt_revision,
    scorer_revision: resolved.scorer_revision,
    wrapper_revision: resolved.wrapper_revision,
    budget_usd: spec.budget_usd,
  };
}

export function cellId(spec: CellSpec, identity: Record<string, unknown>): string {
  const slug = `${spec.dataset}-${spec.split}-${spec.provider}-${spec.mode}`.replace(/[^A-Za-z0-9-]+/g, '-');
  return `${slug}-${sha256(canonical(identity)).slice(0, 12)}`;
}

/** Field-level differences between two identities, for a refused resume. */
export function identityDiff(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) out.push(...identityDiff(x as Record<string, unknown>, y as Record<string, unknown>, `${prefix}${k}.`));
    else if (canonical(x) !== canonical(y)) out.push(`${prefix}${k}`);
  }
  return out;
}

// ─── models and prices ───────────────────────────────────────────────

export function splitModel(id: string): { llm: string; model: string } {
  const i = id.indexOf(':');
  return { llm: id.slice(0, i), model: id.slice(i + 1) };
}

const PRICE_URL: Record<string, (model: string) => string> = {
  openai: () => 'https://api.openai.com/v1/chat/completions',
  anthropic: () => 'https://api.anthropic.com/v1/messages',
  gemini: m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
  groq: () => 'https://api.groq.com/openai/v1/chat/completions',
};

/** List price (USD per 1M tokens) through the ledger's own pricing, or null when it has none. */
export function chatPrice(id: string): { input: number; output: number } | null {
  const { llm, model } = splitModel(id);
  const url = PRICE_URL[llm]?.(model);
  if (!url) return null;
  try {
    const p = priceRequest(url, { model, messages: [], contents: [], max_tokens: 1, generationConfig: { maxOutputTokens: 1 } });
    return p ? { input: p.input, output: p.output } : null;
  } catch {
    return null;
  }
}

export function embeddingPrice(model: string): number | null {
  const [provider, name] = model.split(':');
  const url = provider === 'voyage' ? 'https://api.voyageai.com/v1/embeddings' : provider === 'openai' ? 'https://api.openai.com/v1/embeddings' : null;
  if (!url) return null;
  try { return priceRequest(url, { model: name, input: 'x' })?.input ?? null; } catch { return null; }
}

export interface CellEstimate {
  usd: number;
  lines: Array<{ stage: string; tokens_in: number; tokens_out: number; usd: number | null; basis: string }>;
  unpriced: string[];
  note: string;
}

/**
 * Expected cost from token volumes and list prices. Assumptions are written
 * into each line; the paid acceptance cells replace them with measured
 * usage (eval/harness-provider/LEDGER.md).
 */
export function estimateCell(spec: CellSpec, resolved: ResolvedCell, assumptions: EstimateAssumptions = DEFAULT_ASSUMPTIONS): CellEstimate {
  const lines: CellEstimate['lines'] = [];
  const unpriced: string[] = [];
  const add = (stage: string, model: string | null, tin: number, tout: number, price: { input: number; output: number } | null, basis: string) => {
    if (model && !price) unpriced.push(`${stage}: ${model}`);
    lines.push({ stage, tokens_in: Math.round(tin), tokens_out: Math.round(tout), usd: price ? (tin * price.input + tout * price.output) / 1e6 : model ? null : 0, basis });
  };
  const docTokens = resolved.document_tokens_cl100k;
  const q = resolved.questions;
  if (spec.provider === 'gbrain') {
    const emb = String((spec.provider_config ?? {}).embedding_model ?? 'voyage:voyage-4');
    const p = embeddingPrice(emb);
    add('ingest: gbrain embeddings', emb, docTokens * assumptions.embed_token_ratio, 0, p === null ? null : { input: p, output: 0 },
      `${docTokens} cl100k document tokens x ${assumptions.embed_token_ratio} (provider tokenizer and chunk overlap)`);
    add('retrieve: gbrain query embeddings', emb, q * 64, 0, p === null ? null : { input: p, output: 0 }, '64 tokens per question');
  } else if (spec.provider === 'comparator') {
    const model = String((spec.provider_config ?? {}).extraction_model ?? assumptions.comparator_extraction_model);
    add('ingest: comparator extraction', model, docTokens * assumptions.comparator_extract_in, docTokens * assumptions.comparator_extract_out, chatPrice(model),
      `${docTokens} document tokens x ${assumptions.comparator_extract_in} in / x ${assumptions.comparator_extract_out} out (extraction passes)`);
  }
  if (spec.mode !== 'retrieval') {
    const ctx = spec.target_tokens ?? assumptions.default_context_tokens;
    const calls = spec.mode === 'agentic-rag' ? assumptions.agentic_calls : 1;
    add('answer', spec.models.answer, q * calls * (ctx + assumptions.prompt_overhead_tokens), q * calls * assumptions.answer_output_tokens, chatPrice(spec.models.answer),
      `${q} questions x ${calls} call(s) x (${ctx} context + ${assumptions.prompt_overhead_tokens} prompt) in, ${assumptions.answer_output_tokens} out`);
  }
  if (resolved.task_type === 'open' && spec.mode !== 'retrieval') {
    const judge = resolved.dataset_judge_model ?? spec.models.judge;
    const calls = resolved.judge_calls ?? q;
    add('judge', judge, calls * assumptions.judge_in_tokens, calls * assumptions.judge_out_tokens, judge ? chatPrice(judge) : null,
      `${calls} judge calls x ${assumptions.judge_in_tokens} in / ${assumptions.judge_out_tokens} out`);
  }
  const usd = lines.reduce((s, l) => s + (l.usd ?? 0), 0);
  return { usd: Number(usd.toFixed(4)), lines, unpriced, note: 'list-price estimate from token volumes; the run is enforced by the metering proxy, not by this number' };
}

export interface EstimateAssumptions {
  embed_token_ratio: number; comparator_extraction_model: string; comparator_extract_in: number; comparator_extract_out: number;
  default_context_tokens: number; prompt_overhead_tokens: number; answer_output_tokens: number; agentic_calls: number;
  judge_in_tokens: number; judge_out_tokens: number;
}

export const DEFAULT_ASSUMPTIONS: EstimateAssumptions = {
  // Measured on the 2026-10-05 acceptance cells (eval/harness-provider/LEDGER.md), except agentic_calls.
  embed_token_ratio: 1.59, comparator_extraction_model: 'openai:gpt-4o-mini', comparator_extract_in: 6.14, comparator_extract_out: 0.73,
  default_context_tokens: 16000, prompt_overhead_tokens: 350, answer_output_tokens: 2200, agentic_calls: 4,
  judge_in_tokens: 730, judge_out_tokens: 330,
};

// ─── plan / run / resume ─────────────────────────────────────────────

interface Ctx {
  argv: string[];
  cellsDir: string;
  install: HarnessInstall;
  gut: GbrainUnderTest;
  stub: boolean;
  log: (line: string) => void;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function pinsFor(ctx: Ctx, spec: CellSpec): Record<string, unknown> {
  const pins: Record<string, unknown> = {
    harness_commit: ctx.install.lock.harness_commit,
    harness_lock_sha256: ctx.install.lock_sha256,
    torch: ctx.install.torch_version,
  };
  if (spec.provider === 'gbrain') {
    const id = productIdentityFor(ctx.gut);
    pins.gbrain = { version: ctx.gut.version, declared_pin: id.declared_pin, loaded_git_head: (id as { loaded_git_head?: string }).loaded_git_head ?? null, package_sha256: id.package_sha256 };
  }
  if (spec.provider === 'comparator') {
    const lock = join(PROVIDER_DIR, 'comparator.lock.json');
    pins.comparator_lock_sha256 = existsSync(lock) ? sha256(readFileSync(lock)) : null;
  }
  return pins;
}

function python(ctx: Ctx, args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([ctx.install.python, '-m', ...args], {
    cwd: PROVIDER_DIR, env: harnessProcessEnv(ctx.install, env), stdout: 'pipe', stderr: 'pipe',
  });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

export function resolveSpec(ctx: Ctx, spec: CellSpec): ResolvedCell {
  const tmp = join(ctx.cellsDir, '.spec-' + sha256(canonical(spec)).slice(0, 12) + '.json');
  mkdirSync(ctx.cellsDir, { recursive: true });
  writeFileSync(tmp, JSON.stringify(spec));
  const r = python(ctx, ['mpw.cell', 'resolve', '--spec', tmp]);
  if (r.code !== 0) throw new Error(`resolving the cell failed: ${r.stderr.slice(-3000)}`);
  const line = r.stdout.trim().split('\n').pop()!;
  return JSON.parse(line) as ResolvedCell;
}

function loadSpecOrCell(ctx: Ctx, target: string): { spec: CellSpec; existing: CellFile | null } {
  if (existsSync(target) && target.endsWith('.json')) {
    const raw = JSON.parse(readFileSync(target, 'utf8'));
    if (raw.schema === CELL_SCHEMA) return { spec: validateSpec(raw.spec), existing: raw as CellFile };
    return { spec: validateSpec(raw), existing: null };
  }
  const path = join(ctx.cellsDir, target, 'cell.json');
  if (!existsSync(path)) throw new Error(`no cell ${target} under ${ctx.cellsDir}; pass a spec file to plan one`);
  const cell = JSON.parse(readFileSync(path, 'utf8')) as CellFile;
  return { spec: validateSpec(cell.spec), existing: cell };
}

export function planCell(ctx: Ctx, target: string): CellFile {
  const { spec, existing } = loadSpecOrCell(ctx, target);
  const resolved = resolveSpec(ctx, spec);
  if (resolved.dataset_judge_model && spec.models.judge && resolved.dataset_judge_model !== spec.models.judge) {
    throw new Error(`${spec.dataset} forces its judge to ${resolved.dataset_judge_model} in the harness; set models.judge to that id (the scorer asserts it)`);
  }
  const identity = cellIdentity(spec, resolved, pinsFor(ctx, spec));
  const id = cellId(spec, identity);
  if (existing && existing.cell_id !== id) {
    throw new Error(`cell ${existing.cell_id} no longer matches its inputs (now ${id}); changed: ${identityDiff(existing.identity, identity).join(', ')}. Plan a new cell from the spec; a sealed cell never reruns under a new configuration.`);
  }
  const dir = join(ctx.cellsDir, id);
  const path = join(dir, 'cell.json');
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as CellFile;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 2) + '\n');
  const cell: CellFile = {
    schema: CELL_SCHEMA, cell_id: id, identity, spec, resolved, planned_at: new Date().toISOString(),
    estimate: estimateCell(spec, resolved),
    reproduce: `bun run harness:cell run ${(existsSync(target) ? resolve(target) : join(dir, 'spec.json')).replace(REPO_ROOT + '/', '')}`,
  };
  writeFileSync(path, JSON.stringify(cell, null, 2) + '\n');
  return cell;
}

function stageReceiptCount(dir: string): number {
  const stages = join(dir, 'stages');
  if (!existsSync(stages)) return 0;
  return readdirSync(stages).reduce((n, s) => n + readdirSync(join(stages, s)).filter(f => f.endsWith('.json')).length, 0);
}

const LLM_PROVIDER: Record<string, string> = { gemini: 'gemini', openai: 'openai', anthropic: 'anthropic', groq: 'groq' };

export function harnessCredentials(spec: CellSpec, resolved: ResolvedCell): string[] {
  const models = [spec.models.answer, spec.models.judge, resolved.dataset_judge_model].filter((m): m is string => !!m);
  return [...new Set(models.map(m => LLM_PROVIDER[splitModel(m).llm]).filter(Boolean))];
}

function pick(env: Record<string, string>, providers: string[]): Record<string, string> {
  const keep: Record<string, string[]> = {
    openai: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'],
    gemini: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENERATIVE_AI_BASE_URL'],
    groq: ['GROQ_API_KEY', 'GROQ_BASE_URL'],
    voyage: ['VOYAGE_API_KEY', 'VOYAGE_BASE_URL'],
  };
  const names = new Set(providers.flatMap(p => keep[p] ?? []));
  return Object.fromEntries(Object.entries(env).filter(([k]) => names.has(k)));
}

const PROVIDER_FILES: Record<string, string> = { gbrain: 'gbrain_provider.py', comparator: 'comparator_provider.py' };

/**
 * Cells whose ingest inputs are equal share one store: same dataset split,
 * provider, ingest-affecting config keys (INGEST_KEYS in the provider module),
 * credentials, pins and the provider's INGEST_REVISION. Retrieval knobs,
 * targets, models and budgets do not change what ingest writes, so a target
 * sweep or a lane that only retrieves differently reuses one ingest.
 */
export function storeIdentity(spec: CellSpec, pins: Record<string, unknown>): { id: string; identity: Record<string, unknown> } | null {
  const file = PROVIDER_FILES[spec.provider];
  if (!file) return null;
  const source = readFileSync(join(PROVIDER_DIR, 'mpw', file), 'utf8');
  const revision = /INGEST_REVISION = "([^"]+)"/.exec(source)?.[1];
  const keys = /INGEST_KEYS = \(([^)]*)\)/.exec(source)?.[1].match(/"([^"]+)"/g)?.map(k => k.slice(1, -1)) ?? [];
  if (!revision) throw new Error(`${file} declares no INGEST_REVISION`);
  const config = (spec.provider_config ?? {}) as Record<string, unknown>;
  const identity = {
    schema: 'mpw-store-v1', dataset: spec.dataset, split: spec.split, provider: spec.provider, revision,
    ingest_config: Object.fromEntries(keys.filter(k => k in config).map(k => [k, config[k]])),
    credentials: spec.provider === 'gbrain' ? (spec.gbrain_credentials ?? ['voyage']) : null,
    pins,
  };
  return { id: `${spec.provider}-${spec.dataset}-${spec.split}-${sha256(canonical(identity)).slice(0, 12)}`.replace(/[^A-Za-z0-9-]+/g, '-'), identity };
}

interface SpendFile { cell_id: string; runs: Array<{ run_id: string; ledger: string; usd: number; requests: number; started_at: string; stub: boolean }>; }

export async function runCell(ctx: Ctx, target: string, resume: boolean, tuneGrid: string | null = null): Promise<number> {
  const cell = planCell(ctx, target);
  const dir = join(ctx.cellsDir, cell.cell_id);
  const receipts = stageReceiptCount(dir);
  if (tuneGrid !== null && !existsSync(join(dir, 'stages', 'ingest'))) {
    throw new Error(`cell ${cell.cell_id} has no ingest receipts; run it (or a cheap copy with the same dataset slice) before tuning its retrieval knobs`);
  }
  if (tuneGrid === null && !resume && receipts > 0) {
    throw new Error(`cell ${cell.cell_id} already has ${receipts} stage receipts. Continue it with \`bun run harness:cell resume ${cell.cell_id}\`; plan a new cell to change anything.`);
  }
  if (resume && receipts === 0) ctx.log(`[cell] ${cell.cell_id} has no receipts yet; resume starts it`);
  const spendPath = join(dir, 'spend.json');
  const spend: SpendFile = existsSync(spendPath) ? JSON.parse(readFileSync(spendPath, 'utf8')) : { cell_id: cell.cell_id, runs: [] };
  const spent = spend.runs.filter(r => r.stub === ctx.stub).reduce((s, r) => s + r.usd, 0);
  const remaining = cell.spec.budget_usd - spent;
  if (remaining <= 0.0001) throw new Error(`cell ${cell.cell_id} has spent its $${cell.spec.budget_usd.toFixed(2)} budget. Inspect it with \`bun eval/runner/budget-ledger.ts status\`; a larger budget is a new cell.`);

  const { startMeteringProxy } = await import('./metering-proxy.ts');
  let stub: Awaited<ReturnType<typeof import('./stub-upstream.ts')['startStubUpstream']>> | null = null;
  let ledgerPath = budgetOptionsFrom(ctx.argv).ledgerPath;
  if (ctx.stub) {
    const { startStubUpstream } = await import('./stub-upstream.ts');
    stub = await startStubUpstream();
    ledgerPath = join(dir, 'stub-ledger.sqlite');
    if (!existsSync(ledgerPath)) initLedger({ ledgerPath, programCapUsd: 1000, reason: 'keyless stub-upstream cell: no real spend' });
  }
  const run = BudgetRun.open({ runner: `harness-cell:${cell.cell_id}`, budgetUsd: remaining, estimateUsd: Math.min(remaining, cell.estimate.usd), ledgerPath, log: ctx.log });
  const proxyDir = join(dir, 'proxy');
  mkdirSync(proxyDir, { recursive: true });
  const upstreams = stub ? stub.upstreams : undefined;
  const realKeys = stub ? Object.fromEntries(['openai', 'anthropic', 'gemini', 'groq', 'voyage'].map(p => [p, 'stub-upstream-key'])) : undefined;
  const proxy = await startMeteringProxy({
    run, cellId: cell.cell_id, requestLogPath: join(proxyDir, 'requests.jsonl'), bodiesDir: join(proxyDir, 'bodies'),
    labels: ['harness', 'gbrain', 'comparator'], upstreams, realKeys,
  });
  const exhaustedFlag = join(proxyDir, 'exhausted');
  const answer = cell.spec.models.answer ? splitModel(cell.spec.models.answer) : null;
  const judge = cell.spec.models.judge ? splitModel(cell.spec.models.judge) : null;
  const env: Record<string, string> = {
    ...pick(proxy.envFor('harness'), harnessCredentials(cell.spec, cell.resolved)),
    ...(answer ? { OMB_ANSWER_LLM: answer.llm, OMB_ANSWER_MODEL: answer.model } : {}),
    ...(judge ? { OMB_JUDGE_LLM: judge.llm, OMB_JUDGE_MODEL: judge.model } : {}),
    MPW_PROXY_LOG: join(proxyDir, 'requests.jsonl'),
    MPW_PROXY_BODIES: join(proxyDir, 'bodies'),
    MPW_PROXY_EXHAUSTED_FLAG: exhaustedFlag,
    MPW_PROVIDER_CONFIG: JSON.stringify(cell.spec.provider_config ?? {}),
    MPW_GBRAIN_CLI: join(ctx.gut.root, 'src/cli.ts'),
    MPW_BUN: process.execPath,
    // gbrain reads GOOGLE_GENERATIVE_AI_BASE_URL (builds with the Google base-URL override) and appends /v1beta itself.
    MPW_CHILD_ENV_GBRAIN: JSON.stringify(pick({ ...proxy.envFor('gbrain'), VOYAGE_BASE_URL: proxy.baseUrls.voyage, GOOGLE_GENERATIVE_AI_BASE_URL: proxy.baseUrls.gemini }, cell.spec.gbrain_credentials ?? ['voyage'])),
    MPW_CHILD_ENV_COMPARATOR: JSON.stringify(proxy.envFor('comparator')),
    MPW_REPO_ROOT: REPO_ROOT,
  };
  const store = storeIdentity(cell.spec, pinsFor(ctx, cell.spec));
  if (store && !ctx.argv.includes('--private-store')) {
    const storeDir = join(ctx.cellsDir, '_stores', store.id);
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'store.json'), JSON.stringify(store.identity, null, 2) + '\n');
    env.MPW_STORE_DIR = storeDir;
    env.MPW_STORE_ID = store.id;
    ctx.log(`[cell] store ${store.id} (shared by cells with the same ingest inputs)`);
  }
  ctx.log(`[cell] ${cell.cell_id}: ${resume ? 'resuming' : 'running'} with $${remaining.toFixed(2)} of $${cell.spec.budget_usd.toFixed(2)} left; proxy ${proxy.url}${ctx.stub ? ' -> stub upstream (keyless)' : ''}`);
  const pyArgs = tuneGrid === null ? ['mpw.cell', 'run', '--cell-dir', dir]
    : tuneGrid.startsWith('auto:') ? ['mpw.tune', '--cell-dir', dir, '--auto', tuneGrid.slice(5)]
    : ['mpw.tune', '--cell-dir', dir, '--grid', tuneGrid];
  if (ctx.argv.includes('--ingest-only')) env.MPW_INGEST_ONLY = '1';
  const child = Bun.spawn([ctx.install.python, '-m', ...pyArgs], {
    cwd: PROVIDER_DIR, env: harnessProcessEnv(ctx.install, env), stdout: 'inherit', stderr: 'inherit',
  });
  const onSignal = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let code: number;
  const watchExhausted = setInterval(() => { if (proxy.exhausted && !existsSync(exhaustedFlag)) writeFileSync(exhaustedFlag, new Date().toISOString()); }, 200);
  try {
    code = await child.exited;
  } finally {
    clearInterval(watchExhausted);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    const stats = proxy.stats();
    await proxy.close();
    stub?.close();
    const summary = run.close();
    spend.runs.push({ run_id: summary.run_id, ledger: ledgerPath.replace(REPO_ROOT + '/', ''), usd: Number(summary.actual_usd.toFixed(6)), requests: summary.requests, started_at: new Date().toISOString(), stub: ctx.stub });
    writeFileSync(spendPath, JSON.stringify({ ...spend, metered_by_label: stats, unmetered: cell.spec.unmetered ?? [] }, null, 2) + '\n');
    closeLedgers();
  }
  ctx.log(`[cell] ${cell.cell_id} exited ${code}; receipts in ${dir.replace(REPO_ROOT + '/', '')}`);
  return code;
}

/**
 * Joint blinded re-judge of two or more cells over the same schedule, through
 * the metering proxy, with the dataset's own judge (mpw/rejudge.py).
 */
export async function rejudgeCells(ctx: Ctx, ids: string[], budgetUsd: number, out: string, seed: string): Promise<number> {
  const cells = ids.map(id => JSON.parse(readFileSync(join(ctx.cellsDir, id, 'cell.json'), 'utf8')) as CellFile);
  const judge = cells[0].resolved.dataset_judge_model ?? cells[0].spec.models.judge;
  if (!judge) throw new Error('these cells have no judge model');
  const { startMeteringProxy } = await import('./metering-proxy.ts');
  const ledgerPath = budgetOptionsFrom(ctx.argv).ledgerPath;
  const run = BudgetRun.open({ runner: `harness-rejudge:${ids.join('+')}`.slice(0, 200), budgetUsd, ledgerPath, log: ctx.log });
  mkdirSync(join(out, 'proxy'), { recursive: true });
  const proxy = await startMeteringProxy({ run, cellId: `rejudge:${ids.join('+')}`, requestLogPath: join(out, 'proxy/requests.jsonl'), bodiesDir: join(out, 'proxy/bodies'), labels: ['harness'] });
  const j = splitModel(judge);
  const env = { ...pick(proxy.envFor('harness'), [LLM_PROVIDER[j.llm]]), OMB_JUDGE_LLM: j.llm, OMB_JUDGE_MODEL: j.model,
    OMB_ANSWER_LLM: j.llm, OMB_ANSWER_MODEL: j.model, MPW_PROXY_LOG: join(out, 'proxy/requests.jsonl'), MPW_PROXY_BODIES: join(out, 'proxy/bodies') };
  const child = Bun.spawn([ctx.install.python, '-m', 'mpw.rejudge', ...ids.flatMap(id => ['--cell', join(ctx.cellsDir, id)]), '--seed', seed, '--out', out, '--judge-model', judge], {
    cwd: PROVIDER_DIR, env: harnessProcessEnv(ctx.install, env), stdout: 'inherit', stderr: 'inherit',
  });
  let code: number;
  try { code = await child.exited; } finally {
    const stats = proxy.stats();
    await proxy.close();
    const summary = run.close();
    writeFileSync(join(out, 'spend.json'), JSON.stringify({ run_id: summary.run_id, usd: summary.actual_usd, requests: summary.requests, metered: stats }, null, 2) + '\n');
    closeLedgers();
  }
  return code;
}

/**
 * A further answer sample for a finished rag cell, from its recorded
 * retrievals, through the metering proxy (mpw/reanswer.py). Variance checks
 * re-judge it jointly with the original cell.
 */
export async function reanswerCell(ctx: Ctx, id: string, sample: number, budgetUsd: number, out: string): Promise<number> {
  const cell = JSON.parse(readFileSync(join(ctx.cellsDir, id, 'cell.json'), 'utf8')) as CellFile;
  const { startMeteringProxy } = await import('./metering-proxy.ts');
  const run = BudgetRun.open({ runner: `harness-reanswer:${id}-s${sample}`, budgetUsd, ledgerPath: budgetOptionsFrom(ctx.argv).ledgerPath, log: ctx.log });
  const proxyDir = join(out, `${id}-s${sample}`, 'proxy');
  mkdirSync(proxyDir, { recursive: true });
  const proxy = await startMeteringProxy({ run, cellId: `${id}-s${sample}`, requestLogPath: join(proxyDir, 'requests.jsonl'), bodiesDir: join(proxyDir, 'bodies'), labels: ['harness'] });
  const a = splitModel(cell.spec.models.answer);
  const j = cell.spec.models.judge ? splitModel(cell.spec.models.judge) : a;
  const env = { ...pick(proxy.envFor('harness'), [...new Set([LLM_PROVIDER[a.llm], LLM_PROVIDER[j.llm]])]), OMB_ANSWER_LLM: a.llm, OMB_ANSWER_MODEL: a.model,
    OMB_JUDGE_LLM: j.llm, OMB_JUDGE_MODEL: j.model, MPW_PROXY_LOG: join(proxyDir, 'requests.jsonl'), MPW_PROXY_BODIES: join(proxyDir, 'bodies') };
  const child = Bun.spawn([ctx.install.python, '-m', 'mpw.reanswer', '--cell', join(ctx.cellsDir, id), '--out', out, '--sample', String(sample)], {
    cwd: PROVIDER_DIR, env: harnessProcessEnv(ctx.install, env), stdout: 'inherit', stderr: 'inherit',
  });
  let code: number;
  try { code = await child.exited; } finally {
    const stats = proxy.stats();
    await proxy.close();
    const summary = run.close();
    writeFileSync(join(out, `${id}-s${sample}`, 'spend.json'), JSON.stringify({ run_id: summary.run_id, usd: summary.actual_usd, requests: summary.requests, metered: stats }, null, 2) + '\n');
    closeLedgers();
  }
  return code;
}

/**
 * Retrieval-only replay of a finished rag cell on the gbrain build given with
 * --gbrain, against a copy of the cell's store (the original is never written),
 * through the metering proxy (eval/harness-provider/mpw_tools/replay.py). Used to
 * check a later build against a run's delivered contexts; nothing is answered.
 */
export async function replayCell(ctx: Ctx, id: string, storeDir: string, out: string, budgetUsd: number): Promise<number> {
  const dir = join(ctx.cellsDir, id);
  const cell = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8')) as CellFile;
  if (!existsSync(join(storeDir, 'store.json'))) throw new Error(`${storeDir} is not a cell store (no store.json)`);
  mkdirSync(out, { recursive: true });
  const store = join(out, 'store');
  if (!existsSync(store)) cpSync(storeDir, store, { recursive: true });
  const { startMeteringProxy } = await import('./metering-proxy.ts');
  const run = BudgetRun.open({ runner: `harness-replay:${id}`, budgetUsd, ledgerPath: budgetOptionsFrom(ctx.argv).ledgerPath, log: ctx.log });
  const proxyDir = join(out, 'proxy');
  mkdirSync(proxyDir, { recursive: true });
  const proxy = await startMeteringProxy({ run, cellId: `replay:${id}`, requestLogPath: join(proxyDir, 'requests.jsonl'), bodiesDir: join(proxyDir, 'bodies'), labels: ['harness', 'gbrain', 'comparator'] });
  const env: Record<string, string> = {
    ...pick(proxy.envFor('harness'), harnessCredentials(cell.spec, cell.resolved)),
    MPW_PROXY_LOG: join(proxyDir, 'requests.jsonl'), MPW_PROXY_BODIES: join(proxyDir, 'bodies'),
    MPW_PROVIDER_CONFIG: JSON.stringify(cell.spec.provider_config ?? {}),
    MPW_GBRAIN_CLI: join(ctx.gut.root, 'src/cli.ts'), MPW_BUN: process.execPath,
    MPW_CHILD_ENV_GBRAIN: JSON.stringify(pick({ ...proxy.envFor('gbrain'), VOYAGE_BASE_URL: proxy.baseUrls.voyage, GOOGLE_GENERATIVE_AI_BASE_URL: proxy.baseUrls.gemini }, cell.spec.gbrain_credentials ?? ['voyage'])),
    MPW_CHILD_ENV_COMPARATOR: JSON.stringify(proxy.envFor('comparator')),
    MPW_REPO_ROOT: REPO_ROOT, MPW_STORE_DIR: store, MPW_STORE_ID: `replay-${id}`,
  };
  // The cell's models are named so its setup checks pass; the replay itself makes no answer or judge call.
  for (const [role, model] of [['ANSWER', cell.spec.models.answer], ['JUDGE', cell.spec.models.judge]] as const) {
    if (!model) continue;
    const m = splitModel(model);
    env[`OMB_${role}_LLM`] = m.llm; env[`OMB_${role}_MODEL`] = m.model;
  }
  ctx.log(`[replay] ${id} on ${ctx.gut.root}; store copy ${store}; proxy ${proxy.url}`);
  const child = Bun.spawn([ctx.install.python, '-m', 'mpw_tools.replay', '--cell', dir, '--out', out], {
    cwd: PROVIDER_DIR, env: harnessProcessEnv(ctx.install, env), stdout: 'inherit', stderr: 'inherit',
  });
  let code: number;
  try { code = await child.exited; } finally {
    const stats = proxy.stats();
    await proxy.close();
    const summary = run.close();
    writeFileSync(join(out, 'spend.json'), JSON.stringify({ run_id: summary.run_id, usd: summary.actual_usd, requests: summary.requests, metered: stats }, null, 2) + '\n');
    closeLedgers();
  }
  return code;
}

export function makeCtx(argv: string[], log: (l: string) => void = l => process.stderr.write(l + '\n')): Ctx {
  const cellsDir = resolve(flag(argv, '--cells-dir') ?? DEFAULT_CELLS_DIR);
  return { argv, cellsDir, install: ensureHarness({ log }), gut: resolveGbrainUnderTest(gbrainSpecFrom(argv)), stub: argv.includes('--stub-upstream'), log };
}

export const USAGE = `usage: bun run harness:cell <plan|run|resume> <spec.json | cell-id> [--stub-upstream] [--budget-ledger <path>] [--gbrain <checkout>[@ref]] [--cells-dir <dir>]
       bun run harness:cell rejudge <cell-id> <cell-id> [--out <dir>] [--seed N] [--budget-usd N]   joint blinded re-judge with the dataset's judge
       bun run harness:cell reanswer <cell-id> [--sample N] [--out <dir>] [--budget-usd N]   another answer sample from the recorded retrievals
       bun run harness:cell replay <cell-id> --store <store dir> --out <dir> --gbrain <checkout>@<ref> [--budget-usd N]   retrieval-only replay on another build
       bun run harness:cell ingest <spec.json | cell-id>   ingest every unit into the shared store, no questions
       bun run harness:cell tune <cell-id> --auto '{"targets": [4000, 8000, 16000, 32000], "base": {"token_budget": 8100}, "sample": 60}'
       bun run harness:cell tune <cell-id> --grid '{"token_budget": [6000, 7000, 8000]}'   retrieval-only knob sweep on an ingested cell
       bun run harness:cell cli -- <harness CLI arguments>   (keyless only: --stub-upstream is implied)`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [action, target] = argv;
  try {
    if (action === 'cli') {
      const install = ensureHarness();
      const rest = argv.slice(argv.indexOf('--') >= 0 ? argv.indexOf('--') + 1 : 1);
      const proc = Bun.spawnSync([install.python, '-c', 'import sys; from mpw import register; register.install(); from memory_bench.cli import app; sys.argv[0] = "amb"; app()', ...rest], {
        cwd: PROVIDER_DIR, env: harnessProcessEnv(install), stdout: 'inherit', stderr: 'inherit',
      });
      process.exit(proc.exitCode ?? 1);
    }
    if (action === 'ingest') argv.push('--ingest-only');
    if (!['plan', 'run', 'resume', 'tune', 'rejudge', 'reanswer', 'replay', 'ingest'].includes(action ?? '') || !target) { console.error(USAGE); process.exit(2); }
    const ctx = makeCtx(argv);
    if (action === 'plan') {
      const cell = planCell(ctx, target);
      console.log(JSON.stringify({ cell_id: cell.cell_id, dir: join(ctx.cellsDir, cell.cell_id).replace(REPO_ROOT + '/', ''), questions: cell.resolved.questions,
        units: cell.resolved.units.length, documents: cell.resolved.documents, document_tokens_cl100k: cell.resolved.document_tokens_cl100k,
        estimate: cell.estimate, reproduce: cell.reproduce }, null, 2));
      process.exit(0);
    }
    if (action === 'rejudge') {
      const ids = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
      const out = resolve(flag(argv, '--out') ?? join(ctx.cellsDir, `rejudge-${Date.now()}`));
      process.exit(await rejudgeCells(ctx, ids, Number(flag(argv, '--budget-usd') ?? 2), out, flag(argv, '--seed') ?? '20261005'));
    }
    if (action === 'replay') {
      const store = flag(argv, '--store'), out = flag(argv, '--out');
      if (!store || !out) throw new Error('replay needs --store <the cell\'s store dir> and --out <dir>');
      process.exit(await replayCell(ctx, target, resolve(store), resolve(out), Number(flag(argv, '--budget-usd') ?? 5)));
    }
    if (action === 'reanswer') {
      const out = resolve(flag(argv, '--out') ?? ctx.cellsDir);
      process.exit(await reanswerCell(ctx, target, Number(flag(argv, '--sample') ?? 2), Number(flag(argv, '--budget-usd') ?? 5), out));
    }
    if (action === 'tune') {
      const grid = flag(argv, '--grid');
      const auto = flag(argv, '--auto');
      if (!grid && !auto) throw new Error('tune needs --grid \'{"token_budget": [6000, 8000]}\' or --auto \'{"targets": [4000, 8000], "base": {"token_budget": 8100}, "sample": 60}\'');
      process.exit(await runCell(ctx, target, true, grid ?? `auto:${auto}`));
    }
    if (action === 'ingest') process.exit(await runCell(ctx, target, true));
    process.exit(await runCell(ctx, target, action === 'resume'));
  } catch (error) {
    console.error(`[harness:cell] ${(error as Error).message}`);
    process.exit(1);
  }
}
