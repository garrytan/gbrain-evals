import Anthropic from '@anthropic-ai/sdk';
import { configPath as gbrainConfigPath, loadConfig } from 'gbrain/config';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runCat5, CAT5_CATEGORY, type Claim, type Cat5Report } from './cat5-provenance.ts';
import { runCat8, CAT8_CATEGORY, type SkillComplianceProbe, type Cat8Report } from './cat8-skill-compliance.ts';
import { runCat9, CAT9_CATEGORY, ALL_WORKFLOWS, type WorkflowScenario, type Cat9Report } from './cat9-workflows.ts';
import { ClaudeSonnetWithToolsAdapter, type AgentAdapterState } from './adapters/claude-sonnet-with-tools.ts';
import { sanitizePage, type Page } from './types.ts';
import type { PoisonFixture } from './tool-bridge.ts';
import { BENCHMARK_VERSION, loadReceipt, receiptPath, writeReceipt, type Receipt } from './receipt.ts';
import { gbrainPin, gbrainVersion } from './gbrain-version.ts';
import { resolveRegressionProduct, type ResolvedRegressionProduct } from './situation-recall-provenance.ts';

export type ProgrammaticCategory = 'cat5' | 'cat8' | 'cat9';
export type ProgrammaticMode = 'validate' | 'offline' | 'live';

export interface ProgrammaticCatalogBase {
  schema_version: 1;
  corpus_id: string;
  catalog_status: 'reviewed' | 'test-only';
  provenance: string;
  pages: Page[];
  enable_thresholds: boolean;
  calibration_reference?: string;
}

export type ProgrammaticCatalog = ProgrammaticCatalogBase & (
  | { category: 'cat5'; claims: Claim[] }
  | { category: 'cat8'; probes: SkillComplianceProbe[]; poison_fixtures: PoisonFixture[] }
  | { category: 'cat9'; scenarios: WorkflowScenario[]; poison_fixtures: PoisonFixture[] }
);

export interface ProgrammaticOptions {
  category: ProgrammaticCategory;
  inputPath: string;
  outputDir: string;
  mode?: ProgrammaticMode;
  allowPaid?: boolean;
  maxUsd?: number;
  isolatedProviderBudgetReference?: string;
  expectedProductSha?: string;
  expectedPackageSha256?: string;
  isolatedRuntime?: { home: string; config: string; database: string };
}

export interface ProgrammaticDependencies {
  agentClient?: Anthropic;
  judgeClient?: Anthropic;
  createState?: (pages: Page[], poisonFixtures: PoisonFixture[]) => Promise<AgentAdapterState>;
  disposeState?: (state: AgentAdapterState) => Promise<void>;
}

export interface ProgrammaticResult {
  schema_version: 1;
  category: ProgrammaticCategory;
  mode: ProgrammaticMode;
  status: 'validated' | 'completed' | 'blocked' | 'error';
  publishable: boolean;
  reason?: string;
  receipt_path: string;
  native_receipt_path: string;
  result_path: string;
  probe_ids: string[];
  product_identity?: ResolvedRegressionProduct;
  report?: Cat5Report | Cat8Report | Cat9Report;
  exit_code: number;
}

export const PROGRAMMATIC_CATEGORIES = {
  cat5: CAT5_CATEGORY,
  cat8: CAT8_CATEGORY,
  cat9: CAT9_CATEGORY,
} as const;

const SEARCH_CONFIG = {
  'search.mode': 'balanced',
  'search.reranker.enabled': 'false',
  'memory.cues.generation_enabled': 'false',
  'memory.cues.read': 'off',
  'memory.cues.push': 'false',
};
const PAGE_TYPES = new Set(['person', 'company', 'meeting', 'concept', 'deal', 'project', 'source', 'media', 'email', 'slack', 'calendar-event', 'note']);
let environmentActive = false;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function array(value: unknown, label: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a nonempty'} array`);
  return value;
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
}

function rejectTemplates(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if ((key === '_example' || key === 'template') && item !== false) throw new Error('Template/example catalogs are not real category inputs');
    rejectTemplates(item);
  }
}

export function validateProgrammaticCatalog(value: unknown, category: ProgrammaticCategory): ProgrammaticCatalog {
  const catalog = object(value, 'catalog');
  rejectTemplates(catalog);
  if (catalog.schema_version !== 1 || catalog.category !== category) throw new Error('catalog schema_version/category mismatch');
  text(catalog.corpus_id, 'corpus_id');
  text(catalog.provenance, 'provenance');
  if (catalog.catalog_status !== 'reviewed' && catalog.catalog_status !== 'test-only') throw new Error('catalog_status must be reviewed or test-only');
  if (typeof catalog.enable_thresholds !== 'boolean') throw new Error('enable_thresholds must be explicit');
  if (catalog.enable_thresholds) text(catalog.calibration_reference, 'calibration_reference');
  const pages = array(catalog.pages, 'pages').map((value, i) => {
    const page = object(value, `pages[${i}]`);
    text(page.slug, 'page.slug');
    text(page.title, 'page.title');
    if (!PAGE_TYPES.has(page.type as string)) throw new Error('page.type is unsupported');
    if (typeof page.compiled_truth !== 'string' || typeof page.timeline !== 'string') throw new Error('page compiled_truth and timeline must be strings');
    if (!`${page.compiled_truth}${page.timeline}`.trim()) throw new Error('page must contain source text');
    return page as unknown as Page;
  });
  unique(pages.map(page => page.slug), 'page slugs');
  const slugs = new Set(pages.map(page => page.slug));
  const references = (value: unknown, label: string, allowEmpty = false): void => {
    const refs = array(value, label, allowEmpty).map(slug => text(slug, label));
    unique(refs, label);
    for (const slug of refs) if (!slugs.has(slug)) throw new Error(`${label} references missing page ${slug}`);
  };
  const items = array(catalog[category === 'cat5' ? 'claims' : category === 'cat8' ? 'probes' : 'scenarios'], 'category inputs').map((value, i) => {
    const item = object(value, `category inputs[${i}]`);
    text(item.id, 'input.id');
    if (category === 'cat5') {
      text(item.claim_text, 'claim_text');
      references([item.source_page], 'source_page');
      references(item.expected_evidence, 'expected_evidence', true);
      if (!['supported', 'unsupported', 'over-generalized'].includes(item.expected_label as string)) throw new Error('invalid claim expected_label');
    } else {
      text(item.text, 'input.text');
      if (category === 'cat8') {
        if (item.tier !== 'simple' && item.tier !== 'complex') throw new Error('probe tier must be simple or complex');
        if (item.expects_dry_run_write !== undefined && typeof item.expects_dry_run_write !== 'boolean') throw new Error('expects_dry_run_write must be boolean');
      } else {
        if (!ALL_WORKFLOWS.includes(item.workflow as WorkflowScenario['workflow'])) throw new Error('invalid workflow');
        references(item.ground_truth_slugs, 'ground_truth_slugs');
        const rubricIds = array(item.rubric, 'rubric').map(value => {
          const criterion = object(value, 'rubric criterion');
          text(criterion.criterion, 'criterion');
          if (criterion.weight !== 1 && criterion.weight !== 2) throw new Error('rubric weight must be 1 or 2');
          return text(criterion.id, 'criterion.id');
        });
        unique(rubricIds, 'rubric ids');
      }
    }
    return text(item.id, 'input.id');
  });
  unique(items, 'input ids');
  if (category !== 'cat5') {
    const poisonIds = array(catalog.poison_fixtures, 'poison_fixtures', true).map(value => {
      const fixture = object(value, 'poison fixture');
      references([fixture.slug], 'poison slug');
      if (fixture.kind !== undefined) text(fixture.kind, 'poison kind');
      return text(fixture.fixture_id, 'fixture_id');
    });
    unique(poisonIds, 'poison fixture ids');
  }
  return catalog as unknown as ProgrammaticCatalog;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  renameSync(temporary, path);
}

export async function runSituationRecallProgrammatic(
  options: ProgrammaticOptions,
  dependencies?: ProgrammaticDependencies,
): Promise<ProgrammaticResult> {
  if (!Object.hasOwn(PROGRAMMATIC_CATEGORIES, options.category)) throw new Error('category must be cat5, cat8 or cat9');
  const mode = options.mode ?? 'validate';
  if (!['validate', 'offline', 'live'].includes(mode)) throw new Error('invalid execution mode');
  const output = resolve(options.outputDir);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const startedAt = new Date().toISOString();
  const nativeRoot = join(output, 'native');
  const nativeReceiptPath = receiptPath(PROGRAMMATIC_CATEGORIES[options.category], nativeRoot);
  const result: ProgrammaticResult = {
    schema_version: 1,
    category: options.category,
    mode,
    status: 'blocked',
    publishable: false,
    receipt_path: join(output, 'receipt.json'),
    native_receipt_path: nativeReceiptPath,
    result_path: join(output, 'result.json'),
    probe_ids: [],
    exit_code: 2,
  };
  let receipt: Receipt = {
    schema_version: 1,
    benchmark_version: BENCHMARK_VERSION,
    category: PROGRAMMATIC_CATEGORIES[options.category],
    run_status: 'skipped',
    skip_reason: 'Driver prerequisites not satisfied',
    n_total: 0,
    n_scored: 0,
    completion_rate: 0,
    errors: [],
    publishable: false,
    gbrain_pin: gbrainPin(),
    gbrain_version: gbrainVersion(),
    started_at: startedAt,
    finished_at: startedAt,
  };
  const provenance: Record<string, unknown> = {
    execution_mode: mode,
    feature_exposure: options.category === 'cat5' ? 'not_applicable_no_retrieval' : 'candidate_off_only',
    budget_enforcement: 'external_isolated_provider_budget_required; driver does not enforce dollars',
    product_identity_status: 'unverified_nonlive',
  };
  const hashes: Record<string, string> = { driver: hash(readFileSync(import.meta.path, 'utf8')) };
  let state: AgentAdapterState | undefined;
  let originalEnv: NodeJS.ProcessEnv | undefined;
  const adapter = new ClaudeSonnetWithToolsAdapter();
  let executing = false;
  try {
    const rawInput = readFileSync(resolve(options.inputPath), 'utf8');
    hashes.catalog = hash(rawInput);
    const catalog = validateProgrammaticCatalog(JSON.parse(rawInput), options.category);
    const inputs = catalog.category === 'cat5' ? catalog.claims : catalog.category === 'cat8' ? catalog.probes : catalog.scenarios;
    result.probe_ids = inputs.map(item => item.id);
    receipt.n_total = inputs.length;
    hashes.corpus = hash(JSON.stringify(catalog.pages.map(sanitizePage)));
    hashes.gold = hash(JSON.stringify(inputs));
    provenance.corpus_id = catalog.corpus_id;
    provenance.catalog_status = catalog.catalog_status;
    provenance.catalog_provenance = catalog.provenance;
    provenance.calibration_reference = catalog.calibration_reference ?? null;
    if (mode === 'validate') {
      result.status = 'validated';
      result.reason = 'Input validation only; no category executed';
    } else {
      if (mode === 'live') {
        if (dependencies) throw new Error('Injected dependencies cannot execute in live mode');
        if (!options.allowPaid) throw new Error('Live execution requires --allow-paid');
        if (!Number.isFinite(options.maxUsd) || options.maxUsd! <= 0 || !options.isolatedProviderBudgetReference?.trim()) {
          throw new Error('Live execution requires a positive --max-usd and --provider-budget-reference for an externally enforced isolated provider budget');
        }
        if (catalog.catalog_status !== 'reviewed') throw new Error('Live execution requires a reviewed real input catalog, not a test-only catalog');
        if (!options.expectedProductSha && !options.expectedPackageSha256) throw new Error('Live execution requires --expected-product-sha or --expected-package-sha256');
        if (options.expectedProductSha && !/^[a-f0-9]{40}$/.test(options.expectedProductSha)) throw new Error('expected product SHA must be 40 lowercase hex characters');
        if (options.expectedPackageSha256 && !/^[a-f0-9]{64}$/.test(options.expectedPackageSha256)) throw new Error('expected package SHA256 must be 64 lowercase hex characters');
        if (!process.env.ANTHROPIC_API_KEY) throw new Error('Live execution requires ANTHROPIC_API_KEY');
        result.product_identity = resolveRegressionProduct({
          evalRoot: resolve(import.meta.dir, '../..'),
          expectedProductSha: options.expectedProductSha,
          expectedPackageSha256: options.expectedPackageSha256,
        });
        provenance.product_identity_status = 'verified';
        provenance.loaded_product = result.product_identity;
        provenance.authorized_max_usd = options.maxUsd;
        provenance.isolated_provider_budget_reference = options.isolatedProviderBudgetReference;
      } else {
        if (!dependencies) throw new Error('Offline execution requires explicitly injected dependencies; there is no scripted CLI capability fallback');
        if (catalog.category !== 'cat5' && !dependencies.agentClient) throw new Error('Offline execution requires an injected agentClient');
        if (catalog.category !== 'cat8' && !dependencies.judgeClient) throw new Error('Offline execution requires an injected judgeClient');
        if (dependencies.createState && !dependencies.disposeState) throw new Error('Injected createState requires disposeState');
      }
      const pages = catalog.pages.map(sanitizePage);
      const pagesBySlug = new Map(pages.map(page => [page.slug, {
        slug: page.slug,
        title: page.title,
        content: [page.compiled_truth, page.timeline].filter(Boolean).join('\n'),
      }]));
      if (!dependencies?.createState) {
        if (environmentActive) throw new Error('Concurrent real programmatic runtimes require separate processes');
        const namespace = options.isolatedRuntime ?? {
          home: join(output, 'runtime', 'home'),
          config: join(output, 'runtime', 'home', '.gbrain', 'config.json'),
          database: join(output, 'runtime', 'brain'),
        };
        const paths = Object.values(namespace);
        const roots = [namespace.home, namespace.database];
        if (namespace.config !== join(namespace.home, '.gbrain', 'config.json')) throw new Error('Runtime config must be <home>/.gbrain/config.json, the path used by the public resolver');
        if (paths.some(path => !isAbsolute(path) || resolve(path) !== path || existsSync(path))
          || new Set(paths).size !== paths.length
          || roots.some((parent, i) => roots.some((child, j) => i !== j && !relative(parent, child).startsWith('..')))) {
          throw new Error('Runtime paths must be fresh and absolute; home and database must not overlap');
        }
        mkdirSync(namespace.home, { recursive: true });
        mkdirSync(dirname(namespace.config), { recursive: true });
        mkdirSync(dirname(namespace.database), { recursive: true });
        writeFileSync(namespace.config, JSON.stringify({ engine: 'pglite' }) + '\n', { flag: 'wx', mode: 0o600 });
        originalEnv = { ...process.env };
        const allowed = Object.fromEntries(['PATH', 'LANG', 'TZ', ...(mode === 'live' ? ['ANTHROPIC_API_KEY'] : [])]
          .filter(key => originalEnv![key] !== undefined).map(key => [key, originalEnv![key]!]));
        environmentActive = true;
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, allowed, {
          HOME: namespace.home, GBRAIN_HOME: namespace.home,
          XDG_CONFIG_HOME: join(namespace.home, '.config'), XDG_CACHE_HOME: join(namespace.home, '.cache'),
          GBRAIN_CONFIG: namespace.config, GBRAIN_DB_PATH: namespace.database,
        });
        if (gbrainConfigPath() !== namespace.config || loadConfig()?.engine !== 'pglite') throw new Error('Public config resolver did not load the isolated programmatic configuration');
        provenance.isolated_runtime = { ...namespace, engine: 'fresh in-memory PGLite', approved_provider_keys: mode === 'live' ? ['ANTHROPIC_API_KEY'] : [] };
      }
      executing = true;
      if (catalog.category !== 'cat5') {
        state = dependencies?.createState
          ? await dependencies.createState(pages, catalog.poison_fixtures)
          : await adapter.init(pages, { name: 'claude-sonnet-with-tools', poisonFixtures: catalog.poison_fixtures, searchConfig: SEARCH_CONFIG }) as AgentAdapterState;
      }
      const shared = { reportsRoot: nativeRoot, concurrency: 1, enableThreshold: catalog.enable_thresholds };
      const liveClient = mode === 'live' ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : undefined;
      if (catalog.category === 'cat5') {
        result.report = await runCat5({ ...shared, claims: catalog.claims, pagesBySlug, client: dependencies?.judgeClient ?? liveClient });
      } else if (catalog.category === 'cat8') {
        result.report = await runCat8({ ...shared, probes: catalog.probes, state: state!, client: dependencies?.agentClient ?? liveClient, corpusSha: hashes.corpus });
      } else {
        result.report = await runCat9({ ...shared, scenarios: catalog.scenarios, state: state!, pagesBySlug, agentClient: dependencies?.agentClient ?? liveClient, judgeClient: dependencies?.judgeClient ?? liveClient, corpusSha: hashes.corpus });
      }
      receipt = loadReceipt(nativeReceiptPath);
      if (mode === 'offline') {
        receipt.publishable = false;
        if ('publishable' in result.report) result.report.publishable = false;
        receipt.resolved_config = { ...receipt.resolved_config, execution_mode: 'offline', capability_evidence: false };
        writeReceipt(nativeReceiptPath, receipt);
      }
      result.status = receipt.run_status === 'completed' ? 'completed' : 'error';
      result.publishable = mode === 'live' && receipt.publishable && receipt.n_total === receipt.n_scored && receipt.errors.length === 0;
      result.exit_code = result.publishable && receipt.verdict === 'pass' ? 0 : 2;
      if (mode === 'offline') result.reason = 'Offline plumbing only; not evidence of model or retrieval quality';
      else if (receipt.n_total !== receipt.n_scored || receipt.errors.length > 0) result.reason = 'Native probe accounting is incomplete or contains errors; this cannot satisfy a release cell';
      else if (receipt.verdict === 'partial') result.reason = 'Native baseline_only verdict; calibration/threshold gate remains incomplete';
    }
  } catch (error) {
    result.status = executing ? 'error' : 'blocked';
    result.reason = error instanceof Error ? error.message : String(error);
    if (executing) {
      receipt.run_status = 'error';
      delete receipt.skip_reason;
      delete receipt.verdict;
      receipt.errors.push({ probe_id: '__driver__', origin: 'harness', message: result.reason });
    }
  } finally {
    if (state) {
      try {
        if (dependencies?.createState) await dependencies.disposeState!(state);
        else await adapter.teardown(state);
      } catch {
        result.status = 'error';
        result.publishable = false;
        result.exit_code = 2;
        result.reason = 'Agent state teardown failed';
        receipt.run_status = 'error';
        delete receipt.verdict;
        delete receipt.skip_reason;
        receipt.errors.push({ probe_id: '__driver__', origin: 'harness', message: result.reason });
      }
    }
    if (originalEnv) {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      environmentActive = false;
    }
  }
  if (receipt.run_status === 'skipped') receipt.skip_reason = result.reason ?? receipt.skip_reason;
  receipt.publishable = result.publishable;
  receipt.finished_at = new Date().toISOString();
  receipt.hashes = { ...receipt.hashes, ...hashes };
  receipt.resolved_config = { ...receipt.resolved_config, ...provenance };
  receipt.data = { result_path: result.result_path, native_receipt_path: nativeReceiptPath, probe_ids: result.probe_ids, report: result.report ?? null };
  atomicJson(result.result_path, result);
  writeReceipt(result.receipt_path, receipt);
  return result;
}

export const PROGRAMMATIC_USAGE = `bun eval/runner/situation-recall-programmatic.ts --category cat5|cat8|cat9 --input <catalog.json> --output <new-directory>
Default: validate only, nonpublishable, exit 2. There is no built-in gold catalog.
Live: additionally --live --allow-paid --max-usd <amount> --provider-budget-reference <external-enforced-budget-reference>
and --expected-product-sha <40-hex> or --expected-package-sha256 <64-hex> (required for archive installs).
The dollar amount is an authorization declaration, not a driver-enforced spending cap.
The external isolated budget must cover all providers, including agent-tool subcalls.
Cats8/9 use real ClaudeSonnetWithToolsAdapter state, cues off. Cat5 does not retrieve.
Real execution isolates HOME/config/DB and retains only ANTHROPIC_API_KEY for live providers.
Optional --home, --config and --database must be supplied together as fresh absolute paths.
--config must be <home>/.gbrain/config.json; home and database must not overlap.
Catalog: schema_version=1, category, corpus_id, catalog_status=reviewed|test-only, provenance,
pages=[{slug,type,title,compiled_truth,timeline}], enable_thresholds (plus calibration_reference if true),
cat5 claims=[Claim]; cat8 probes=[SkillComplianceProbe] and poison_fixtures=[];
cat9 scenarios=[WorkflowScenario] and poison_fixtures=[]. IDs must be unique; all gold slugs must resolve.
Native runner contracts define Claim, SkillComplianceProbe and WorkflowScenario. Template examples are rejected.
Judge source content is compiled_truth plus timeline, joined by a newline; adapters receive only public page fields.
Offline API tests require injected clients and always produce nonpublishable results.
Outputs: result.json, receipt.json and native/<category>/receipt.json plus native flight-recorder bundles.`;

export function parseProgrammaticArgs(args: string[]): ProgrammaticOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg) || flags.has(arg)) throw new Error(`Duplicate option ${arg}`);
    if (arg === '--live' || arg === '--allow-paid') flags.add(arg);
    else if (['--category', '--input', '--output', '--max-usd', '--provider-budget-reference', '--expected-product-sha', '--expected-package-sha256', '--home', '--config', '--database'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      values.set(arg, value);
    } else throw new Error(`Unknown option ${arg}`);
  }
  const category = values.get('--category');
  if (!category || !Object.hasOwn(PROGRAMMATIC_CATEGORIES, category)) throw new Error('--category must be cat5, cat8 or cat9');
  if (!values.has('--input') || !values.has('--output')) throw new Error('--input and --output are required');
  const runtimePaths = ['--home', '--config', '--database'].filter(key => values.has(key));
  if (runtimePaths.length !== 0 && runtimePaths.length !== 3) throw new Error('--home, --config and --database must be supplied together');
  if (!flags.has('--live') && (flags.has('--allow-paid') || values.has('--max-usd') || values.has('--provider-budget-reference'))) throw new Error('Paid authorization flags require --live');
  return {
    category: category as ProgrammaticCategory,
    inputPath: values.get('--input')!,
    outputDir: values.get('--output')!,
    mode: flags.has('--live') ? 'live' : 'validate',
    allowPaid: flags.has('--allow-paid'),
    maxUsd: values.has('--max-usd') ? Number(values.get('--max-usd')) : undefined,
    isolatedProviderBudgetReference: values.get('--provider-budget-reference'),
    expectedProductSha: values.get('--expected-product-sha'),
    expectedPackageSha256: values.get('--expected-package-sha256'),
    isolatedRuntime: runtimePaths.length ? { home: values.get('--home')!, config: values.get('--config')!, database: values.get('--database')! } : undefined,
  };
}

if (import.meta.main) {
  if (process.argv.slice(2).includes('--help')) console.log(PROGRAMMATIC_USAGE);
  else {
    try {
      const result = await runSituationRecallProgrammatic(parseProgrammaticArgs(process.argv.slice(2)));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.exit_code;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
