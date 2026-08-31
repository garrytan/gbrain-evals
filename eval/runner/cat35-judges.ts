/**
 * BrainBench Cat 35 — batched forced-tool-use judges.
 *
 * Follows the judge.ts idioms exactly:
 *   - forced tool_choice (structured output, no string parsing)
 *   - system prompt sent with cache_control ephemeral (static per judge type;
 *     per-call content goes in the user message so the prefix caches)
 *   - ONE retry on malformed tool_use, then a STRUCTURED failure — these
 *     functions never throw for malformed model output
 *   - injectable `client` for $0 stub-driven tests
 *   - per-call token + cost accounting (haiku-4-5 $1/$5 per M,
 *     sonnet-4-6 $3/$15 per M; unknown models priced at sonnet rates as a
 *     conservative overestimate)
 *
 * NOT judge.ts `scoreAnswer`: that has a 0-5 rubric contract and bypasses the
 * LLM budget. Every real call here is wrapped in
 * `getDefaultLlmBudget().withLlmSlot(...)` (llm-budget.ts).
 *
 * Judge-blindness contract: the coverage judge sees paraphrase-level
 * statements ONLY — never the verbatim anchors — so salience scoring cannot
 * degrade into lexical matching. Mechanical checks (cat35-checks.ts) verify
 * evidence quotes; they are authoritative over judge output.
 *
 * Model resolution precedence: cfg.model > env CAT35_JUDGE_MODEL > default.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDefaultLlmBudget } from './llm-budget.ts';

// ─── Version + pricing ────────────────────────────────────────────────────

/** Pinned prompt version — recorded in the receipt for comparability. */
export const CAT35_JUDGE_PROMPT_VERSION = '2026-08-16-v1';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 2000;

/** $/1M-token rates, matched by model-id substring (2026-08 prices). */
const MODEL_PRICES: Array<{ match: RegExp; inputPerM: number; outputPerM: number }> = [
  { match: /haiku/, inputPerM: 1.0, outputPerM: 5.0 },
  { match: /sonnet/, inputPerM: 3.0, outputPerM: 15.0 },
];

function priceOf(model: string, inputTokens: number, outputTokens: number): number {
  const row = MODEL_PRICES.find((p) => p.match.test(model));
  // Unknown model → sonnet rates (conservative overestimate for budgeting).
  const inputPerM = row?.inputPerM ?? 3.0;
  const outputPerM = row?.outputPerM ?? 15.0;
  return (inputTokens * inputPerM + outputTokens * outputPerM) / 1_000_000;
}

// ─── Config + client ──────────────────────────────────────────────────────

export interface Cat35JudgeCfg {
  model?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client?: any;
  maxTokens?: number;
}

let defaultClient: Anthropic | null = null;
function getDefaultClient(): Anthropic {
  if (!defaultClient) defaultClient = new Anthropic();
  return defaultClient;
}

function resolveModel(cfg?: Cat35JudgeCfg): string {
  return cfg?.model ?? process.env.CAT35_JUDGE_MODEL ?? DEFAULT_MODEL;
}

// ─── Shared call helper ───────────────────────────────────────────────────

interface JudgeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface OneCall {
  input: unknown | null; // parsed tool_use input, or null when malformed
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/** One forced-tool-use call under an LLM-budget slot. Never throws on shape. */
async function callJudgeOnce(
  cfg: Cat35JudgeCfg | undefined,
  systemPrompt: string,
  tool: JudgeTool,
  userContent: string,
): Promise<OneCall> {
  const client = cfg?.client ?? getDefaultClient();
  const model = resolveModel(cfg);
  const maxTokens = cfg?.maxTokens ?? DEFAULT_MAX_TOKENS;
  let response: Anthropic.Messages.Message;
  try {
    response = (await getDefaultLlmBudget().withLlmSlot(() =>
      client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: userContent }],
      }),
    )) as Anthropic.Messages.Message;
  } catch (e) {
    // Transport-level failure (429/529/network). Same contract as malformed
    // output: null input routes the caller into retry-then-judge_failed —
    // a single API blip 25 minutes into a paid run must not crash the run
    // and discard every completed verdict.
    process.stderr.write(
      `[cat35-judges] transport error (attempt counts toward retry): ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { input: null, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  }
  let input: unknown | null = null;
  for (const block of response.content as unknown as Array<Record<string, unknown>>) {
    if (block.type === 'tool_use' && block.name === tool.name) {
      input = block.input ?? null;
      break;
    }
  }
  const usage = (response.usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  const output_tokens = usage.output_tokens ?? 0;
  // Cache tokens are billed separately (creation 1.25x input rate, reads
  // 0.1x) and are NOT included in usage.input_tokens — omitting them
  // systematically under-reports spend across hundreds of judge calls.
  const input_tokens = Math.round(
    (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) * 1.25 +
      (usage.cache_read_input_tokens ?? 0) * 0.1,
  );
  return { input, input_tokens, output_tokens, cost_usd: priceOf(model, input_tokens, output_tokens) };
}

function indent(s: string, prefix: string): string {
  return s.split('\n').map((l) => prefix + l).join('\n');
}

// ═══ 1. Salient-unit coverage ═════════════════════════════════════════════

export interface CoverageVerdict {
  item_id: string;
  status: 'FULL' | 'PARTIAL' | 'ABSENT';
  evidence: string;
}

const COVERAGE_SYSTEM_PROMPT = `You judge whether a distilled knowledge-base document preserves specific salient statements from a source conversation. Each item is a paraphrase-level statement; the document may express it in different words.

Grade every item:
  FULL = the document conveys the statement's full meaning (paraphrase is fine).
  PARTIAL = the document contains a clearly incomplete or hedged version of the statement.
  ABSENT = the statement is not recoverable from the document.

Evidence rules:
  - For FULL or PARTIAL: evidence is REQUIRED — quote up to 200 characters VERBATIM from the document that supports the verdict. Copy exactly; do not paraphrase the evidence.
  - For ABSENT: evidence must be an empty string.

Return exactly one entry per item_id via the score_salient_items tool. No plain text reply.`;

const COVERAGE_TOOL: JudgeTool = {
  name: 'score_salient_items',
  description:
    'Report a FULL / PARTIAL / ABSENT verdict for every salient item, with a verbatim evidence quote (≤200 chars) from the document for FULL/PARTIAL and an empty string for ABSENT.',
  input_schema: {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item_id: { type: 'string' },
            status: { type: 'string', enum: ['FULL', 'PARTIAL', 'ABSENT'] },
            evidence: {
              type: 'string',
              description:
                'Verbatim quote from the document, ≤200 chars. REQUIRED for FULL/PARTIAL; empty string for ABSENT.',
            },
          },
          required: ['item_id', 'status', 'evidence'],
        },
      },
    },
    required: ['items'],
  },
};

function renderCoverageContent(
  document: string,
  items: { item_id: string; statement: string }[],
  retryOfMissing: boolean,
): string {
  const lines: string[] = [];
  if (retryOfMissing) {
    lines.push(
      'Your previous response was missing verdicts for the items below. Grade ONLY these items, one entry per item_id.',
    );
    lines.push('');
  }
  lines.push('<document>');
  lines.push(indent(document, '  '));
  lines.push('</document>');
  lines.push('');
  lines.push('<salient_items>');
  for (const it of items) {
    lines.push(`  - item_id=${it.item_id}: ${JSON.stringify(it.statement)}`);
  }
  lines.push('</salient_items>');
  lines.push('');
  lines.push('Grade every item via the score_salient_items tool. No plain text reply.');
  return lines.join('\n');
}

/** Parse a coverage tool_use input into per-id verdicts. Invalid rows are skipped. */
function parseCoverage(input: unknown, validIds: Set<string>): Map<string, CoverageVerdict> | null {
  if (!input || typeof input !== 'object') return null;
  const items = (input as Record<string, unknown>).items;
  if (!Array.isArray(items)) return null;
  const out = new Map<string, CoverageVerdict>();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.item_id !== 'string' || !validIds.has(r.item_id)) continue;
    if (r.status !== 'FULL' && r.status !== 'PARTIAL' && r.status !== 'ABSENT') continue;
    const evidence = typeof r.evidence === 'string' ? r.evidence.trim().slice(0, 200) : '';
    // The tool schema REQUIRES evidence for FULL/PARTIAL. Enforce it: a
    // credit-bearing verdict with no supporting quote is treated as missing
    // (routes into the missing-id retry, then judge_failed) — a fabricated
    // or empty-evidence FULL must never feed the headline.
    if ((r.status === 'FULL' || r.status === 'PARTIAL') && evidence.length === 0) continue;
    out.set(r.item_id, { item_id: r.item_id, status: r.status, evidence });
  }
  return out;
}

/**
 * Batched salient-unit coverage: ONE call scores all gold items for a
 * (lane, transcript). Judge sees paraphrase statements only — never anchors.
 *
 * Retry budget: at most 2 calls total. Malformed tool_use → one full retry;
 * a well-formed first call with missing item_ids → one retry listing ONLY
 * the missing ids. Anything still missing/malformed after the second call
 * lands in `judge_failed_ids` (structured failure, never a throw).
 */
export async function scoreSalienceCoverage(
  args: {
    lane: string;
    transcript_id: string;
    document: string;
    items: { item_id: string; statement: string }[];
  },
  cfg?: Cat35JudgeCfg,
): Promise<{
  verdicts: CoverageVerdict[];
  judge_failed_ids: string[];
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}> {
  if (args.items.length === 0) {
    return { verdicts: [], judge_failed_ids: [], input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  }
  const allIds = new Set(args.items.map((i) => i.item_id));
  let input_tokens = 0;
  let output_tokens = 0;
  let cost_usd = 0;

  const call1 = await callJudgeOnce(
    cfg,
    COVERAGE_SYSTEM_PROMPT,
    COVERAGE_TOOL,
    renderCoverageContent(args.document, args.items, false),
  );
  input_tokens += call1.input_tokens;
  output_tokens += call1.output_tokens;
  cost_usd += call1.cost_usd;

  const verdictMap = new Map<string, CoverageVerdict>();
  const parsed1 = call1.input === null ? null : parseCoverage(call1.input, allIds);

  if (parsed1 === null) {
    // Malformed → ONE full retry.
    const call2 = await callJudgeOnce(
      cfg,
      COVERAGE_SYSTEM_PROMPT,
      COVERAGE_TOOL,
      renderCoverageContent(args.document, args.items, false),
    );
    input_tokens += call2.input_tokens;
    output_tokens += call2.output_tokens;
    cost_usd += call2.cost_usd;
    const parsed2 = call2.input === null ? null : parseCoverage(call2.input, allIds);
    if (parsed2 !== null) for (const [id, v] of parsed2) verdictMap.set(id, v);
    // Retry budget consumed; whatever is missing now is judge_failed.
  } else {
    for (const [id, v] of parsed1) verdictMap.set(id, v);
    const missing = args.items.filter((i) => !verdictMap.has(i.item_id));
    if (missing.length > 0) {
      // Missing ids → ONE retry listing ONLY the missing items.
      const call2 = await callJudgeOnce(
        cfg,
        COVERAGE_SYSTEM_PROMPT,
        COVERAGE_TOOL,
        renderCoverageContent(args.document, missing, true),
      );
      input_tokens += call2.input_tokens;
      output_tokens += call2.output_tokens;
      cost_usd += call2.cost_usd;
      const parsed2 = call2.input === null ? null : parseCoverage(call2.input, allIds);
      if (parsed2 !== null) {
        for (const [id, v] of parsed2) if (!verdictMap.has(id)) verdictMap.set(id, v);
      }
    }
  }

  const verdicts: CoverageVerdict[] = [];
  const judge_failed_ids: string[] = [];
  for (const it of args.items) {
    const v = verdictMap.get(it.item_id);
    if (v) verdicts.push(v);
    else judge_failed_ids.push(it.item_id);
  }
  return { verdicts, judge_failed_ids, input_tokens, output_tokens, cost_usd };
}

// ═══ 2. Claim grounding (hallucination) ═══════════════════════════════════

const GROUNDING_SYSTEM_PROMPT = `You grade claims extracted from a distilled document against the source transcript.

For every claim, report two booleans:
  verifiable — set false ONLY when the claim is the page's own editorial voice with no factual content to check (e.g. "this idea seems promising", "worth revisiting later"). User-attributed affect or opinion ("the user felt betrayed", "X was frustrated by Y") IS verifiable against the transcript and MUST be graded — invented emotions must not get a pass.
  grounded — true when the transcript supports the claim (paraphrase is fine; the claim does not need to appear verbatim). False when the transcript contradicts the claim or contains nothing that supports it.

For claims with verifiable=false, set grounded=false. Return one entry per claim index via the grade_claims tool. No plain text reply.`;

const GROUNDING_TOOL: JudgeTool = {
  name: 'grade_claims',
  description:
    'For every claim (by index), report whether it is verifiable (not the page\'s own editorial voice) and whether the transcript supports it (paraphrase ok).',
  input_schema: {
    type: 'object' as const,
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            verifiable: { type: 'boolean' },
            grounded: { type: 'boolean' },
          },
          required: ['index', 'verifiable', 'grounded'],
        },
      },
    },
    required: ['claims'],
  },
};

function renderGroundingContent(label: string, claims: string[], transcript: string): string {
  const lines: string[] = [];
  lines.push(`<batch label=${JSON.stringify(label)}>`);
  lines.push('<transcript>');
  lines.push(indent(transcript, '  '));
  lines.push('</transcript>');
  lines.push('');
  lines.push('<claims>');
  for (let i = 0; i < claims.length; i++) {
    lines.push(`  ${i}: ${JSON.stringify(claims[i])}`);
  }
  lines.push('</claims>');
  lines.push('</batch>');
  lines.push('');
  lines.push(
    `Grade all ${claims.length} claims (indexes 0..${claims.length - 1}) via the grade_claims tool. No plain text reply.`,
  );
  return lines.join('\n');
}

/** Complete-or-nothing parse: every index 0..n-1 must be present with booleans. */
function parseGrounding(input: unknown, n: number): Array<{ verifiable: boolean; grounded: boolean }> | null {
  if (!input || typeof input !== 'object') return null;
  const rows = (input as Record<string, unknown>).claims;
  if (!Array.isArray(rows)) return null;
  const byIndex = new Map<number, { verifiable: boolean; grounded: boolean }>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.index !== 'number' || !Number.isInteger(r.index)) continue;
    if (typeof r.verifiable !== 'boolean' || typeof r.grounded !== 'boolean') continue;
    byIndex.set(r.index, { verifiable: r.verifiable, grounded: r.grounded });
  }
  const out: Array<{ verifiable: boolean; grounded: boolean }> = [];
  for (let i = 0; i < n; i++) {
    const row = byIndex.get(i);
    if (!row) return null; // incomplete = malformed (single judge_failed boolean contract)
    out.push(row);
  }
  return out;
}

/**
 * Batched grounding judgment over ALL claims (no sampling). Verifiability
 * triage exempts ONLY the page's own editorial voice; user-attributed affect
 * stays in the denominator. Incomplete/malformed output → one retry → on a
 * second failure returns `judge_failed: true` with empty results (the
 * boolean contract is all-or-nothing per batch).
 */
export async function scoreGrounding(
  args: { label: string; claims: string[]; transcript: string },
  cfg?: Cat35JudgeCfg,
): Promise<{
  results: { claim: string; verifiable: boolean; grounded: boolean }[];
  judge_failed: boolean;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}> {
  if (args.claims.length === 0) {
    return { results: [], judge_failed: false, cost_usd: 0, input_tokens: 0, output_tokens: 0 };
  }
  const userContent = renderGroundingContent(args.label, args.claims, args.transcript);
  let input_tokens = 0;
  let output_tokens = 0;
  let cost_usd = 0;
  let parsed: Array<{ verifiable: boolean; grounded: boolean }> | null = null;

  for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
    const call = await callJudgeOnce(cfg, GROUNDING_SYSTEM_PROMPT, GROUNDING_TOOL, userContent);
    input_tokens += call.input_tokens;
    output_tokens += call.output_tokens;
    cost_usd += call.cost_usd;
    parsed = call.input === null ? null : parseGrounding(call.input, args.claims.length);
  }

  if (parsed === null) {
    return { results: [], judge_failed: true, cost_usd, input_tokens, output_tokens };
  }
  return {
    results: args.claims.map((claim, i) => ({ claim, ...parsed![i] })),
    judge_failed: false,
    cost_usd,
    input_tokens,
    output_tokens,
  };
}

// ═══ 3. Distractor-leak confirmation ══════════════════════════════════════

const LEAK_SYSTEM_PROMPT = `You confirm whether true-but-routine "distractor" content from a conversation was surfaced as SALIENT in a distilled document. Distractor content is factually correct but noise — the question is only how the document presents it.

For each hit:
  surfaced_as_salient = true when the document presents the content as a takeaway, summary point, decision, or highlighted insight.
  surfaced_as_salient = false for a benign passing mention — e.g. it appears only quoted inside a larger verbatim block, or the document explicitly marks it as routine/incidental.

Return one entry per distractor_id via the confirm_leaks tool. No plain text reply.`;

const LEAK_TOOL: JudgeTool = {
  name: 'confirm_leaks',
  description:
    'For every distractor hit, report whether the document surfaces it as salient (takeaway/summary point) vs a benign passing mention.',
  input_schema: {
    type: 'object' as const,
    properties: {
      leaks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            distractor_id: { type: 'string' },
            surfaced_as_salient: { type: 'boolean' },
          },
          required: ['distractor_id', 'surfaced_as_salient'],
        },
      },
    },
    required: ['leaks'],
  },
};

function renderLeakContent(document: string, hits: { distractor_id: string; statement: string }[]): string {
  const lines: string[] = [];
  lines.push('<document>');
  lines.push(indent(document, '  '));
  lines.push('</document>');
  lines.push('');
  lines.push('<distractor_hits>');
  for (const h of hits) {
    lines.push(`  - distractor_id=${h.distractor_id}: ${JSON.stringify(h.statement)}`);
  }
  lines.push('</distractor_hits>');
  lines.push('');
  lines.push('Judge every hit via the confirm_leaks tool. No plain text reply.');
  return lines.join('\n');
}

/** Complete-or-nothing parse keyed by distractor_id. */
function parseLeaks(input: unknown, ids: string[]): Map<string, boolean> | null {
  if (!input || typeof input !== 'object') return null;
  const rows = (input as Record<string, unknown>).leaks;
  if (!Array.isArray(rows)) return null;
  const out = new Map<string, boolean>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.distractor_id !== 'string') continue;
    if (typeof r.surfaced_as_salient !== 'boolean') continue;
    out.set(r.distractor_id, r.surfaced_as_salient);
  }
  for (const id of ids) if (!out.has(id)) return null;
  return out;
}

/**
 * Judge confirmation of mechanical distractor-anchor hits: benign passing
 * mention vs surfaced-as-salient. One retry on malformed/incomplete output,
 * then `judge_failed: true` with no confirmations.
 */
export async function confirmDistractorLeaks(
  args: { document: string; hits: { distractor_id: string; statement: string }[] },
  cfg?: Cat35JudgeCfg,
): Promise<{ confirmed: string[]; judge_failed: boolean; cost_usd: number }> {
  if (args.hits.length === 0) return { confirmed: [], judge_failed: false, cost_usd: 0 };
  const ids = args.hits.map((h) => h.distractor_id);
  const userContent = renderLeakContent(args.document, args.hits);
  let cost_usd = 0;
  let parsed: Map<string, boolean> | null = null;

  for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
    const call = await callJudgeOnce(cfg, LEAK_SYSTEM_PROMPT, LEAK_TOOL, userContent);
    cost_usd += call.cost_usd;
    parsed = call.input === null ? null : parseLeaks(call.input, ids);
  }

  if (parsed === null) return { confirmed: [], judge_failed: true, cost_usd };
  return {
    confirmed: ids.filter((id) => parsed!.get(id) === true),
    judge_failed: false,
    cost_usd,
  };
}

// ═══ 4. Usability checklist ═══════════════════════════════════════════════

export interface UsabilityResult {
  checks: { id: string; pass: boolean }[];
  satisfied: number;
  total: number;
  judge_failed: boolean;
  cost_usd: number;
}

const USABILITY_CHECK_IDS = [
  'self_contained_opening',
  'has_wikilink',
  'states_decisions_with_status',
  'preserves_tenor',
  'no_transcript_dump',
  'coherent_organization',
] as const;

const USABILITY_CHECK_DESCRIPTIONS: Record<string, string> = {
  self_contained_opening:
    'The first paragraph is a 2-3 sentence self-contained opening a stranger could follow without the transcript.',
  has_wikilink: 'At least one page contains a [[wikilink]] or relative markdown link to other brain content.',
  states_decisions_with_status:
    'Decisions appear with their status (decided / proposed / rejected / pending), not as bare facts.',
  preserves_tenor:
    'Where the conversation carried emotional tenor, the pages preserve it rather than flattening it to neutral facts.',
  no_transcript_dump: 'The pages distill; they do not paste large verbatim transcript runs as filler.',
  coherent_organization:
    'Headings, sections, and ordering make the page set readable as standalone notes.',
};

const USABILITY_SYSTEM_PROMPT = `You grade a SET of distilled knowledge-base pages produced from one conversation against a binary usability checklist. Grade the page set as a whole: a check passes when the set, taken together, satisfies it.

Pass/fail every requested check honestly — a page set that dumps the transcript or opens mid-thought fails those checks even if other checks pass. Return one entry per requested check id via the usability_checklist tool. No plain text reply.`;

function buildUsabilityTool(checkIds: string[]): JudgeTool {
  return {
    name: 'usability_checklist',
    description: 'Report a binary pass/fail for every requested usability check id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', enum: checkIds },
              pass: { type: 'boolean' },
            },
            required: ['id', 'pass'],
          },
        },
      },
      required: ['checks'],
    },
  };
}

function renderUsabilityContent(
  transcript_id: string,
  pages: { slug: string; body: string }[],
  checkIds: string[],
): string {
  const lines: string[] = [];
  lines.push(`<page_set transcript_id=${JSON.stringify(transcript_id)}>`);
  for (const p of pages) {
    lines.push(`  <page slug=${JSON.stringify(p.slug)}>`);
    lines.push(indent(p.body, '    '));
    lines.push('  </page>');
  }
  lines.push('</page_set>');
  lines.push('');
  lines.push('<checklist>');
  for (const id of checkIds) {
    lines.push(`  - id=${id}: ${USABILITY_CHECK_DESCRIPTIONS[id]}`);
  }
  lines.push('</checklist>');
  lines.push('');
  lines.push('Grade every check via the usability_checklist tool. No plain text reply.');
  return lines.join('\n');
}

/** Complete-or-nothing parse keyed by check id. */
function parseUsability(input: unknown, checkIds: string[]): Map<string, boolean> | null {
  if (!input || typeof input !== 'object') return null;
  const rows = (input as Record<string, unknown>).checks;
  if (!Array.isArray(rows)) return null;
  const out = new Map<string, boolean>();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !checkIds.includes(r.id)) continue;
    if (typeof r.pass !== 'boolean') continue;
    out.set(r.id, r.pass);
  }
  for (const id of checkIds) if (!out.has(id)) return null;
  return out;
}

/**
 * Binary usability checklist over the page SET (all pages of one transcript
 * in a single prompt). Fixed check ids; `preserves_tenor` is judged only when
 * `hasGoldVibes` — otherwise it auto-passes (present in `checks` with
 * pass=true) and is EXCLUDED from both `satisfied` and `total`, so a
 * vibe-free transcript is scored out of 5, not 6.
 *
 * Empty page set → all applicable checks fail mechanically ($0, no LLM call);
 * usability is conditional on emission and the runner should normally not
 * call this with zero pages.
 *
 * Malformed/incomplete tool output → one retry → structured failure:
 * `judge_failed: true` with all applicable checks fail and satisfied=0.
 */
export async function scoreUsabilityChecklist(
  args: { transcript_id: string; pages: { slug: string; body: string }[]; hasGoldVibes: boolean },
  cfg?: Cat35JudgeCfg,
): Promise<UsabilityResult> {
  const applicable = USABILITY_CHECK_IDS.filter(
    (id) => id !== 'preserves_tenor' || args.hasGoldVibes,
  );
  const tenorAutoPass: { id: string; pass: boolean }[] = args.hasGoldVibes
    ? []
    : [{ id: 'preserves_tenor', pass: true }];

  if (args.pages.length === 0) {
    return {
      checks: [...applicable.map((id) => ({ id, pass: false })), ...tenorAutoPass],
      satisfied: 0,
      total: applicable.length,
      judge_failed: false,
      cost_usd: 0,
    };
  }

  const tool = buildUsabilityTool([...applicable]);
  const userContent = renderUsabilityContent(args.transcript_id, args.pages, [...applicable]);
  let cost_usd = 0;
  let parsed: Map<string, boolean> | null = null;

  for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
    const call = await callJudgeOnce(cfg, USABILITY_SYSTEM_PROMPT, tool, userContent);
    cost_usd += call.cost_usd;
    parsed = call.input === null ? null : parseUsability(call.input, [...applicable]);
  }

  if (parsed === null) {
    return {
      checks: [...applicable.map((id) => ({ id, pass: false })), ...tenorAutoPass],
      satisfied: 0,
      total: applicable.length,
      judge_failed: true,
      cost_usd,
    };
  }

  const judged = applicable.map((id) => ({ id: id as string, pass: parsed!.get(id)! }));
  return {
    checks: [...judged, ...tenorAutoPass],
    satisfied: judged.filter((c) => c.pass).length,
    total: applicable.length,
    judge_failed: false,
    cost_usd,
  };
}
