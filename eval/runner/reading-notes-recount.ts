import { readFileSync } from 'node:fs';

export type Phase = 'transfer' | 'oracle';
const ARMS = {
  transfer: ['baseline', 'notes'],
  oracle: ['nl_direct', 'json_direct', 'nl_notes', 'json_notes'],
} as const;
const COUNTS = { transfer: { pair: 361, baseline_repeat: 12, discordance_rejudge: 28 }, oracle: { pair: 500, baseline_repeat: 12, discordance_rejudge: 59 } };
const CATEGORIES = new Set(['knowledge-update', 'multi-session', 'single-session-assistant', 'single-session-preference', 'single-session-user', 'temporal-reasoning']);
const PIN = '510a3eab1e6f3889b9732755a2c53c724f38745a8fef0744e34216cee78ae398';

type Row = Record<string, unknown>;
function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`reading-notes receipt: ${detail}`);
}
function fields(row: Row, names: string[]) {
  check(Object.keys(row).sort().join(',') === names.sort().join(','), `unexpected/missing fields on ${String(row.record_type)} ${String(row.question_id ?? '')}`);
}
function boolean(row: Row, key: string) {
  check(typeof row[key] === 'boolean', `${key} must be boolean`);
  return row[key] as boolean;
}

export function recount(raw: string, phase: Phase) {
  check(raw.endsWith('\n'), 'incomplete final NDJSON line');
  const lines = raw.slice(0, -1).split('\n');
  const rows = lines.map((line, index): Row => {
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error(`reading-notes receipt: malformed line ${index + 1}`); }
    check(row !== null && typeof row === 'object' && !Array.isArray(row), `invalid line ${index + 1}`);
    return row as Row;
  });
  const header = rows.shift();
  check(header?.record_type === 'manifest', 'missing leading manifest');
  fields(header, ['record_type', 'schema', 'phase', 'manifest_sha256', 'n', 'reader_model', 'judge_model', 'scope', 'cost_usd', 'settled_calls']);
  check(header.schema === 1 && header.phase === phase && header.manifest_sha256 === PIN && header.n === COUNTS[phase].pair, 'manifest identity/count mismatch');
  check(header.reader_model === (phase === 'transfer' ? 'anthropic:claude-sonnet-4-6' : 'gpt-4o-2024-08-06') && header.judge_model === 'gpt-4o-2024-08-06', 'model mismatch');
  check(header.settled_calls === (phase === 'transfer' ? 1524 : 4142) && Math.abs(Number(header.cost_usd) - (phase === 'transfer' ? 36.6096 : 34.5237)) < 1e-9, 'accounting header mismatch');
  const arms: string[] = [...ARMS[phase]];
  const pairs = new Map<string, Row>();
  const repeats = new Map<string, Row>();
  const regrades = new Map<string, Row>();
  for (const row of rows) {
    const kind = row.record_type;
    check(kind === 'pair' || kind === 'baseline_repeat' || kind === 'discordance_rejudge', `unknown record type ${String(kind)}`);
    const id = row.question_id;
    check(typeof id === 'string' && /^[a-z0-9_]+$/.test(id), 'invalid question ID');
    const bucket = kind === 'pair' ? pairs : kind === 'baseline_repeat' ? repeats : regrades;
    check(!bucket.has(id), `duplicate ${kind} ${id}`);
    if (kind === 'pair') {
      fields(row, ['record_type', 'question_id', 'category', 'abstention', ...(phase === 'transfer' ? ['retrieval_complete'] : []), ...arms.flatMap(a => [`${a}_correct`, `${a}_truncated`])]);
      check(CATEGORIES.has(String(row.category)), `unknown category ${id}`);
      check(boolean(row, 'abstention') === id.endsWith('_abs'), `abstention ID mismatch ${id}`);
      if (phase === 'transfer') boolean(row, 'retrieval_complete');
      for (const arm of arms) { boolean(row, `${arm}_correct`); boolean(row, `${arm}_truncated`); }
    } else {
      fields(row, ['record_type', 'question_id', 'baseline_correct', 'candidate_correct', ...(kind === 'baseline_repeat' ? ['text_identical'] : ['baseline_changed', 'candidate_changed'])]);
      boolean(row, 'baseline_correct'); boolean(row, 'candidate_correct');
      if (kind === 'baseline_repeat') boolean(row, 'text_identical');
      else { boolean(row, 'baseline_changed'); boolean(row, 'candidate_changed'); }
    }
    bucket.set(id, row);
  }
  for (const [kind, bucket] of [['pair', pairs], ['baseline_repeat', repeats], ['discordance_rejudge', regrades]] as const) {
    check(bucket.size === COUNTS[phase][kind], `${kind}: expected ${COUNTS[phase][kind]}, found ${bucket.size}`);
  }
  const baseline = phase === 'transfer' ? 'baseline' : 'nl_direct';
  const candidate = phase === 'transfer' ? 'notes' : 'json_notes';
  const discordant = [...pairs.values()].filter(r => r[`${baseline}_correct`] !== r[`${candidate}_correct`]);
  check(discordant.length === regrades.size, 'discordance count mismatch');
  for (const [id, row] of regrades) {
    const pair = pairs.get(id);
    check(pair && pair[`${baseline}_correct`] !== pair[`${candidate}_correct`], `regrade is not a discordant pair: ${id}`);
    check(row.baseline_changed === (row.baseline_correct !== pair[`${baseline}_correct`]) && row.candidate_changed === (row.candidate_correct !== pair[`${candidate}_correct`]), `regrade change flag mismatch ${id}`);
  }
  for (const [id, row] of repeats) {
    const pair = pairs.get(id);
    check(pair && row.baseline_correct === pair[`${baseline}_correct`], `repeat baseline mismatch ${id}`);
  }
  const values = [...pairs.values()];
  const sum = (rows: Row[], key: string) => rows.filter(r => r[key] === true).length;
  const scores = Object.fromEntries(arms.map(a => [a, { correct: sum(values, `${a}_correct`), truncated: sum(values, `${a}_truncated`) }]));
  const contrasts = Object.fromEntries((phase === 'transfer' ? [['baseline', 'notes']] : [['nl_direct', 'nl_notes'], ['json_direct', 'json_notes'], ['nl_direct', 'json_direct'], ['nl_notes', 'json_notes'], ['nl_direct', 'json_notes']]).map(([a, b]) => {
    const wins = values.filter(r => !r[`${a}_correct`] && r[`${b}_correct`]).length;
    const losses = values.filter(r => r[`${a}_correct`] && !r[`${b}_correct`]).length;
    return [`${b}-vs-${a}`, { wins, losses, net: wins - losses, percentage_points: 100 * (wins - losses) / values.length }];
  }));
  return { phase, n: values.length, scores, contrasts,
    abstention: { n: values.filter(r => r.abstention).length, scores: Object.fromEntries(arms.map(a => [a, sum(values.filter(r => r.abstention), `${a}_correct`)])) },
    categories: Object.fromEntries([...CATEGORIES].map(c => [c, { n: values.filter(r => r.category === c).length, scores: Object.fromEntries(arms.map(a => [a, sum(values.filter(r => r.category === c), `${a}_correct`)])) }])),
    ...(phase === 'transfer' ? { retrieval_complete: { n: sum(values, 'retrieval_complete'), baseline: sum(values.filter(r => r.retrieval_complete), 'baseline_correct'), notes: sum(values.filter(r => r.retrieval_complete), 'notes_correct') } } : {}),
    repeats: { n: repeats.size, original_correct: sum([...repeats.values()], 'baseline_correct'), repeated_correct: sum([...repeats.values()], 'candidate_correct'), identical: sum([...repeats.values()], 'text_identical'), identical_grade_flips: [...repeats.values()].filter(r => r.text_identical && r.baseline_correct !== r.candidate_correct).length },
    regrades: { n: regrades.size, changed_labels: sum([...regrades.values()], 'baseline_changed') + sum([...regrades.values()], 'candidate_changed'), wins: [...regrades.values()].filter(r => !r.baseline_correct && r.candidate_correct).length, losses: [...regrades.values()].filter(r => r.baseline_correct && !r.candidate_correct).length },
    accounting: { settled_calls: header.settled_calls, usage_priced_usd: header.cost_usd, provenance: 'aggregate label header only; per-call private ledger is not committed' } };
}

export function recountCost(cost: Row, summaries: Record<Phase, ReturnType<typeof recount>>) {
  check(cost.schema === 1 && Array.isArray(cost.groups) && cost.groups.length === 4, 'cost receipt schema/groups mismatch');
  const expected = [
    ['transfer', 'reader', 'anthropic:claude-sonnet-4-6', 734, 3, 15],
    ['transfer', 'judge', 'openai:gpt-4o', 790, 2.5, 10],
    ['oracle', 'reader', 'openai:gpt-4o', 2012, 2.5, 10],
    ['oracle', 'judge', 'openai:gpt-4o', 2130, 2.5, 10],
  ];
  let followup = 0;
  for (const phase of ['transfer', 'oracle'] as const) {
    let calls = 0; let usd = 0;
    for (const [index, group] of (cost.groups as Row[]).entries()) {
      if (group.phase !== phase) continue;
      fields(group, ['phase', 'role', 'model', 'calls', 'input_tokens', 'output_tokens', 'input_usd_per_million', 'output_usd_per_million']);
      const [p, role, model, count, inputRate, outputRate] = expected[index];
      check(group.phase === p && group.role === role && group.model === model && group.calls === count && group.input_usd_per_million === inputRate && group.output_usd_per_million === outputRate, 'cost model/rate/call mismatch');
      for (const key of ['input_tokens', 'output_tokens']) check(Number.isSafeInteger(group[key]) && Number(group[key]) >= 0, `invalid ${key}`);
      calls += Number(group.calls);
      usd += (Number(group.input_tokens) * Number(inputRate) + Number(group.output_tokens) * Number(outputRate)) / 1e6;
    }
    check(calls === summaries[phase].accounting.settled_calls && Math.abs(usd - Number(summaries[phase].accounting.usage_priced_usd)) < 1e-9, `cost/label mismatch for ${phase}`);
    followup += usd;
  }
  const pilot = cost.previous_failed_excerpt_pilot as Row;
  check(pilot?.settled_calls === 348 && pilot.usage_priced_usd === 8.0127305, 'failed pilot missing/mismatched');
  check(cost.total_settled_calls === 6014 && Math.abs(followup + 8.0127305 - Number(cost.total_usage_priced_usd)) < 1e-9, 'total accounting mismatch');
  return { followup_usage_priced_usd: followup, prior_failed_pilot_usd: 8.0127305, total_usage_priced_usd: cost.total_usage_priced_usd, total_settled_calls: cost.total_settled_calls };
}

if (import.meta.main) {
  const dir = new URL('../../docs/benchmarks/2026-09-25-reading-notes/', import.meta.url);
  const phases: Phase[] = ['transfer', 'oracle'];
  const summaries = Object.fromEntries(phases.map(phase => [phase, recount(readFileSync(new URL(`reading-notes-${phase}.ndjson`, dir), 'utf8'), phase)])) as Record<Phase, ReturnType<typeof recount>>;
  console.log(JSON.stringify({ ...summaries, cost: recountCost(JSON.parse(readFileSync(new URL('cost-provenance.json', dir), 'utf8')), summaries) }, null, 2));
}
