/**
 * Helpers shared by the workload-suite generators: opaque ids, conversation
 * rendering, answer normalization and matching, typed scoring of value and
 * set answers, and bundle serialization with content hashes.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../generators/seeded.ts';
import type { ChatMessage, Gold, HarnessDocument, ScoreResult, SuiteBundle } from './types.ts';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Opaque, stable id: a prefix plus 12 hex characters of a hash over the parts. Carries no role or label. */
export function opaqueId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}-${sha256([prefix, ...parts].join('|')).slice(0, 12)}`;
}

export function renderMessages(messages: readonly ChatMessage[]): string {
  return messages.map(m => `${m.role}: ${m.content}`).join('\n');
}

export function makeDocument(id: string, userId: string, timestamp: string, messages: ChatMessage[], context = 'Conversation between the user and an assistant'): HarnessDocument {
  return { id, content: renderMessages(messages), user_id: userId, timestamp, messages, context };
}

/**
 * Context as a memory would deliver it: one block per document, oldest first,
 * each with a one-line date header. The oracle and full-history stub arms use
 * this rendering.
 */
export function renderContext(docs: readonly HarnessDocument[]): string {
  return [...docs]
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : 1)
    .map(d => `[date: ${d.timestamp.slice(0, 10)}]\n${d.content}`)
    .join('\n\n');
}

/** Split a rendered context back into dated blocks (for stub readers that need order). */
export function contextBlocks(context: string): Array<{ date: string; text: string }> {
  const out: Array<{ date: string; text: string }> = [];
  for (const block of context.split(/\n\n(?=\[date: )/)) {
    const m = /^\[date: (\d{4}-\d{2}-\d{2})\]\n([\s\S]*)$/.exec(block);
    if (m) out.push({ date: m[1]!, text: m[2]! });
    else if (block.trim()) out.push({ date: '', text: block });
  }
  return out;
}

export function norm(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whole-token containment after normalization. */
export function containsValue(text: string, value: string): boolean {
  const v = norm(value);
  return v.length > 0 && ` ${norm(text)} `.includes(` ${v} `);
}

export function countValue(text: string, value: string): number {
  const v = ` ${norm(value)} `;
  const t = ` ${norm(text)} `;
  let n = 0;
  for (let i = t.indexOf(v); i >= 0; i = t.indexOf(v, i + 1)) n++;
  return n;
}

const ABSTAIN = /\b(i don'?t know|do not know|not mentioned|no information|not (?:been )?(?:stated|specified|recorded|provided)|cannot (?:be )?determine|can'?t (?:be )?determine|unknown|no record|none)\b/i;
export const isAbstention = (answer: string) => answer.trim() === '' || ABSTAIN.test(answer);

export const STUB_ABSTAIN = "I don't know";

/**
 * Mark which of `universe` the answer names, longest name first, so a name
 * that is a prefix of another ("Vector" inside "Vector Labs") is not counted
 * when only the longer one is present.
 */
export function namesIn(answer: string, universe: readonly string[]): string[] {
  let text = ` ${norm(answer)} `;
  const found: string[] = [];
  for (const name of [...new Set(universe)].sort((a, b) => norm(b).length - norm(a).length || (a < b ? -1 : 1))) {
    const n = ` ${norm(name)} `;
    if (n.trim() && text.includes(n)) {
      found.push(name);
      text = text.split(n).join(' ');
    }
  }
  return found.sort();
}

/** Score a value or set answer against typed gold. Change and verdict gold are scored by their suites. */
export function scoreGold(gold: Gold, answer: string, distractorValues: readonly string[] = []): ScoreResult {
  switch (gold.kind) {
    case 'value': {
      const hit = containsValue(answer, gold.value);
      const stale = (gold.stale ?? []).filter(v => containsValue(answer, v));
      const wrong = distractorValues.filter(v => v !== gold.value && containsValue(answer, v));
      if (hit && stale.length) return { outcome: 'ambiguous', matched: [gold.value, ...stale] };
      if (hit && wrong.length) return { outcome: 'ambiguous', matched: [gold.value, ...wrong] };
      if (hit) return { outcome: 'correct', matched: [gold.value] };
      if (stale.length) return { outcome: 'stale', matched: stale };
      if (wrong.length) return { outcome: 'distractor', matched: wrong };
      return { outcome: isAbstention(answer) ? 'abstain' : 'wrong', matched: [] };
    }
    case 'set': {
      const named = namesIn(answer, gold.universe);
      const want = new Set(gold.values);
      const missing = gold.values.filter(v => !named.includes(v));
      const extra = named.filter(v => !want.has(v));
      if (!missing.length && !extra.length) return { outcome: 'correct', matched: named };
      // Every gold name plus others: readers often name the people who disagree, which only the judge can read.
      if (!missing.length) return { outcome: 'ambiguous', matched: named };
      if (!named.length) return { outcome: isAbstention(answer) ? 'abstain' : 'wrong', matched: [] };
      return { outcome: extra.length && extra.some(v => distractorValues.includes(v)) ? 'distractor' : 'wrong', matched: named };
    }
    case 'none': {
      return { outcome: isAbstention(answer) ? 'correct' : 'wrong', matched: [] };
    }
    default:
      throw new Error(`scoreGold: ${gold.kind} gold is scored by its suite`);
  }
}

// ─── Dates ────────────────────────────────────────────────────────────────

export function isoAt(day: string, minuteOfDay: number): string {
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return `${day}T${hh}:${mm}:00Z`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "14 March 2027": no comma, so a statement value never contains a clause terminator. */
export function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m! - 1]} ${y}`;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex for a statement template with `{V}` as the captured value and other
 * `{slot}` markers bound by `bind`. The template's final period is optional
 * (asides may end the sentence differently); the match must end at a clause
 * terminator, and values never contain one.
 */
export function statementRegex(template: string, bind: Record<string, string>): RegExp {
  let src = '';
  for (const part of template.replace(/\.$/, '').split(/(\{[A-Za-z]+\})/)) {
    if (part === '{V}') src += '([^.,;!?\\n]+?)';
    else if (/^\{[A-Za-z]+\}$/.test(part)) {
      const key = part.slice(1, -1);
      if (!(key in bind)) throw new Error(`statementRegex: unbound slot ${part} in ${template}`);
      src += escapeRegex(bind[key]!);
    } else src += escapeRegex(part);
  }
  return new RegExp(`${src}(?=[.,;!?\\n]|$)`, 'gi');
}

export function fill(template: string, bind: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, k: string) => {
    if (!(k in bind)) throw new Error(`fill: unbound slot {${k}} in ${template}`);
    return bind[k]!;
  });
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ─── Serialization ─────────────────────────────────────────────────────────

const jsonl = (rows: readonly unknown[]) => rows.map(r => canonical(r)).join('\n') + (rows.length ? '\n' : '');

/** Every file of a bundle, as exact bytes, keyed by file name. */
export function bundleFiles(bundle: SuiteBundle): Record<string, string> {
  const files: Record<string, string> = {
    'documents.jsonl': jsonl(bundle.documents),
    'queries.jsonl': jsonl(bundle.queries),
    'scorer-labels.jsonl': jsonl(bundle.labels),
  };
  for (const [name, value] of Object.entries(bundle.extra)) {
    files[Array.isArray(value) ? `${name}.jsonl` : `${name}.json`] = Array.isArray(value) ? jsonl(value) : canonical(value) + '\n';
  }
  return files;
}

export interface BundleManifest {
  suite: string;
  version: string;
  seed: number;
  smoke: boolean;
  counts: { documents: number; queries: number; labels: number; users: number; by_category: Record<string, number> };
  /** Approximate tokens (characters / 4) of all document content. */
  approx_tokens: { total: number; per_user_max: number; per_user_mean: number };
  timestamp_provenance: string;
  files: Record<string, { sha256: string; bytes: number }>;
  digest: string;
  command: string;
}

export function bundleManifest(bundle: SuiteBundle, files = bundleFiles(bundle)): BundleManifest {
  const fileHashes: BundleManifest['files'] = {};
  for (const name of Object.keys(files).sort()) fileHashes[name] = { sha256: sha256(files[name]!), bytes: Buffer.byteLength(files[name]!) };
  const perUser = new Map<string, number>();
  for (const d of bundle.documents) perUser.set(d.user_id, (perUser.get(d.user_id) ?? 0) + Math.ceil(d.content.length / 4));
  const byCategory: Record<string, number> = {};
  for (const q of bundle.queries) byCategory[q.meta.category] = (byCategory[q.meta.category] ?? 0) + 1;
  const totals = [...perUser.values()];
  const total = totals.reduce((a, b) => a + b, 0);
  return {
    suite: bundle.suite,
    version: bundle.version,
    seed: bundle.seed,
    smoke: bundle.smoke,
    counts: {
      documents: bundle.documents.length,
      queries: bundle.queries.length,
      labels: bundle.labels.length,
      users: perUser.size,
      by_category: Object.fromEntries(Object.entries(byCategory).sort()),
    },
    approx_tokens: { total, per_user_max: Math.max(0, ...totals), per_user_mean: totals.length ? Math.round(total / totals.length) : 0 },
    timestamp_provenance: bundle.timestamp_provenance,
    files: fileHashes,
    digest: sha256(Object.entries(fileHashes).map(([k, v]) => `${k}:${v.sha256}`).join('\n')),
    command: `bun run eval:${bundle.suite} --seed ${bundle.seed}${bundle.smoke ? ' --smoke' : ''}`,
  };
}

export function writeBundle(dir: string, bundle: SuiteBundle): BundleManifest {
  mkdirSync(dir, { recursive: true });
  const files = bundleFiles(bundle);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const manifest = bundleManifest(bundle, files);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
