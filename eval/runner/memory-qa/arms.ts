/**
 * Multi-arm memory-qa: one ingest, many arms (`--arms <file.json>`).
 *
 * A counted cell ingests each namespace once, retrieves once per question
 * and retrieval policy, then derives every arm from that state:
 *
 *   arm = retrieval policy x context mode (native | rehydrated) x reader
 *
 * with the policy's token budget (`budget_tokens`, null for the system's own
 * amount). Each arm keeps its own canonical row set under
 * `arms/<arm id>/` (manifest, attempts, rows, outcomes, receipt), shaped like
 * a single-arm run, so pairing reads it unchanged. A reader may run on a
 * slice of the questions (the D2 frontier readers): a deterministic,
 * category-stratified subset chosen like `--limit`/`--seed`.
 *
 * Frozen state shared by the arms:
 *   retrievals/      one canonical retrieval row per (question, policy):
 *                    items, recall, latency, provider meter;
 *   contexts.ndjson  the exact reader prompt per (question, policy, context,
 *                    budget), written once and replayed byte for byte.
 *
 * Adding a reader to the arms file and running again replays the frozen
 * contexts: no namespace is ingested and no retrieval repeats.
 *
 *   { "policies": { "vendor-default": { "budget_tokens": null }, "fixed-evidence": { "budget_tokens": 8000 } },
 *     "contexts": ["native", "rehydrated"],
 *     "readers": [ { "id": "gpt-4o", "model": "openai:gpt-4o-2024-08-06" },
 *                  { "id": "opus", "model": "anthropic:claude-opus-5-5", "slice": { "limit": 100, "seed": 11 } } ],
 *     "judge": "openai:gpt-4o-2024-08-06" }
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { C1_HEADER_PREFIX, DATED_RENDERER_VERSION, RENDERER_VERSION, type RecipeRender } from '../systems/render.ts';
import type { RetrievalPolicy } from '../systems/types.ts';

export type PolicyMode = RetrievalPolicy['mode'];

/**
 * A named recipe (budgeted delivery plan C0, "Replay identity keys"): which
 * items a context reads, how they are rendered, and any selection transform.
 *
 *   items        `retrieved` (the retrieval's items) or a delivery variant the
 *                system recorded in the row's accounting (`deliveries.<name>`);
 *   render       native | native-dated | pseudo-session | rehydrated;
 *   select_from  render exactly the items another context packed (the undated
 *                twin; the same blocks under another renderer);
 *   reuse_from   a context whose scored row is copied when this recipe's
 *                prompt hash equals that context's for the question and the
 *                reader and judge match (marked `reused_from`).
 */
export interface RecipeSpec { items: 'retrieved' | string; render: RecipeRender; select_from?: string; reuse_from?: string }

export interface ArmsSpec {
  policies: Partial<Record<PolicyMode, { budget_tokens: number | null }>>;
  /** `native`, `rehydrated`, or the name of a recipe in `recipes`. */
  contexts: string[];
  recipes?: Record<string, RecipeSpec>;
  readers: Array<{ id: string; model: string; slice?: { limit: number; seed: number }; policies?: PolicyMode[]; contexts?: string[] }>;
  judge?: string;
}

export interface Arm {
  id: string;
  policy: PolicyMode;
  context: string | null;
  /** The recipe identity (hash) when the context is a named recipe. */
  recipe?: { name: string; hash: string } | null;
  budget_tokens: number | null;
  reader: { id: string; model: string; slice: { limit: number; seed: number } | null } | null;
}

const ID = /^[A-Za-z0-9._-]{1,40}$/;

export function parseArms(text: string, source = 'arms file'): ArmsSpec {
  const spec = JSON.parse(text) as ArmsSpec;
  const problems: string[] = [];
  const modes = Object.keys(spec.policies ?? {});
  if (!modes.length || modes.some(m => m !== 'vendor-default' && m !== 'fixed-evidence')) problems.push('policies must name vendor-default and/or fixed-evidence');
  for (const [m, p] of Object.entries(spec.policies ?? {})) if (p?.budget_tokens !== null && !(Number.isInteger(p?.budget_tokens) && (p!.budget_tokens as number) > 0)) problems.push(`policies.${m}.budget_tokens must be a positive integer or null`);
  spec.contexts ??= [];
  spec.readers ??= [];
  const recipes = spec.recipes ?? {};
  const RENDERS: RecipeRender[] = ['native', 'native-dated', 'pseudo-session', 'rehydrated'];
  for (const [name, r] of Object.entries(recipes)) {
    if (!ID.test(name) || name === 'native' || name === 'rehydrated') problems.push(`recipe name ${JSON.stringify(name)} must be 1-40 characters of [A-Za-z0-9._-] and not native or rehydrated`);
    if (!RENDERS.includes(r?.render)) problems.push(`recipe ${name}: render must be one of ${RENDERS.join(', ')}`);
    if (typeof r?.items !== 'string' || !(r.items === 'retrieved' || /^[A-Za-z0-9._-]{1,40}$/.test(r.items))) problems.push(`recipe ${name}: items must be retrieved or a delivery variant name`);
    for (const k of ['select_from', 'reuse_from'] as const) if (r?.[k] !== undefined && !(r[k] === 'native' || r[k] === 'rehydrated' || (r[k]! in recipes && r[k] !== name))) problems.push(`recipe ${name}: ${k} must name another context`);
  }
  if (spec.contexts.some(c => c !== 'native' && c !== 'rehydrated' && !(c in recipes))) problems.push('contexts must be native, rehydrated or a recipe the file defines');
  for (const c of spec.contexts) for (const k of ['select_from', 'reuse_from'] as const) {
    const dep = recipes[c]?.[k];
    if (dep && spec.contexts.indexOf(dep) > spec.contexts.indexOf(c)) problems.push(`context ${c}: ${k} ${dep} must be listed before it`);
    if (dep && !spec.contexts.includes(dep)) problems.push(`context ${c}: ${k} ${dep} must be listed in contexts`);
  }
  if (spec.readers.length && !spec.contexts.length) problems.push('readers need at least one context');
  const ids = new Set<string>();
  for (const r of spec.readers) {
    if (!ID.test(r.id ?? '') || ids.has(r.id)) problems.push(`reader id ${JSON.stringify(r.id)} must be unique, 1-40 characters of [A-Za-z0-9._-]`);
    ids.add(r.id);
    if (typeof r.model !== 'string' || !r.model) problems.push(`reader ${r.id}: model is required`);
    if (r.slice && !(Number.isInteger(r.slice.limit) && r.slice.limit > 0 && Number.isInteger(r.slice.seed))) problems.push(`reader ${r.id}: slice needs an integer limit and seed`);
    if (r.policies && (!r.policies.length || r.policies.some(m => !modes.includes(m)))) problems.push(`reader ${r.id}: policies must name policies the file defines`);
    if (r.contexts && (!r.contexts.length || r.contexts.some(c => !spec.contexts.includes(c)))) problems.push(`reader ${r.id}: contexts must name contexts the file lists`);
  }
  if (problems.length) throw new Error(`${source}: ${problems.join('; ')}`);
  return spec;
}

export const loadArms = (path: string) => parseArms(readFileSync(path, 'utf8'), path);

/** Every arm of the matrix; with no readers, one retrieval-only arm per policy. */
export function expandArms(spec: ArmsSpec): Arm[] {
  const out: Arm[] = [];
  for (const policy of Object.keys(spec.policies).sort() as PolicyMode[]) {
    const budget = spec.policies[policy]!.budget_tokens;
    if (!spec.readers.length) { out.push({ id: `${policy}.retrieval`, policy, context: null, budget_tokens: budget, reader: null }); continue; }
    for (const context of spec.contexts) for (const r of spec.readers) {
      if (r.policies && !r.policies.includes(policy)) continue;
      if ((r as { contexts?: string[] }).contexts && !(r as { contexts?: string[] }).contexts!.includes(context)) continue;
      const recipe = spec.recipes?.[context] ? { name: context, hash: recipeHash(context, spec) } : null;
      out.push({ id: `${policy}.${context}.b${budget ?? 'none'}.${r.id}`, policy, context, budget_tokens: budget, reader: { id: r.id, model: r.model, slice: r.slice ?? null }, ...(recipe ? { recipe } : {}) });
    }
  }
  return out;
}

/**
 * A recipe's immutable identity: its spec, the renderer and header versions,
 * and (recursively) the identity of any context it selects from or reuses.
 * The shootout's `native` and `rehydrated` contexts keep their old keys.
 */
export function recipeHash(name: string, spec: Pick<ArmsSpec, 'recipes'>, seen: string[] = []): string {
  const r = spec.recipes?.[name];
  if (!r) return `${name}:${RENDERER_VERSION}`;
  if (seen.includes(name)) throw new Error(`recipe ${name} selects from itself`);
  const dep = (k: 'select_from' | 'reuse_from') => r[k] ? recipeHash(r[k]!, spec, [...seen, name]) : null;
  return createHash('sha256').update(JSON.stringify({ format: 'recipe-v1', name, items: r.items, render: r.render, renderer: r.render === 'native' || r.render === 'rehydrated' ? RENDERER_VERSION : DATED_RENDERER_VERSION,
    header: C1_HEADER_PREFIX, select_from: dep('select_from'), reuse_from: dep('reuse_from') })).digest('hex');
}

/** The arm's definition hash: changes to one arm never invalidate another arm's rows. */
export const armHash = (runHash: string, arm: Arm, judge: string, runs: number) =>
  createHash('sha256').update(JSON.stringify({ runHash, policy: arm.policy, context: arm.context, budget: arm.budget_tokens, reader: arm.reader, judge, runs, ...(arm.recipe ? { recipe: arm.recipe.hash } : {}) })).digest('hex');

/** A frozen prompt's key; a recipe context's key carries its recipe hash, so a changed recipe never replays an old prompt. */
export const contextKey = (questionId: string, policy: PolicyMode, context: string, budget: number | null, recipe: string | null = null) =>
  `${questionId}|${policy}|${recipe ? `${context}@${recipe.slice(0, 16)}` : context}|${budget ?? 'none'}`;

export interface FrozenContext { key: string; prompt_sha256: string; prompt: string; meta: Record<string, unknown> }

/** The frozen reader prompts of a cell: read once, appended when a new one is packed, never rewritten. */
export class ContextStore {
  private map = new Map<string, FrozenContext>();
  constructor(private path: string) {
    if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split('\n')) if (line.trim()) { const c = JSON.parse(line) as FrozenContext; this.map.set(c.key, c); }
  }
  get(key: string) { return this.map.get(key); }
  put(c: FrozenContext) {
    if (this.map.has(c.key)) return this.map.get(c.key)!;
    if (createHash('sha256').update(c.prompt).digest('hex') !== c.prompt_sha256) throw new Error(`context ${c.key}: prompt hash mismatch`);
    appendFileSync(this.path, JSON.stringify(c) + '\n');
    this.map.set(c.key, c);
    return c;
  }
  get size() { return this.map.size; }
}

export const retrievalKey = (questionId: string, policy: PolicyMode) => `${questionId}|${policy}`;
export const armsDir = (output: string, arm: Arm) => join(output, 'arms', arm.id);
export const retrievalsDir = (output: string) => join(output, 'retrievals');
