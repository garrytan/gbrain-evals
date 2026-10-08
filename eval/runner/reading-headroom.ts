#!/usr/bin/env bun
/**
 * Reading headroom: a $0, keyless recount over committed W10a and W10b
 * receipts (docs/benchmarks/2026-10-08-reading-headroom.md). Exploratory, not
 * preregistered: it measures how much of what gbrain delivers to the reader is
 * the answer's own sessions, how long a frontier reader's notes are, and how
 * many wrong answers commit to a value.
 *
 *   bun eval/runner/reading-headroom.ts           check: recompute and compare with the committed headroom.json (exit 1 on any difference)
 *   bun eval/runner/reading-headroom.ts --write   (re)write headroom.json
 *
 * Inputs (all committed):
 *   - W10a capture: the 500 reader requests gbrain c5fb0201 built (captures.ndjson.gz) and the harness rows
 *     naming each question's gold sessions and the retrieved session behind each slug (harness-rows.ndjson.gz);
 *   - the W10a Sonnet 5.5 arm and the W10b Opus 5.5, Sonnet 5.5 and gpt-6.1-sol arms (rows.ndjson);
 *   - commitment-labels.json: an agent-written committed/declined label for every answerable question each arm
 *     got wrong.
 *
 * Token units: `chars4` is ceil(characters / 4) per session block, trimmed, the same rule as memory-qa's
 * approxTokens and audit A's recount; `cl100k` is gbrain's cl100k_base count (estimateTokens). Provider tokens are
 * quoted from the receipts' usage.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readNdjson } from './batch/sources.ts';
import { percentile } from './metrics.ts';
import { normalizeUsage, usageSourceOf } from './usage-receipt.ts';
import { cl100kAvailable, estimateTokens } from '../../node_modules/gbrain/src/core/chunkers/token-estimate.ts';

const ROOT = resolve(import.meta.dir, '../..');
const W10A = 'docs/benchmarks/2026-10-07-longmemeval-w10a-current-pin';
const W10B = 'docs/benchmarks/2026-10-07-longmemeval-w10b-reader-replay';
export const OUT_DIR = 'docs/benchmarks/2026-10-08-reading-headroom';
const INPUTS = {
  captures: `${W10A}/capture/captures.ndjson.gz`,
  harness_rows: `${W10A}/capture/harness-rows.ndjson.gz`,
  'w10a-sonnet55-notes': `${W10A}/arms/w10a-sonnet55-notes/rows.ndjson`,
  'w10b-opus55-notes': `${W10B}/arms/w10b-opus55-notes/rows.ndjson`,
  'w10b-sonnet55-notes': `${W10B}/arms/w10b-sonnet55-notes/rows.ndjson`,
  'w10b-sol-notes': `${W10B}/arms/w10b-sol-notes/rows.ndjson`,
  labels: `${OUT_DIR}/commitment-labels.json`,
} as const;
const ARMS = ['w10a-sonnet55-notes', 'w10b-opus55-notes', 'w10b-sonnet55-notes', 'w10b-sol-notes'] as const;

const chars4 = (s: string) => Math.ceil(s.length / 4);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const r1 = (x: number) => Math.round(x * 10) / 10;
const sha256 = (path: string) => createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`reading-headroom: ${detail}`);
}

/** Gold-session share of what the reader received, per question, from the W10a capture. */
function delivered() {
  const rows = readNdjson(join(ROOT, INPUTS.harness_rows)).filter(r => typeof r.question_id === 'string');
  const caps = readNdjson(join(ROOT, INPUTS.captures));
  const byQuestion = new Map(caps.map(c => [c.question as string, c]));
  check(rows.length === 500 && caps.length === 500 && byQuestion.size === 500, 'W10a capture must hold 500 requests with distinct question text');
  const perQuestion = rows.map(r => {
    const cap = byQuestion.get(r.question);
    check(cap, `no capture for ${r.question_id}`);
    const sessionOf = new Map((r.retrieved as { slug: string; session_id: string }[]).map(x => [x.slug.split('/').pop()!, x.session_id]));
    const blocks = [...String(cap.user).matchAll(/<chat_session id="([^"]+)"[^>]*>([\s\S]*?)<\/chat_session>/g)].map(m => ({ gold: (r.answer_session_ids as string[]).includes(sessionOf.get(m[1]) ?? ''), text: m[2].trim() }));
    check(blocks.length === r.reader_context_sessions, `${r.question_id}: ${blocks.length} session blocks, harness says ${r.reader_context_sessions}`);
    const sum = (f: (t: string) => number, gold: boolean) => blocks.filter(b => !gold || b.gold).reduce((s, b) => s + f(b.text), 0);
    return {
      id: r.question_id as string, type: r.question_type as string, gold_missing: (r.gold_found as number) < (r.gold_total as number), gold_none: blocks.every(b => !b.gold),
      delivered_chars4: sum(chars4, false), gold_chars4: sum(chars4, true), delivered_cl100k: sum(estimateTokens, false), gold_cl100k: sum(estimateTokens, true),
    };
  });
  const summarize = (qs: typeof perQuestion) => ({
    n: qs.length,
    mean_delivered_chars4: r1(mean(qs.map(q => q.delivered_chars4))), mean_gold_chars4: r1(mean(qs.map(q => q.gold_chars4))),
    mean_delivered_cl100k: r1(mean(qs.map(q => q.delivered_cl100k))), mean_gold_cl100k: r1(mean(qs.map(q => q.gold_cl100k))),
    gold_share_chars4: Math.round(mean(qs.map(q => q.gold_chars4)) / mean(qs.map(q => q.delivered_chars4)) * 1000) / 1000,
    p95_gold_chars4: r1(percentile(qs.map(q => q.gold_chars4), 95)),
  });
  const types = [...new Set(perQuestion.map(q => q.type))].sort();
  return {
    ...summarize(perQuestion),
    questions_missing_a_gold_session: perQuestion.filter(q => q.gold_missing).length,
    questions_with_no_gold_session_delivered: perQuestion.filter(q => q.gold_none).length,
    by_type: Object.fromEntries(types.map(t => [t, summarize(perQuestion.filter(q => q.type === t))])),
  };
}

type ArmRow = { question_id: string; model: string; hypothesis: string; error: string | null; correct_official: 0 | 1; usage: Record<string, unknown> | null };
const armRows = (arm: typeof ARMS[number]) => readNdjson(join(ROOT, INPUTS[arm])) as ArmRow[];

/** How long each reader's visible notes plus answer run. */
function notesLength() {
  return Object.fromEntries(ARMS.map(arm => {
    const rows = armRows(arm);
    const lens = rows.map(r => chars4(r.hypothesis));
    return [arm, {
      model: rows[0].model, n: rows.length, mean_chars4: r1(mean(lens)), p50_chars4: r1(percentile(lens, 50)), p95_chars4: r1(percentile(lens, 95)),
      mean_cl100k: r1(mean(rows.map(r => estimateTokens(r.hypothesis)))),
      mean_provider_output_tokens: Math.round(mean(rows.map(r => normalizeUsage(usageSourceOf(r.model), r.usage)?.output_total ?? 0))),
    }];
  }));
}

/** Wrong answers that commit to a value, from the agent-written labels; a wrong answer on an unanswerable question committed by definition. */
function commitment() {
  const labels = JSON.parse(readFileSync(join(ROOT, INPUTS.labels), 'utf8')) as { rule: string; labeller: string; arms: Record<string, { model: string; labels: Record<string, 'committed' | 'declined'> }> };
  return {
    rule: labels.rule, labeller: labels.labeller,
    arms: Object.fromEntries(ARMS.map(arm => {
      const rows = armRows(arm);
      check(rows.every(r => !r.error), `${arm}: reader errors are not handled by this recount`);
      const answerable = rows.filter(r => !r.question_id.endsWith('_abs'));
      const abstention = rows.filter(r => r.question_id.endsWith('_abs'));
      const wrong = answerable.filter(r => r.correct_official !== 1).map(r => r.question_id).sort();
      const l = labels.arms[arm];
      check(l && l.model === rows[0].model, `${arm}: labels missing or for another model`);
      check(JSON.stringify(Object.keys(l.labels).sort()) === JSON.stringify(wrong), `${arm}: labels must cover exactly the ${wrong.length} wrong answerable questions`);
      const declined = wrong.filter(id => l.labels[id] === 'declined');
      const abstentionAnswered = abstention.filter(r => r.correct_official !== 1).length;
      const committedWrong = wrong.length - declined.length;
      return [arm, {
        model: rows[0].model, answerable: answerable.length, answerable_correct: answerable.length - wrong.length, answerable_wrong: wrong.length,
        wrong_declined: declined.length, committed_wrong: committedWrong, abstention_questions: abstention.length, abstention_answered: abstentionAnswered,
        committed_wrong_rate_all: Math.round((committedWrong + abstentionAnswered) / rows.length * 1000) / 1000, declined_ids: declined,
      }];
    })),
  };
}

export function headroom(): Record<string, unknown> {
  check(cl100kAvailable(), 'the cl100k encoder (@dqbd/tiktoken via gbrain) did not load; refusing to report heuristic counts as cl100k');
  return {
    kind: 'reading-headroom', schema_version: 1,
    status: 'recount: exploratory, from committed receipts, not preregistered',
    inputs: Object.fromEntries(Object.entries(INPUTS).map(([k, p]) => [k, { path: p, sha256: sha256(p) }])),
    units: { chars4: 'ceil(characters / 4) per trimmed session block or answer', cl100k: 'gbrain estimateTokens (cl100k_base)', percentile: 'linear interpolation (eval/runner/metrics.ts percentile)' },
    delivered: delivered(),
    notes_length: notesLength(),
    commitment: commitment(),
  };
}

if (import.meta.main) {
  const path = join(ROOT, OUT_DIR, 'headroom.json');
  const text = JSON.stringify(headroom(), null, 1) + '\n';
  if (process.argv.includes('--write')) { writeFileSync(path, text); console.log(text); process.exit(0); }
  const committed = existsSync(path) ? readFileSync(path, 'utf8') : '';
  console.log(text);
  if (committed !== text) { console.error(`recount differs from ${path}`); process.exit(1); }
  console.error(`recount matches ${path}`);
}
