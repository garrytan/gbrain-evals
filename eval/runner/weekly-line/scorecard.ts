/**
 * The weekly line's Markdown, rendered only from aggregates that pass the allow-list (aggregates.ts), so nothing reaches
 * a page that could not leave custody: the weekly scorecard for the crew's drive (each comparison's weekly point with
 * intervals and no verdict word, row scores, the rolling display and its builds, the regression flag and cost per
 * correct answer) and a block's page section (each comparison's word in the outcome table's wording with the release set,
 * both readers' rows, the look, the grep agent's stops, cost per correct answer and the per-kind rows).
 */
import { assertAggregate, type BlockAggregates, type WeekAggregates } from './aggregates.ts';
import { WL_CLASS_KEYS, WL_CLASSES, WL_COMPARISONS, WL_READER_KEYS, WL_ROW_NAMES, WL_ROWS, type WlClass, type WlOther, type WlReaderKey } from './design.ts';

type Est = { worlds: number; mean: number | null; ci95: [number, number] | null };
const pts = (x: number | null) => { if (x === null) return 'n/a'; const r = Number(x.toFixed(1)); return r === 0 ? '0.0' : `${r > 0 ? '+' : ''}${r.toFixed(1)}`; };
const abs = (x: number) => Math.abs(x).toFixed(1);
const ci = (c: [number, number] | null) => (c ? `95% interval ${pts(c[0])} to ${pts(c[1])}` : 'no interval');
const cell = (e: Est) => (e.mean === null ? 'n/a' : `${pts(e.mean)} (${e.ci95 ? `${pts(e.ci95[0])} to ${pts(e.ci95[1])}` : 'no interval'})`);
const score = (x: number | null) => (x === null ? 'n/a' : x.toFixed(1));
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x < 0.01 ? x.toFixed(4) : x.toFixed(3)}`);
const rel = (rs: readonly string[]) => (rs.length === 1 ? `release ${rs[0]}` : `releases ${rs.join(', ')}`);
const AGENT_NOTE = 'On the grep agent, each reader is the agent, so its particle-1 row measures particle-1 as an agent.';

function costTable(c: Record<WlReaderKey, Record<string, number | null>>): string[] {
  return ['| Row | claude-opus-5-5 | particle-1 |', '|---|---|---|', ...WL_ROWS.map(r => `| ${r} | ${usd(c['claude-opus-5-5'][r])} | ${usd(c['particle-1'][r])} |`)];
}

/** The weekly scorecard: a weekly point never carries a verdict word. */
export function renderWeek(a: WeekAggregates): string {
  assertAggregate(a, 'week');
  const title = `# Weekly held-out line: week of ${a.week}`;
  if (a.no_point) return [title, '', `No point: ${a.no_point}.`, ''].join('\n');
  const g = a.gbrain!, cmp = a.comparators!;
  const lines = [title, '',
    `gbrain ${g.release} (commit ${g.commit.slice(0, 12)}) against a grep agent, the extract-first server (${cmp['extract-first'].version}, fixed ${cmp['extract-first'].fixed}) and the memory-bank server (${cmp['memory-bank'].version}, fixed ${cmp['memory-bank'].fixed}), on ${a.worlds.length} sealed worlds read by claude-opus-5-5 and particle-1. Differences are gbrain minus the other row, in points, with 95% intervals. A weekly point carries no verdict word; only a block of four weeks gets one.`, ''];
  for (const cls of WL_CLASS_KEYS) {
    const c = a.classes![cls];
    lines.push(`## ${WL_CLASSES[cls].name.replace(/^./, x => x.toUpperCase())}`, '',
      '| gbrain minus | Both readers | claude-opus-5-5 | particle-1 | Worlds | Questions kept |', '|---|---|---|---|---|---|',
      ...WL_COMPARISONS.filter(x => x.cls === cls).map(x => { const d = c.differences[x.other]; return `| ${x.other} | ${cell(d.pooled)} | ${cell(d.readers['claude-opus-5-5'])} | ${cell(d.readers['particle-1'])} | ${d.pooled.worlds} | ${d.questions} of ${d.planned} |`; }),
      '', '| Row | Both readers | claude-opus-5-5 | particle-1 |', '|---|---|---|---|',
      ...WL_ROWS.map(r => { const m = c.means[r]; return `| ${r} | ${score(m.pooled)} | ${score(m.readers['claude-opus-5-5'])} | ${score(m.readers['particle-1'])} |`; }), '');
  }
  lines.push(AGENT_NOTE, '');
  const roll = a.rolling!;
  lines.push('## Rolling display', '', `The last ${roll.weeks.length} weekly point${roll.weeks.length === 1 ? '' : 's'} pooled (weeks ${roll.weeks.join(', ')}), each world measured once on its own week's build: gbrain ${rel(roll.builds)}.`, '',
    '| Comparison | Both readers | claude-opus-5-5 | particle-1 | Worlds |', '|---|---|---|---|---|',
    ...WL_COMPARISONS.map(x => { const d = roll.differences[x.cls][x.other]; return `| ${WL_CLASSES[x.cls].name}, ${x.other} | ${cell(d.pooled)} | ${cell(d.readers['claude-opus-5-5'])} | ${cell(d.readers['particle-1'])} | ${d.pooled.worlds} |`; }), '');
  lines.push('## Regression flag', '');
  if (!a.regression) lines.push('No previous block yet, so no flag can be read.', '');
  else {
    const flagged = WL_COMPARISONS.filter(x => a.regression![x.cls][x.other].flagged);
    lines.push(flagged.length ? `Flagged (an advisory to gbrain's maintainers; it holds no release): ${flagged.map(x => { const f = a.regression![x.cls][x.other]; return `${WL_CLASSES[x.cls].name} against ${x.other}, ${pts(f.point)} points, ${f.direction} the previous block's ${ci(f.previous_ci95)} by more than ${f.sdd.toFixed(1)}`; }).join('; ')}.` : "No weekly point fell outside the previous block's 95% interval by more than the weekly smallest detectable difference.", '',
      '| Comparison | Point | Previous block | Smallest detectable | Flag | Simulated false-alarm rate |', '|---|---|---|---|---|---|',
      ...WL_COMPARISONS.map(x => { const f = a.regression![x.cls][x.other]; return `| ${WL_CLASSES[x.cls].name}, ${x.other} | ${pts(f.point)} | ${f.previous_ci95 ? `${pts(f.previous_ci95[0])} to ${pts(f.previous_ci95[1])}` : 'n/a'} | ${f.sdd.toFixed(1)} | ${f.flagged ? f.direction : 'none'} | ${f.false_alarm_source === 'unavailable' ? 'unavailable (no registered calibration)' : f.false_alarm_rate === null ? 'n/a' : `${(f.false_alarm_rate * 100).toFixed(1)}% (${f.false_alarm_source})`} |`; }), '');
  }
  lines.push('## Cost per correct answer', '', ...costTable(a.cost_per_correct!), '');
  return lines.join('\n');
}

type BlockComp = BlockAggregates['comparisons'][string][string];

/** One comparison's block sentence, in the outcome table's wording, naming the releases the claim covers. */
export function blockSentence(cls: WlClass, other: WlOther, c: BlockComp, a: Pick<BlockAggregates, 'ended' | 'releases' | 'cost_per_correct'>): string {
  const name = WL_CLASSES[cls].name, who = WL_ROW_NAMES[other], grep = other === 'grep-agent';
  const against = `gbrain against ${who} on ${name}`;
  const byReader = `claude-opus-5-5 ${cell(c.readers['claude-opus-5-5'])}, particle-1 ${cell(c.readers['particle-1'])}`;
  const said = (word: 'ahead' | 'behind', e: Est, rs: readonly string[]) => {
    const x = e.mean!;
    if (word === 'ahead') return grep ? `gbrain (${rel(rs)}) beats a grep agent on ${WL_CLASSES[cls].held_out} by ${abs(x)} points (${ci(e.ci95)})` : `gbrain (${rel(rs)}) is ahead of ${who} on ${name} by ${abs(x)} points (${ci(e.ci95)})`;
    return `gbrain (${rel(rs)}) is behind ${who} on ${name} by ${abs(x)} points (${ci(e.ci95)})`;
  };
  switch (c.word) {
    case 'no verdict': return `${against}: no verdict, because ${a.ended ? 'the block has fewer than 16 counted worlds' : 'the block has not ended'}.`;
    case 'descriptive': return `${against}: descriptive, because its common question set lost ${c.mask.lost} of ${c.mask.planned} questions (${(c.mask.share * 100).toFixed(1)}%, above 5%).`;
    case 'ceiling': return `${against}: ceiling (gbrain ${score(c.means.gbrain)}, ${other} ${score(c.means.other)}, both at least 97).`;
    case 'changed within the block': return `${against}: changed within the block. Early, at the 16th counted world (${rel(c.early!.releases)}): ${pts(c.early!.pooled.mean)} points (${ci(c.early!.pooled.ci95)}). Full block (${rel(a.releases)}): ${pts(c.pooled.mean)} points (${ci(c.pooled.ci95)}).`;
    case 'ahead': case 'behind':
      if (c.early) return `${said(c.word, c.early.pooled, c.early.releases)}, early, at the 16th counted world. The ${a.ended ? 'full block' : 'block so far'} (${rel(a.releases)}) reads ${pts(c.pooled.mean)} points (${ci(c.pooled.ci95)}).`;
      return `${said(c.word, c.pooled, a.releases)}.`;
    case 'level within 3 points': {
      const base = `gbrain (${rel(a.releases)}) is level with ${who} within 3 points on ${name} (${pts(c.pooled.mean)} points, ${ci(c.pooled.ci95)}).`;
      if (!grep || !a.cost_per_correct) return base;
      const k = a.cost_per_correct;
      return `${base} Cost per correct answer: gbrain ${usd(k['claude-opus-5-5'].gbrain)} and the grep agent ${usd(k['claude-opus-5-5']['grep-agent'])} with claude-opus-5-5, ${usd(k['particle-1'].gbrain)} and ${usd(k['particle-1']['grep-agent'])} with particle-1.`;
    }
    case 'split by reader': return `${against}: split by reader (${byReader}).`;
    case 'no measurable difference': return `${against}: no measurable difference at this sample size (${byReader}).`;
  }
  return `${against}: ${c.word}.`;
}

/** A block's page section: the release set, the look, each comparison's word, both readers' rows and what is reported beside them. */
export function renderBlock(a: BlockAggregates): string {
  assertAggregate(a, 'block');
  const weeks = a.weeks.map(w => w.week);
  const lines = [`## Block ${a.block}${weeks.length ? ` (weeks ${weeks[0]} to ${weeks.at(-1)})` : ''}`, '',
    `${a.counted_worlds} counted world${a.counted_worlds === 1 ? '' : 's'} on gbrain ${a.releases.length ? rel(a.releases) : 'no release'}. ${a.look ? `The look came at the 16th counted world (${rel(a.look.releases)}).` : 'The block reached no look, so it has no verdict.'}${a.ended ? '' : ` The block has not ended (${a.weeks.length} of 4 weeks), so only early words stand.`}`, ''];
  const skipped = a.weeks.filter(w => w.no_point);
  if (skipped.length) lines.push(`No point: ${skipped.map(w => `${w.week} (${w.no_point})`).join('; ')}.`, '');
  lines.push('### Verdicts', '', ...WL_COMPARISONS.map(x => `- ${blockSentence(x.cls, x.other, a.comparisons[x.cls][x.other], a)}`), '',
    '| Comparison | Word | Both readers | claude-opus-5-5 | particle-1 | Questions kept |', '|---|---|---|---|---|---|',
    ...WL_COMPARISONS.map(x => { const c = a.comparisons[x.cls][x.other]; return `| ${WL_CLASSES[x.cls].name}, ${x.other} | ${c.word}${c.early && c.word === c.early.word ? ' (early)' : ''} | ${cell(c.pooled)} | ${cell(c.readers['claude-opus-5-5'])} | ${cell(c.readers['particle-1'])} | ${c.mask.kept} of ${c.mask.planned} |`; }), '',
    AGENT_NOTE, '');
  const lead = WL_CLASS_KEYS.map(cls => a.leading_competitor[cls] ? `on ${WL_CLASSES[cls].name}, ${WL_ROW_NAMES[a.leading_competitor[cls]!]}` : null).filter(Boolean);
  if (lead.length) lines.push(`The leading competitor in this block: ${lead.join('; ')}.`, '');
  lines.push('### All 64 questions', '', '| Row | Both readers | claude-opus-5-5 | particle-1 |', '|---|---|---|---|',
    ...WL_ROWS.map(r => { const m = a.all64[r]; return `| ${r} | ${score(m.pooled)} | ${score(m.readers['claude-opus-5-5'])} | ${score(m.readers['particle-1'])} |`; }), '');
  const rate = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  lines.push("### The grep agent's stops", '', '| Week | Reader | Answers | Out of turns | Out of context |', '|---|---|---|---|---|',
    ...[...a.grep_agent.weeks.map(w => ({ label: w.week, readers: w.readers })), { label: 'block', readers: a.grep_agent.block }].flatMap(w => WL_READER_KEYS.map(r => { const s = w.readers[r]; return `| ${w.label} | ${r} | ${s.answers} | ${s.turn_cap} (${rate(s.turn_cap_rate)}) | ${s.context_overflow} (${rate(s.context_overflow_rate)}) |`; })), '');
  if (a.cost_per_correct) lines.push('### Cost per correct answer', '', ...costTable(a.cost_per_correct), '');
  if (a.per_kind) lines.push('### Per kind (both readers, unadjusted)', '', `| Kind | ${['grep-agent', 'extract-first', 'memory-bank'].join(' | ')} |`, '|---|---|---|---|',
    ...Object.entries(a.per_kind).map(([k, rows]) => `| ${k} | ${['grep-agent', 'extract-first', 'memory-bank'].map(o => cell(rows[o])).join(' | ')} |`), '');
  return lines.join('\n');
}
