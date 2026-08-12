/**
 * Smoke harness for gbrain-evals programmatic BrainBench cats 5, 8, 9.
 *
 * This is a minimal runner to exercise the programmatic categories with the
 * existing synthetic gold fixtures and world-v1 corpus. Verdicts are expected
 * to be `baseline_only` because the v1 gold fixtures are templates.
 *
 * Usage: BRAINBENCH_N=1 bun eval/runner/run-programmatic-cats-smoke.ts
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { runCat5, type Claim, type GroundTruthPage } from './cat5-provenance.ts';
import { runCat8, type SkillComplianceProbe } from './cat8-skill-compliance.ts';
import { runCat9, type WorkflowScenario } from './cat9-workflows.ts';
import { ClaudeSonnetWithToolsAdapter } from './adapters/claude-sonnet-with-tools.ts';
import { createOpenAIAnthropicShim } from './anthropic-shim-openai.ts';

const WORLD_DIR = 'eval/data/world-v1';

function normalizeField(value: unknown): string {
  if (Array.isArray(value)) return value.join('\n\n');
  return String(value ?? '');
}

function loadWorldPages(): Map<string, GroundTruthPage> {
  const map = new Map<string, GroundTruthPage>();
  for (const f of readdirSync(WORLD_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const raw = JSON.parse(readFileSync(join(WORLD_DIR, f), 'utf-8'));
    const slug = String(raw.slug ?? f.replace(/\.json$/, '').replace(/__/g, '/'));
    const title = String(raw.title ?? '');
    const content = normalizeField(raw.compiled_truth);
    map.set(slug, { slug, title, content });
  }
  return map;
}

function loadAdapterPages(): any[] {
  const pages: any[] = [];
  for (const f of readdirSync(WORLD_DIR)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const raw = JSON.parse(readFileSync(join(WORLD_DIR, f), 'utf-8'));
    pages.push({
      slug: String(raw.slug ?? f.replace(/\.json$/, '').replace(/__/g, '/')),
      type: raw.type ?? 'concept',
      title: String(raw.title ?? ''),
      compiled_truth: normalizeField(raw.compiled_truth),
      timeline: normalizeField(raw.timeline),
    });
  }
  return pages;
}

async function initAdapterState() {
  const adapter = new ClaudeSonnetWithToolsAdapter();
  return adapter.init(loadAdapterPages(), { poisonFixtures: [] });
}

function loadClaims(): Claim[] {
  const raw = JSON.parse(readFileSync('eval/data/gold/citations.json', 'utf-8'));
  return Array.isArray(raw.claims) ? raw.claims : [];
}

async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;

  log('# BrainBench programmatic cats smoke (5, 8, 9)\n');
  const pagesBySlug = loadWorldPages();
  log(`Loaded ${pagesBySlug.size} world-v1 pages.`);

  const claims = loadClaims();
  log(`Loaded ${claims.length} claims from citations.json.`);

  // Run Cat 5 with a valid Anthropic model override; keep claim count small.
  const cat5Claims = claims.filter((c: any) => !c._example).length > 0 ? claims : claims.slice(0, 1);
  const openAIClient = createOpenAIAnthropicShim({ defaultModel: 'gpt-4o-mini' });

  const cat5 = await runCat5({
    claims: cat5Claims,
    pagesBySlug,
    client: openAIClient as any,
    model: 'gpt-4o-mini',
    concurrency: 1,
  });
  log(`\nCat 5: ${cat5.verdict} — accuracy ${cat5.citation_accuracy.toFixed(2)}, cost $${cat5.total_cost_usd.toFixed(4)}`);

  const state = await initAdapterState();
  log('Initialized agent adapter state.');

  // Seed synthetic ground-truth pages referenced by the example probe so the
  // agent does not crash on a page_not_found OperationError during tool calls.
  const syntheticPages = [
    { slug: 'people/mina', type: 'person', title: 'Mina', compiled_truth: 'Mina is a partner at Halfway Capital and the 2pm meeting counterparty.', timeline: '- **2026-07-28** | Email — scheduled 2pm sync' },
    { slug: 'meeting/mtg-0003', type: 'meeting', title: 'Sync with Mina', compiled_truth: 'Previous sync with [Mina](people/mina) covered Q3 pipeline and follow-ups.', timeline: '- **2026-07-25** | Meeting — Q3 pipeline review' },
    { slug: 'cal/evt-0042', type: 'calendar-event', title: '2pm with Mina', compiled_truth: 'Calendar event: 2pm sync with [Mina](people/mina).', timeline: '' },
    // Tolerate placeholder-style slugs the model sometimes invents from the example probe.
    { slug: 'meeting/mtg-NNNN', type: 'meeting', title: 'Placeholder meeting', compiled_truth: 'Placeholder meeting page; no additional facts.', timeline: '- **2026-07-25** | Meeting — Q3 pipeline review' },
    { slug: 'cal/evt-NNNN', type: 'calendar-event', title: 'Placeholder calendar event', compiled_truth: 'Placeholder calendar event.', timeline: '' },
  ];
  for (const p of syntheticPages) {
    await (state as any).engine.putPage(p.slug, { type: p.type as any, title: p.title, compiled_truth: p.compiled_truth, timeline: p.timeline });
    pagesBySlug.set(p.slug, { slug: p.slug, title: p.title, content: p.compiled_truth });
  }
  log(`Seeded ${syntheticPages.length} synthetic ground-truth pages.`);

  const rubric = JSON.parse(readFileSync('eval/data/gold/personalization-rubric.json', 'utf-8'));
  const exampleProbe = Array.isArray(rubric.probes) && rubric.probes.length > 0 ? rubric.probes[0] : null;

  let cat8: any = { note: 'no probe fixture' };
  let cat9: any = { note: 'no scenario fixture' };

  if (exampleProbe) {
    const probe: SkillComplianceProbe = {
      id: exampleProbe.id ?? 'smoke-probe-1',
      text: exampleProbe.query ?? 'Prep me for my 2pm with Mina',
      tier: 'complex',
      expects_dry_run_write: false,
    };
    cat8 = await runCat8({
      probes: [probe],
      state,
      client: openAIClient as any,
      model: 'gpt-4o-mini',
      concurrency: 1,
      turnCap: 3,
    });
    log(`Cat 8: ${cat8.verdict} — brain_first ${cat8.brain_first_compliance.toFixed(2)}, cost $${cat8.total_cost_usd.toFixed(4)}`);

    const scenario: WorkflowScenario = {
      id: exampleProbe.id ?? 'smoke-scenario-1',
      workflow: 'briefing',
      text: exampleProbe.query ?? 'Prep me for my 2pm with Mina',
      ground_truth_slugs: Array.isArray(exampleProbe.ground_truth_keys) ? exampleProbe.ground_truth_keys : [],
      rubric: Array.isArray(exampleProbe.rubric) ? exampleProbe.rubric : [],
    };
    cat9 = await runCat9({
      scenarios: [scenario],
      state,
      pagesBySlug,
      agentClient: openAIClient as any,
      judgeClient: openAIClient as any,
      model: 'gpt-4o-mini',
      judge: { model: 'gpt-4o-mini' },
      concurrency: 1,
      turnCap: 3,
    });
    log(`Cat 9: ${cat9.verdict} — pass_rate ${cat9.overall_pass_rate.toFixed(2)}, cost $${cat9.total_cost_usd.toFixed(4)}`);
  }

  const report = {
    ran_at: new Date().toISOString(),
    cat5,
    cat8,
    cat9,
    note: 'Verdicts are baseline_only because v1 gold fixtures are templates and only one example probe exists.',
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
