#!/usr/bin/env bun
/**
 * The descriptive rows of the LongMemEval run on Redis's open harness that `lme-redis-report.ts final` doesn't print
 * (docs/benchmarks/2026-11-20-longmemeval-redis-harness-preregistration.md, "Descriptive" and "Metrics and
 * denominators"): agent-default against off, reader against reader, per-type accuracy, judge agreement per arm,
 * turn-level delivery, reader tokens, and how often autocut cut. It reads only committed files and calls nothing.
 *
 *   bun eval/runner/batch/lme-redis-extras.ts --dir docs/benchmarks/2026-11-20-longmemeval-redis-harness
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SDD_Z, accuracy, compare, mcnemar, pairedDiff, taskAveraged, wilson, type ScoredRow } from './lme-redis-report.ts';
import type { AnyReader, Memories } from './lme-redis.ts';

interface Delivery { evidence_turns: number; delivered: number; all_delivered: boolean; partial: number; split_rule: number | null; conversation_level: number | null }
interface Query { order: number[]; degraded: string[] }
interface Retrieval { question_id: string; queries: Record<'off' | 'on' | 'agent-default', Query> }
interface Tokens { arm: string; question_id: string; input_tokens: number | null; output_tokens: number | null; finish: string | null }

const READER_ARMS: [AnyReader, Memories[]][] = [
  ['opus', ['off', 'on', 'full', 'oracle']], ['sol', ['off', 'on', 'full', 'oracle']], ['particle', ['off', 'on', 'full', 'oracle']],
  ['gpt4o', ['off', 'on', 'agent-default', 'full', 'oracle']],
];
const TRUNCATED = new Set(['length', 'max_tokens']);

function lines<T>(path: string): T[] {
  const raw = path.endsWith('.gz') ? new TextDecoder().decode(Bun.gunzipSync(readFileSync(path))) : readFileSync(path, 'utf8');
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T);
}

const verdict = (v: 0 | 1 | -1 | null): v is 0 | 1 => v === 0 || v === 1;
const distinct = (order: number[]) => [...new Set(order)].slice(0, 5);

export function extras(input: { rows: ScoredRow[]; order: string[]; retrieval: Retrieval[]; pilotRetrieval: Retrieval[]; tokens: Tokens[] }) {
  const { rows, order, retrieval, pilotRetrieval, tokens } = input;
  const firstHalf = new Set(order.slice(0, order.length / 2));
  const counted = (reader: AnyReader, m: Memories) => rows.filter(r => r.reader === reader && r.memories === m && (m !== 'on' || firstHalf.has(r.question_id)));

  const agentDefault = compare(rows, 'gpt4o', 'off', 'agent-default');
  const sdd = (d: number | null, n: number) => (d === null ? null : 100 * SDD_Z * Math.sqrt(d / n));

  const readerPair = (a: AnyReader, b: AnyReader, judge: 'protocol' | 'cross') => {
    const x = new Map(counted(a, 'off').map(r => [r.question_id, r[judge]]));
    const y = new Map(counted(b, 'off').map(r => [r.question_id, r[judge]]));
    const qs = [...x.keys()].filter(q => verdict(x.get(q)!) && verdict(y.get(q) ?? null));
    const xs = qs.map(q => x.get(q) as 0 | 1);
    const ys = qs.map(q => y.get(q) as 0 | 1);
    return { first: a, second: b, judge, ...mcnemar(xs, ys), ...pairedDiff(xs, ys) };
  };

  const cells = READER_ARMS.flatMap(([reader, arms]) => arms.map(m => {
    const c = counted(reader, m);
    const both = c.filter(r => verdict(r.protocol) && verdict(r.cross));
    const disagree = both.filter(r => r.protocol !== r.cross).length;
    const sent = new Map(tokens.filter(t => t.arm === `${reader}--${m}`).map(t => [t.question_id, t]));
    const source = new Map(tokens.filter(t => t.arm === `${reader}--off`).map(t => [t.question_id, t]));
    const perQuestion = c.map(r => (r.answered_by === m ? sent : source).get(r.question_id)).filter((t): t is Tokens => !!t && t.input_tokens !== null);
    const byType = [...new Set(c.map(r => r.question_type))].sort().map(type => {
      const t = c.filter(r => r.question_type === type);
      const k = t.filter(r => r.cross === 1).length;
      return { type, correct: k, of: t.length, accuracy: k / t.length, wilson95: wilson(k, t.length), protocol_correct: t.filter(r => r.protocol === 1).length };
    });
    return {
      reader, memories: m, questions: c.length,
      requests_sent: sent.size, answers_reused_from_off: c.filter(r => r.answered_by !== m).length,
      truncated: [...sent.values()].filter(t => t.finish !== null && TRUNCATED.has(t.finish)).length,
      cross_unparsable: c.filter(r => r.cross === -1).length, protocol_unparsable: c.filter(r => r.protocol === -1).length,
      unjudged: c.filter(r => r.cross === null || r.protocol === null).length,
      judges_disagree: disagree, judged_by_both: both.length, disagreement: both.length ? disagree / both.length : null, disagreement_wilson95: wilson(disagree, both.length),
      mean_input_tokens: perQuestion.length ? perQuestion.reduce((s, t) => s + t.input_tokens!, 0) / perQuestion.length : null,
      mean_output_tokens: perQuestion.length ? perQuestion.reduce((s, t) => s + (t.output_tokens ?? 0), 0) / perQuestion.length : null,
      cross: accuracy(rows, reader, m, 'cross', m === 'on' ? firstHalf : undefined),
      task_averaged_protocol: taskAveraged(c.map(r => ({ question_type: r.question_type, verdict: r.protocol }))),
      by_type: byType,
    };
  }));
  const pooledDisagree = cells.reduce((s, c) => s + c.judges_disagree, 0);
  const pooledBoth = cells.reduce((s, c) => s + c.judged_by_both, 0);
  const pooled = pooledDisagree / pooledBoth;

  const deliveryOf = (m: Memories, ids?: Set<string>) => {
    const d = rows.filter(r => r.reader === 'gpt4o' && r.memories === m && (!ids || ids.has(r.question_id))).map(r => r.delivery as Delivery);
    const answerable = d.filter(x => x.evidence_turns > 0);
    return {
      memories: m, questions: d.length, no_evidence_turns: d.length - answerable.length,
      all_delivered: answerable.filter(x => x.all_delivered).length,
      some_turn_missing: answerable.filter(x => !x.all_delivered).length,
      evidence_turns: answerable.reduce((s, x) => s + x.evidence_turns, 0), turns_delivered: answerable.reduce((s, x) => s + x.delivered, 0),
      partial_turns: d.reduce((s, x) => s + x.partial, 0), split_rule_used: d.reduce((s, x) => s + (x.split_rule ?? 0), 0),
      conversation_level_disagrees: d.filter(x => x.conversation_level !== null && x.conversation_level !== x.delivered).length,
    };
  };
  const sameContextAcrossReaders = (['off', 'on', 'full', 'oracle'] as Memories[]).every(m => {
    const by = new Map(rows.filter(r => r.reader === 'gpt4o' && r.memories === m).map(r => [r.question_id, r.context_sha256]));
    return rows.filter(r => r.memories === m).every(r => by.get(r.question_id) === r.context_sha256);
  });

  const pilot = new Map(pilotRetrieval.map(r => [r.question_id, r]));
  const sameAsPilot = (arm: 'off' | 'on' | 'agent-default') => retrieval.filter(r => pilot.has(r.question_id) && JSON.stringify(distinct(r.queries[arm].order)) === JSON.stringify(distinct(pilot.get(r.question_id)!.queries[arm].order))).length;
  const onKept = (ids: Set<string>) => retrieval.filter(r => ids.has(r.question_id)).map(r => distinct(r.queries.on.order).length);
  const all = new Set(order);

  return {
    agent_default_vs_off: { ...agentDefault, smallest_detectable_difference: sdd(agentDefault.discordance, agentDefault.scored) },
    on_smallest_detectable_differences_at_250: (['opus', 'sol', 'gpt4o', 'particle'] as AnyReader[]).map(r => {
      const c = compare(rows, r, 'off', 'on', firstHalf);
      return { reader: r, n: c.scored, discordance: c.discordance, smallest_detectable_difference: sdd(c.discordance, c.scored) };
    }),
    secondary_smallest_detectable_differences: (['opus', 'sol', 'gpt4o', 'particle'] as AnyReader[]).flatMap(r => ([['off', 'full'], ['oracle', 'off']] as [Memories, Memories][]).map(([a, b]) => {
      const c = compare(rows, r, a, b);
      return { reader: r, first: a, second: b, n: c.scored, discordance: c.discordance, smallest_detectable_difference: sdd(c.discordance, c.scored) };
    })),
    reader_vs_reader: [readerPair('opus', 'gpt4o', 'protocol'), readerPair('sol', 'gpt4o', 'protocol'), readerPair('opus', 'gpt4o', 'cross'), readerPair('sol', 'gpt4o', 'cross'), readerPair('opus', 'particle', 'protocol'), readerPair('opus', 'particle', 'cross')],
    judges: { pooled_disagreement: pooled, pooled_disagree: pooledDisagree, pooled_judged_by_both: pooledBoth, arms_above_twice_pooled: cells.filter(c => (c.disagreement ?? 0) > 2 * pooled).map(c => `${c.reader}--${c.memories}`) },
    delivery: { same_context_across_readers: sameContextAcrossReaders, arms: [deliveryOf('off'), deliveryOf('on', firstHalf), deliveryOf('off', firstHalf), deliveryOf('agent-default'), deliveryOf('full'), deliveryOf('oracle')] },
    autocut: {
      contexts_differ_off_on: retrieval.filter(r => JSON.stringify(distinct(r.queries.off.order)) !== JSON.stringify(distinct(r.queries.on.order))).length,
      on_below_5_conversations_first_half: onKept(firstHalf).filter(n => n < 5).length,
      on_below_5_conversations_all: onKept(all).filter(n => n < 5).length,
      on_conversations_histogram_first_half: Object.fromEntries([1, 2, 3, 4, 5].map(n => [n, onKept(firstHalf).filter(k => k === n).length])),
      on_prefix_of_off: retrieval.filter(r => r.queries.on.order.every((c, i) => r.queries.off.order[i] === c)).length,
      degraded_queries: retrieval.filter(r => Object.values(r.queries).some(q => q.degraded.length)).length,
      same_as_pilot_freeze: { questions: retrieval.filter(r => pilot.has(r.question_id)).length, off: sameAsPilot('off'), on: sameAsPilot('on'), 'agent-default': sameAsPilot('agent-default') },
    },
    cells,
  };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 ? process.argv[i + 1] : 'docs/benchmarks/2026-11-20-longmemeval-redis-harness';
  const out = extras({
    rows: lines<ScoredRow>(join(dir, 'rows.ndjson.gz')),
    order: JSON.parse(readFileSync(join(dir, 'order.json'), 'utf8')) as string[],
    retrieval: lines<Retrieval>(join(dir, 'retrieval.jsonl.gz')),
    pilotRetrieval: lines<Retrieval>(join(dir, 'pilot-retrieval.jsonl.gz')),
    tokens: lines<Tokens>(join(dir, 'reader-tokens.ndjson.gz')),
  });
  writeFileSync(join(dir, 'extras.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ ...out, cells: undefined }, null, 1));
}
