#!/usr/bin/env bun
/**
 * Wave 5 D7 (Cat 41 brief scenarios): the free smoke and the cell reader.
 *
 *   # $0: every scenario's setup, hooks and native delivery, with the harness's model calls sent to the fake provider
 *   bun eval/runner/cat41/brief-d7.ts smoke --gbrain <checkout>@<ref> --out <dir> [--harnesses claude,codex]
 *     [--scenarios d7_reply_20261222_on,...] [--concurrency 3]
 *
 *   # the preregistered analysis of paid passes (one directory per Claude model, plus Codex)
 *   bun eval/runner/cat41/brief-d7.ts summarize --out <file> <pass dir> [<pass dir> ...]
 *
 * The paid cells run through `cat41-agent-operator.ts run --scenarios <d7 ids>`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generatePersona, type PPTask } from '../../generators/program-primary-gen.ts';
import { BRIEF_MAX_CHARS, briefBlock, classifyItem, FALSE_PUSH_CEILING, hotMemoryText, NEEDED_FACTS, NONINFERIORITY_MARGIN, pairedRatio, pairedSuccess, TOOL_CALL_RATIO_MAX, CONTROL_FAILURE_CEILING, type NeededFact } from '../t0/brief.ts';
import { matches, scoreAnswer, T0_SCORER_POSTHOC } from '../t0/score.ts';
import { parseSession } from './transcript.ts';
import { dockerRun, publishable } from '../cat41-agent-operator.ts';
import { resolveGbrainUnderTest, overlaySummary } from '../gbrain-under-test.ts';
import { D7_FIXTURE, D7_SCENARIOS, parseD7Id, type D7ScenarioSpec, type D7World } from './brief-scenarios.ts';
import type { ContainerResult, Harness } from './types.ts';

export const D7_SMOKE_VERSION = 'd7-smoke-v1';
/** gbrain's per-turn brief cutoff (TURN_BRIEF_CUTOFF_MS in src/core/context/proactive-brief.ts at v0.60.247.0). */
export const TURN_BRIEF_CUTOFF_MS = 300;

function flag(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}

export function d7Spec(id: string): { world: D7World; spec: D7ScenarioSpec; task: PPTask; arm: string } {
  const p = parseD7Id(id);
  if (!p) throw new Error(`not a D7 scenario: ${id}`);
  const world = D7_FIXTURE.worlds.find(w => w.seed === p.seed)!;
  const spec = world.scenarios.find(s => s.kind === p.kind)!;
  const task = generatePersona(p.seed).tasks.find(t => t.id === spec.task)!;
  return { world, spec, task, arm: p.arm };
}

/** The context a hook injected: Claude Code and Codex user-prompt hooks print JSON with `additionalContext`, session-start prints text. */
export function injectedText(stdout: string): string {
  const t = stdout.trim();
  if (!t.startsWith('{')) return t;
  try {
    const j = JSON.parse(t) as { hookSpecificOutput?: { additionalContext?: unknown }; additionalContext?: unknown };
    return String(j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? '');
  } catch { return t; }
}

const carried = (task: PPTask, text: string): NeededFact[] => NEEDED_FACTS.filter(f => matches(f === 'commitment' ? task.gold.commitment : f === 'new_date' ? task.gold.date.new : task.gold.correction.corrected, text));

/** Text of every request body the harness sent to the (fake) model provider. */
function harnessRequestText(dir: string): string[] {
  const f = join(dir, 'harness-requests.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.stringify((JSON.parse(l) as { body: unknown }).body); } catch { return ''; } });
}

/** What one container run delivered: hooks, brief blocks and items, hot memory, whether the brief reached the model's input, replay timings. */
export function readDelivery(id: string, r: ContainerResult, dir: string) {
  const { spec, task } = d7Spec(id);
  const hooks = (r.hook_captures ?? []).map(h => {
    const text = injectedText(h.stdout);
    const block = briefBlock({ event: h.event === 'session-start' ? 'session-start' : 'user-prompt', text });
    const rest = block ? text.replace(block.text, '') : text;
    return {
      event: h.event, ms: h.end_ms !== null ? h.end_ms - h.start_ms : null, rc: h.rc, bytes: Buffer.byteLength(text),
      brief: block ? { chars: block.chars, items: block.items.map(i => ({ id: i.id, slug: i.slug, ...(spec.kind === 'negative' ? {} : { class: classifyItem(task, i) }) })) } : null,
      hot_memory_facts: carried(task, hotMemoryText(rest)),
      other_injected_facts: carried(task, rest),
    };
  });
  const bodies = harnessRequestText(dir);
  const briefTexts = (r.hook_captures ?? []).map(h => briefBlock({ event: 'user-prompt', text: injectedText(h.stdout) })).filter(b => b !== null).map(b => b!.items[0]?.text ?? '');
  const reachedModel = briefTexts.length ? briefTexts.every(t => bodies.some(b => b.includes(t.slice(4, 60).replace(/"/g, '\\"')))) : null;
  return {
    id, harness: r.harness, setup_error: r.setup_error ?? null, crash: r.crash ? r.crash.slice(0, 400) : null,
    setup: { condition: r.setup.condition, arm: r.setup.arm, backdated: r.setup.backdated ?? null, crowd_facts: r.setup.crowd_facts ?? null, setup_exit: r.setup.setup_exit, setup_states: r.setup.setup_states ?? null },
    hooks, harness_requests: bodies.length, brief_reached_model: reachedModel,
    replay: r.probe.replay ?? null, gate_check_replay: r.probe.gate_check_replay ?? null, heartbeat: r.probe.hook_heartbeat ?? null,
  };
}

/** The time-to-first-correct-action ratio the primary needs (20% faster, the same effect size as D6 v2's tool calls). */
export const TIME_RATIO_MAX = TOOL_CALL_RATIO_MAX;
export const POSITIVE_KINDS = ['reply', 'prep', 'task_start'] as const;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

/**
 * One session's timeline from its transcript and per-line arrival times (ms since the harness process started).
 * `outputs`: assistant text and file-writing tool inputs, each with the model turns and tool calls up to it.
 * `model_waits`: per model request, the gap from what the model was waiting on (session start, or the previous tool
 * result) to the first line of its reply: provider latency plus generation, an approximation from arrival gaps.
 */
export function sessionTimeline(harness: Harness, raw: string, times: number[]) {
  const outputs: Array<{ ms: number; text: string; turns: number; tool_calls: number }> = [];
  const waits: number[] = [];
  let waitingSince: number | null = null;
  let turns = 0, tools = 0;
  let lastMsg: string | null = null;
  let apiMs = null as number | null;
  const reply = (ms: number, id: string | null) => {
    if (id !== null && id === lastMsg) return;
    lastMsg = id;
    turns++;
    if (waitingSince !== null) { waits.push(ms - waitingSince); waitingSince = null; }
  };
  raw.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t.startsWith('{')) return;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(t); } catch { return; }
    const ms = times[i] ?? times.at(-1) ?? 0;
    if (harness === 'claude') {
      if (ev.type === 'system' && ev.subtype === 'init') waitingSince = ms;
      else if (ev.type === 'assistant') {
        const msg = (ev.message ?? {}) as { id?: string; content?: Array<Record<string, unknown>> };
        reply(ms, msg.id ?? `line${i}`);
        for (const b of msg.content ?? []) {
          if (b.type === 'tool_use') tools++;
          if (b.type === 'text' && typeof b.text === 'string') outputs.push({ ms, text: b.text, turns, tool_calls: tools });
          else if (b.type === 'tool_use' && FILE_TOOLS.has(String(b.name))) outputs.push({ ms, text: Object.values((b.input ?? {}) as Record<string, unknown>).map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n'), turns, tool_calls: tools });
        }
      } else if (ev.type === 'user' && ((ev.message as { content?: Array<{ type?: string }> } | undefined)?.content ?? []).some(b => b.type === 'tool_result')) {
        waitingSince = ms; lastMsg = null;
      } else if (ev.type === 'result' && typeof ev.duration_api_ms === 'number') apiMs = ev.duration_api_ms;
    } else {
      if (ev.type === 'turn.started') waitingSince = ms;
      const it = (ev.item ?? {}) as Record<string, unknown>;
      const toolItem = it.type === 'command_execution' || it.type === 'mcp_tool_call' || it.type === 'web_search';
      if (ev.type === 'item.started' || ev.type === 'item.completed') {
        if (waitingSince !== null && (ev.type === 'item.started' || !toolItem)) reply(ms, null);
        if (ev.type === 'item.completed' && toolItem) { tools++; waitingSince = ms; }
        if (ev.type === 'item.completed' && it.type === 'agent_message' && typeof it.text === 'string') outputs.push({ ms, text: it.text, turns, tool_calls: tools });
        else if (ev.type === 'item.completed' && it.type === 'command_execution' && typeof it.command === 'string') outputs.push({ ms, text: it.command, turns, tool_calls: tools });
      }
    }
  });
  return { outputs, model_waits: waits, turns, tool_calls: tools, api_ms: apiMs };
}

/** The scenario's correctness rule on a text: positive kinds need every needed current value with no failure (task_start: commitment and new date). */
export function correctOn(kind: string, task: PPTask, text: string): { success: boolean; complete: boolean; confident_wrong: boolean; kinds: string[] } {
  if (kind === 'negative') {
    const leaked = [task.gold.commitment, task.gold.date.new, task.gold.correction.corrected].filter(m => matches(m, text)).map(m => m.label);
    return { success: text.trim().length > 0 && leaked.length === 0, complete: text.trim().length > 0 && leaked.length === 0, confident_wrong: leaked.length > 0, kinds: leaked.length ? ['other_contact'] : [] };
  }
  const s = scoreAnswer(task, text, { version: T0_SCORER_POSTHOC });
  const confident_wrong = s.kinds.some(k => k === 'stale_date' || k === 'stale_correction' || k === 'unsupported');
  if (kind === 'task_start') {
    const ok = !s.failed && s.new_date_hit;
    return { success: ok, complete: ok, confident_wrong, kinds: s.kinds };
  }
  return { success: !s.failed, complete: s.complete, confident_wrong, kinds: s.kinds };
}

export interface D7Cell {
  id: string; kind: string; seed: number; arm: string; condition: string; harness: Harness; model: string; repeat: number;
  status: 'scored' | 'setup_error' | 'harness_crash';
  success: boolean; confident_wrong: boolean; failure_kinds: string[];
  /** ms from the harness process start to the first output with every needed current value; censored at the session's end when none. */
  time_to_correct_ms: number; reached_correct: boolean; session_ms: number;
  /** Model turns and tool calls up to the first correct output (the session's totals when censored). */
  turns_to_correct: number; tool_calls_to_correct: number;
  /** Per model request: reply wait from arrival gaps (provider latency plus generation); Claude Code's own API time. */
  model_waits_ms: number[]; api_ms: number | null;
  tool_calls: number; input_tokens: number; cost_usd: number;
  /** `context_pack` calls that named a `counterparty` (the pull brief), in any arm. */
  pull_brief_calls: number;
  delivery: ReturnType<typeof readDelivery>;
  /** Pushed needed facts that the final answer states (acted on). */
  acted_on: NeededFact[];
}

export function readCell(dir: string, r: ContainerResult): D7Cell | null {
  const p = parseD7Id(r.scenario);
  if (!p) return null;
  const { spec, task } = d7Spec(r.scenario);
  const delivery = readDelivery(r.scenario, r, dir);
  const base = { id: r.scenario, kind: p.kind, seed: p.seed, arm: p.arm, condition: spec.condition, harness: r.harness, model: r.model, repeat: r.repeat, delivery };
  const s1 = r.sessions[0];
  if (r.setup_error || !s1) return { ...base, status: 'setup_error', success: false, confident_wrong: false, failure_kinds: [], time_to_correct_ms: 0, reached_correct: false, session_ms: 0, turns_to_correct: 0, tool_calls_to_correct: 0, model_waits_ms: [], api_ms: null, tool_calls: 0, input_tokens: 0, cost_usd: 0, pull_brief_calls: 0, acted_on: [] };
  const raw = existsSync(join(dir, s1.raw_path)) ? readFileSync(join(dir, s1.raw_path), 'utf8') : '';
  const times = existsSync(join(dir, `${s1.raw_path}.times`)) ? JSON.parse(readFileSync(join(dir, `${s1.raw_path}.times`), 'utf8')) as number[] : [];
  const parsed = parseSession(r.harness, raw, 1);
  const crashed = !!parsed.harnessError || !parsed.finalText.trim();
  const tl = sessionTimeline(r.harness, raw, times);
  let cumulative = '';
  let first: (typeof tl.outputs)[number] | null = null;
  for (const e of tl.outputs) {
    cumulative += `\n${e.text}`;
    if (correctOn(p.kind, task, cumulative).complete) { first = e; break; }
  }
  const final = correctOn(p.kind, task, parsed.finalText);
  const pushed = new Set(delivery.hooks.flatMap(h => h.brief?.items ?? []).flatMap(i => i.class?.carries ?? []));
  return {
    ...base, status: crashed ? 'harness_crash' : 'scored',
    success: final.success, confident_wrong: final.confident_wrong, failure_kinds: final.kinds,
    time_to_correct_ms: first?.ms ?? s1.wall_ms, reached_correct: first !== null, session_ms: s1.wall_ms,
    turns_to_correct: first?.turns ?? tl.turns, tool_calls_to_correct: first?.tool_calls ?? tl.tool_calls,
    model_waits_ms: tl.model_waits, api_ms: tl.api_ms,
    tool_calls: parsed.events.filter(e => e.kind !== 'text').length,
    pull_brief_calls: parsed.events.filter(e => e.kind === 'mcp' && e.name === 'context_pack' && typeof ((e.input as { arguments?: { counterparty?: unknown } } | undefined)?.arguments?.counterparty) === 'string').length, input_tokens: s1.input_tokens ?? 0, cost_usd: s1.cost_usd ?? 0,
    acted_on: carried(task, parsed.finalText).filter(f => pushed.has(f)),
  };
}

/** Every scored D7 cell under the pass directories (the last crash retry of each cell). */
export function readPasses(dirs: string[]): D7Cell[] {
  const latest = new Map<string, { cell: D7Cell; attempt: number }>();
  for (const out of dirs) {
    const root = join(out, 'runs');
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).sort()) {
      const f = join(root, d, 'result.json');
      if (!existsSync(f)) continue;
      const r = JSON.parse(readFileSync(f, 'utf8')) as ContainerResult;
      const cell = readCell(join(root, d), r);
      if (!cell) continue;
      const attempt = Number(d.match(/-a(\d+)$/)?.[1] ?? 0);
      const key = `${cell.id}|${cell.harness}|${cell.model}|${cell.repeat}`;
      const prev = latest.get(key);
      if (!prev || attempt > prev.attempt) latest.set(key, { cell, attempt });
    }
  }
  return [...latest.values()].map(x => x.cell);
}

const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const perRequest = (cs: D7Cell[]) => { const w = cs.flatMap(c => c.model_waits_ms); return { requests: w.length, median: median(w), max: w.length ? Math.max(...w) : null }; };
/** The live brief carried every item the uncut brief would have (replay `brief_alone`), and at least one. */
export const briefDelivered = (c: D7Cell) => {
  const live = c.delivery.hooks.find(h => h.event === 'user-prompt')?.brief?.items.length ?? 0;
  const possible = (c.delivery.replay as { brief_alone?: Array<{ brief_items: number }> } | null)?.brief_alone?.[0]?.brief_items ?? null;
  return live > 0 && possible !== null && live >= possible;
};
const pairKey = (c: D7Cell) => `${c.kind}|${c.seed}|${c.harness}|${c.model}|${c.repeat}`;

/** The preregistered D7 summary: primary (time to first correct action, success non-inferiority), checks and diagnostics. */
export function summarizeD7(cells: readonly D7Cell[]) {
  const scored = cells.filter(c => c.status === 'scored');
  const byArm = (arm: string) => new Map(scored.filter(c => c.arm === arm).map(c => [pairKey(c), c]));
  const off = byArm('off'), on = byArm('on'), pull = byArm('pull');
  const pairs = [...off.entries()].filter(([k]) => on.has(k)).map(([k, o]) => ({ key: k, off: o, on: on.get(k)! }));
  const positive = pairs.filter(p => (POSITIVE_KINDS as readonly string[]).includes(p.off.kind));
  const slice = (ps: typeof pairs) => ({
    time: pairedRatio(ps.map(p => ({ persona: p.key, off: p.off.time_to_correct_ms, on: p.on.time_to_correct_ms }))),
    success: pairedSuccess(ps.map(p => ({ persona: p.key, off: p.off.success, on: p.on.success }))),
    tool_calls: pairedRatio(ps.map(p => ({ persona: p.key, off: p.off.tool_calls, on: p.on.tool_calls }))),
    turns_to_correct: pairedRatio(ps.map(p => ({ persona: p.key, off: p.off.turns_to_correct, on: p.on.turns_to_correct }))),
    tool_calls_to_correct: pairedRatio(ps.map(p => ({ persona: p.key, off: p.off.tool_calls_to_correct, on: p.on.tool_calls_to_correct }))),
    model_wait_ms: pairedRatio(ps.map(p => ({ persona: p.key, off: p.off.model_waits_ms.reduce((a, b) => a + b, 0), on: p.on.model_waits_ms.reduce((a, b) => a + b, 0) }))),
    model_wait_ms_per_request: { off: perRequest(ps.map(p => p.off)), on: perRequest(ps.map(p => p.on)) },
    input_tokens: pairedRatio(ps.map(p => ({ persona: p.key, off: p.off.input_tokens, on: p.on.input_tokens }))),
    reached_correct: { off: ps.filter(p => p.off.reached_correct).length, on: ps.filter(p => p.on.reached_correct).length },
  });
  const group = (key: (p: (typeof pairs)[number]) => string) => Object.fromEntries([...new Set(positive.map(key))].sort().map(k => [k, slice(positive.filter(p => key(p) === k))]));
  const onCells = scored.filter(c => c.arm === 'on');
  const items = onCells.flatMap(c => c.delivery.hooks.flatMap(h => (h.brief?.items ?? []).map(i => ({ kind: c.kind, false_push: c.kind === 'negative' || (i.class?.false_push ?? true), stale: i.class?.stale ?? false }))));
  const briefChars = onCells.flatMap(c => c.delivery.hooks.map(h => h.brief?.chars ?? 0));
  const offLeaks = scored.filter(c => c.arm !== 'on' && c.delivery.hooks.some(h => h.brief));
  const control = Object.fromEntries((['aged', 'crowded'] as const).map(cond => {
    const cs = scored.filter(c => c.condition === cond && c.kind !== 'negative');
    const carrying = cs.filter(c => c.delivery.hooks.some(h => h.hot_memory_facts.length > 0)).length;
    return [cond, { cells: cs.length, hot_memory_carried_a_needed_fact: carrying, valid: cs.length > 0 && carrying / cs.length <= CONTROL_FAILURE_CEILING }];
  }));
  const pooled = slice(positive);
  const cw = (arm: string) => scored.filter(c => c.arm === arm && c.confident_wrong).length;
  const sessionsOn = onCells.length;
  const checks = {
    time_saved: pooled.time.ratio !== null && pooled.time.upper !== null && pooled.time.ratio <= TIME_RATIO_MAX && pooled.time.upper < 1,
    success_non_inferior: pooled.success.lower !== null ? pooled.success.lower >= -NONINFERIORITY_MARGIN : pooled.success.delta !== null && pooled.success.delta >= 0,
    hot_memory_control_valid: Object.values(control).every(c => c.valid),
    no_brief_without_hooks_on: offLeaks.length === 0,
    attention_within_cap: Math.max(0, ...briefChars) <= BRIEF_MAX_CHARS,
    false_push_within_ceiling: sessionsOn > 0 && items.filter(i => i.false_push).length / sessionsOn <= FALSE_PUSH_CEILING,
    no_confident_wrong_rise: cw('on') <= cw('off'),
  };
  const latency = scored.flatMap(c => c.delivery.hooks.filter(h => h.event === 'user-prompt').map(h => h.ms ?? 0));
  const replays = scored.map(c => c.delivery.replay as { turn_context?: Array<{ ms: number; brief_items: number }>; brief_alone?: Array<{ ms: number; brief_items: number }> } | null).filter(r => r?.turn_context);
  const liveVsReplay = onCells.filter(c => (POSITIVE_KINDS as readonly string[]).includes(c.kind)).map(c => {
    const live = c.delivery.hooks.find(h => h.event === 'user-prompt')?.brief?.items.length ?? 0;
    const alone = (c.delivery.replay as { brief_alone?: Array<{ brief_items: number }> } | null)?.brief_alone?.[0]?.brief_items ?? null;
    return { id: c.id, harness: c.harness, live, possible: alone, hook_ms: c.delivery.hooks.find(h => h.event === 'user-prompt')?.ms ?? null };
  });
  const verdict = checks.time_saved && checks.success_non_inferior && checks.hot_memory_control_valid && checks.no_brief_without_hooks_on && checks.attention_within_cap && checks.false_push_within_ceiling && checks.no_confident_wrong_rise
    ? 'time saved (development evidence only)' : !checks.hot_memory_control_valid || !checks.no_brief_without_hooks_on ? 'inconclusive (control or arm guard failed)' : 'no time-saved signal (development evidence only)';
  return {
    version: 'd7-summary-v1', cells: cells.length, scored: scored.length, not_scored: cells.filter(c => c.status !== 'scored').map(c => ({ id: c.id, harness: c.harness, model: c.model, status: c.status })),
    verdict, checks,
    pooled, delivered_only: { label: 'diagnostic only: positive pairs whose on cell got the full brief', ...slice(positive.filter(p => briefDelivered(p.on))) },
    by_kind: group(p => p.off.kind), by_model: group(p => p.off.model), by_condition: group(p => p.off.condition),
    negative: { pairs: pairs.filter(p => p.off.kind === 'negative').length, briefs_on: onCells.filter(c => c.kind === 'negative' && c.delivery.hooks.some(h => h.brief)).length, confident_wrong: { off: scored.filter(c => c.kind === 'negative' && c.arm === 'off' && c.confident_wrong).length, on: scored.filter(c => c.kind === 'negative' && c.arm === 'on' && c.confident_wrong).length } },
    pull: [...pull.values()].map(c => ({ key: pairKey(c), success: c.success, time_to_correct_ms: c.time_to_correct_ms, off_time_ms: off.get(pairKey(c))?.time_to_correct_ms ?? null, pull_brief_calls: c.pull_brief_calls })),
    pull_brief_by_arm: Object.fromEntries(['off', 'on', 'pull'].map(arm => { const cs = scored.filter(c => c.arm === arm); return [arm, { cells: cs.length, cells_that_pulled: cs.filter(c => c.pull_brief_calls > 0).length }]; })),
    control, brief: { sessions_on: sessionsOn, items: items.length, false_pushes: items.filter(i => i.false_push).length, stale_items: items.filter(i => i.stale).length, max_chars: Math.max(0, ...briefChars), fired_on_positive: onCells.filter(c => c.kind !== 'negative' && c.delivery.hooks.some(h => h.brief)).length, positive_on_cells: onCells.filter(c => c.kind !== 'negative').length, brief_reached_model: onCells.filter(c => c.delivery.brief_reached_model === true).length },
    diagnostics: {
      surfaced: onCells.filter(c => c.kind !== 'negative' && c.delivery.hooks.some(h => (h.brief?.items ?? []).some(i => (i.class?.carries ?? []).length > 0))).length,
      acted_on: onCells.filter(c => c.acted_on.length > 0).length,
      repeated_stale: { off: scored.filter(c => c.arm === 'off' && c.failure_kinds.some(k => k.startsWith('stale'))).length, on: scored.filter(c => c.arm === 'on' && c.failure_kinds.some(k => k.startsWith('stale'))).length },
      confident_wrong: { off: cw('off'), on: cw('on'), pull: cw('pull') },
    },
    latency: { cutoff_ms: TURN_BRIEF_CUTOFF_MS, user_prompt_hook_ms: latency.sort((a, b) => a - b), replay_cold_turn_context_ms: replays.map(r => r!.turn_context![0].ms), replay_cold_brief_dropped: onCells.map(c => c.delivery.replay as { turn_context?: Array<{ brief_items: number }>; brief_alone?: Array<{ brief_items: number }> } | null).filter(r => r?.turn_context && r.turn_context[0].brief_items === 0 && (r.brief_alone?.[0]?.brief_items ?? 0) > 0).length,
      replay_cold_on_cells_ms: onCells.filter(c => c.kind !== 'negative').map(c => (c.delivery.replay as { turn_context?: Array<{ ms: number }> } | null)?.turn_context?.[0]?.ms ?? null), live_vs_possible: liveVsReplay },
    cost_usd: cells.reduce((a, c) => a + c.cost_usd, 0),
  };
}

function cmdSummarize(argv: string[]) {
  const out = flag(argv, 'out');
  const dirs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out').map(d => resolve(d));
  const summary = summarizeD7(readPasses(dirs));
  if (out) writeFileSync(out, JSON.stringify(publishable(summary), null, 2) + '\n');
  console.log(JSON.stringify({ verdict: summary.verdict, checks: summary.checks, time: summary.pooled.time, success: summary.pooled.success }, null, 1));
}

async function cmdSmoke(argv: string[]) {
  const spec = flag(argv, 'gbrain');
  if (!spec) throw new Error('--gbrain <checkout>@<ref> is required');
  const out = resolve(flag(argv, 'out')!);
  const harnesses = (flag(argv, 'harnesses', 'claude,codex')!).split(',') as Harness[];
  const ids = flag(argv, 'scenarios') ? flag(argv, 'scenarios')!.split(',') : D7_SCENARIOS.map(s => s.id);
  const concurrency = Number(flag(argv, 'concurrency', '3'));
  const gut = resolveGbrainUnderTest(spec);
  const commit = gut.overlay!.build.commit;
  mkdirSync(join(out, 'runs'), { recursive: true });
  const jobs = ids.flatMap(id => harnesses.filter(h => D7_SCENARIOS.find(s => s.id === id)!.harnesses!.includes(h)).map(h => ({ id, h })));
  console.log(`[d7 smoke] ${jobs.length} runs against gbrain ${gut.version} @ ${commit.slice(0, 12)} -> ${out} ($0: fake harness provider)`);
  const rows: unknown[] = [];
  const q = [...jobs];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (q.length) {
      const { id, h } = q.shift()!;
      const dir = join(out, 'runs', `${id}--${h}`);
      if (!existsSync(join(dir, 'result.json'))) {
        const d = await dockerRun({ scenario: id, harness: h, model: h === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6.1-sol', repeat: 1, buildDir: gut.root, out: dir,
          docsBase: '', installSpec: '', gbrainRef: commit, timeoutMs: 600_000, extra: ['--fake-harness-provider'] });
        if (!existsSync(join(dir, 'result.json'))) { console.log(`[d7 smoke] ${id} ${h}: container failed (${d.code}) ${d.stderr.slice(-300)}`); continue; }
      }
      const r = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as ContainerResult;
      const row = readDelivery(id, r, dir);
      rows.push(row);
      const briefs = row.hooks.filter(x => x.brief).map(x => `${x.event}:${x.brief!.items.map(i => i.id).join('+')}`);
      console.log(`[d7 smoke] ${id} ${h}: ${row.setup_error ? `SETUP ERROR ${row.setup_error.slice(0, 200)}` : `hooks=${row.hooks.map(x => `${x.event}(${x.ms}ms)`).join(',') || 'none'} brief=${briefs.join(',') || 'none'} hot=${JSON.stringify(row.hooks.flatMap(x => x.hot_memory_facts))} model_saw_brief=${row.brief_reached_model} requests=${row.harness_requests}`}`);
    }
  }));
  writeFileSync(join(out, 'smoke.json'), JSON.stringify(publishable({ version: D7_SMOKE_VERSION, gbrain: overlaySummary(gut), at: new Date().toISOString(), rows }), null, 2) + '\n');
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'smoke') await cmdSmoke(rest);
  else if (cmd === 'summarize') cmdSummarize(rest);
  else { console.error('usage: brief-d7.ts smoke --gbrain <checkout>@<ref> --out <dir> [...]'); process.exitCode = 2; }
}
