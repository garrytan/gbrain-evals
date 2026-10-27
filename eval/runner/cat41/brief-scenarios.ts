/**
 * Wave 5 D7: Cat 41 brief scenarios. Native Claude Code and Codex sessions on a brain that already holds what the
 * user said after four calls, aged or crowded out of hot memory, with gbrain's proactive brief off or on.
 *
 * Four scenarios per world (preregistration docs/benchmarks/2026-10-15-cat41-brief-preregistration.md): reply to an
 * email, meeting prep, the start of a task with an open commitment, and a negative (a reply to the namesake of a
 * contact, where the brief should stay silent). Three arms: `off` and `on` (gbrain setup with its read hooks, the
 * brief switch off or on) and `pull` (gbrain setup --no-hooks, Claude Code only: `context_pack` is the only brief
 * path).
 *
 * Imported by the in-container driver, so it uses Node built-ins only and reads its worlds from brief-worlds.json,
 * which eval/runner/cat41/brief-worlds.ts renders from the program-primary generator.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Box, CmdResult, RunView, Scenario } from './scenarios.ts';
import type { Harness } from './types.ts';

export const D7_SCENARIO_KINDS = ['reply', 'prep', 'task_start', 'negative'] as const;
export type D7Kind = typeof D7_SCENARIO_KINDS[number];
export const D7_ARMS = ['off', 'on', 'pull'] as const;
export type D7Arm = typeof D7_ARMS[number];
export type D7Condition = 'aged' | 'crowded';

export interface D7Matcher { label: string; patterns: string[] }
export interface D7Contact {
  task: string;
  slug: string;
  name: string;
  kind: 'reply' | 'prep';
  /** Session-1 lines in the user's order. */
  lines: Array<{ what: 'commitment' | 'date' | 'correction'; text: string }>;
  gold: { commitment: D7Matcher; new_date: D7Matcher; old_date: D7Matcher; corrected: D7Matcher; stale: D7Matcher; namesake: D7Matcher[] };
}
export interface D7ScenarioSpec {
  kind: D7Kind;
  /** The task whose contact the scenario is about (for the negative: whose namesake writes). */
  task: string;
  /** Who the prompt names: the contact, or the namesake for the negative. */
  counterparty: { slug: string; name: string };
  condition: D7Condition;
  prompt: string;
  /** task_start only: the same request without the lexicon word, replayed ($0) to show the gate stays silent on it. */
  gate_check_prompt?: string;
  crowd: Array<{ entity: string; fact: string }>;
}
export interface D7World {
  seed: number;
  persona: string;
  principal: { name: string; first: string };
  docs: Record<string, string>;
  contacts: D7Contact[];
  scenarios: D7ScenarioSpec[];
}
export interface D7Fixture { version: string; generator: string; seeds: number[]; worlds: D7World[] }

export const D7_FIXTURE_FILE = join(import.meta.dir, 'brief-worlds.json');
export const D7_FIXTURE: D7Fixture = JSON.parse(readFileSync(D7_FIXTURE_FILE, 'utf8'));

/** Aged: the seeded facts, timeline entries and page revisions are dated this many hours before the cell. */
export const D7_AGED_HOURS = 72;
export const D7_SESSION_TIMEOUT_MS = 600_000;
export const D7_PROVENANCE = 'user said in chat (call notes)';
/** The release under test (preregistration, "The freeze"): paid D7 sessions run only on this commit. */
export const D7_RELEASE = { version: '0.60.247.0', commit: '47f052af0c7f92f259daa9b1b51bb90370dcf520' } as const;
/** Codex runs the first world only (preregistration, "Sessions"). */
export const D7_CODEX_SEEDS: readonly number[] = [D7_FIXTURE.seeds[0]];

export const d7ScenarioId = (kind: D7Kind, seed: number, arm: D7Arm) => `d7_${kind}_${seed}_${arm}`;
export function parseD7Id(id: string): { kind: D7Kind; seed: number; arm: D7Arm } | null {
  const m = id.match(/^d7_(reply|prep|task_start|negative)_(\d+)_(off|on|pull)$/);
  return m ? { kind: m[1] as D7Kind, seed: Number(m[2]), arm: m[3] as D7Arm } : null;
}

async function must(box: Box, args: string[], opts?: Parameters<Box['gb']>[1]): Promise<CmdResult> {
  const r = await box.gb(args, opts);
  if (r.code !== 0) throw new Error(`setup: gbrain ${args.join(' ')} exited ${r.code}: ${(r.stderr || r.stdout).slice(-600)}`);
  return r;
}

const ymd = (iso: string) => iso.slice(0, 10);
const reAll = (m: D7Matcher, text: string) => m.patterns.some(p => new RegExp(p, 'i').test(text));

/** Brain setup for one cell: notes, the four calls' saved items, the condition, the brief switch, then the harness wiring. */
async function setupCell(box: Box, w: D7World, spec: D7ScenarioSpec, arm: D7Arm): Promise<void> {
  const vault = `${box.home}/notes`;
  for (const [rel, body] of Object.entries(w.docs)) box.write(`${vault}/${rel}.md`, body);
  await must(box, ['init', '--pglite', '--no-embedding', '--json']);
  await must(box, ['import', vault, '--no-embed']);
  const since = new Date(Date.now() - 1000).toISOString();
  const agedAt = new Date(Date.now() - D7_AGED_HOURS * 3_600_000).toISOString();
  const day = spec.condition === 'aged' ? ymd(agedAt) : ymd(new Date().toISOString());
  for (const c of w.contacts) {
    for (const l of c.lines) {
      if (l.what === 'commitment') {
        await must(box, ['call', 'add_timeline_entry', JSON.stringify({ slug: c.slug, date: day, summary: l.text, source: 'call notes' })]);
      } else {
        await must(box, ['remember', l.text, '--entity', c.slug, '--provenance', D7_PROVENANCE, '--content-origin', 'user_said']);
      }
    }
  }
  if (spec.condition === 'aged') {
    const r = await box.sh(`bun /opt/runner/cat41/brief-db.ts backdate ${since} ${agedAt}`, { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`setup: backdate exited ${r.code}: ${(r.stderr || r.stdout).slice(-600)}`);
    box.note('backdated', JSON.parse(r.stdout.trim().split('\n').at(-1)!));
    box.note('aged_at', agedAt);
  } else {
    for (const f of spec.crowd) await must(box, ['remember', f.fact, '--entity', f.entity, '--provenance', D7_PROVENANCE, '--content-origin', 'user_said']);
    box.note('crowd_facts', spec.crowd.length);
  }
  if (arm === 'on') await must(box, ['config', 'set', 'context.proactive_brief', 'true']);
  const harnessId = box.harness === 'claude' ? 'claude-code' : 'codex';
  const wire = await box.gb(['setup', harnessId, '--gbrain-bin', '/usr/local/bin/gbrain', '--no-capture', '--no-providers', ...(arm === 'pull' ? ['--no-hooks'] : []), '--json'], {
    env: box.harness === 'codex' ? { CODEX_HOME: `${box.home}/.codex` } : {},
    timeoutMs: 300_000,
  });
  box.note('setup_exit', wire.code);
  try { box.note('setup_states', (JSON.parse(wire.stdout) as { states?: unknown }).states ?? null); } catch { box.note('setup_stdout_tail', wire.stdout.slice(-800)); }
  if (wire.code !== 0) throw new Error(`setup: gbrain setup ${harnessId} exited ${wire.code}: ${(wire.stderr || wire.stdout).slice(-800)}`);
  box.setMcp(null);
  Object.entries({ world: w.seed, kind: spec.kind, arm, condition: spec.condition, task: spec.task, counterparty: spec.counterparty.slug }).forEach(([k, v]) => box.note(k, v));
}

/** Hook stdout the wrapper captured, one record per `gbrain hook` call. */
export interface HookCapture { id: string; event: string; start_ms: number; end_ms: number | null; rc: number | null; stdout: string }

/** After the sessions: the captured hooks, the hook heartbeat, the brain's counts and the brief replay timings. */
async function probeCell(box: Box, spec: D7ScenarioSpec): Promise<Record<string, unknown>> {
  const replayOf = async (prompt: string): Promise<unknown> => {
    const r = await box.sh(`bun /opt/runner/cat41/brief-db.ts replay ${Buffer.from(JSON.stringify({ prompt })).toString('base64')}`, { timeoutMs: 180_000 });
    try { return JSON.parse(r.stdout.trim().split('\n').at(-1)!); } catch { return { error: (r.stderr || r.stdout).slice(-600) }; }
  };
  const replayOut = await replayOf(spec.prompt);
  const gateCheck = spec.gate_check_prompt ? await replayOf(spec.gate_check_prompt) : undefined;
  const heartbeat = (box.read(`${box.home}/.gbrain/integrations/hooks/heartbeat.jsonl`) ?? '').split('\n').filter(Boolean)
    .map(l => { try { const e = JSON.parse(l); return { event: e.event, outcome: e.outcome, reason: e.reason, bytes: e.bytes, ms: e.ms ?? e.duration_ms ?? null }; } catch { return null; } }).filter(Boolean);
  return { replay: replayOut, ...(gateCheck ? { gate_check_replay: gateCheck } : {}), hook_heartbeat: heartbeat };
}

/** Container-side success, a coarse check for the generic Cat 41 table; the D7 summary scores with the T0 scorer. */
function coarseSuccess(w: D7World, spec: D7ScenarioSpec, r: RunView): { ok: boolean; why: string } {
  const c = w.contacts.find(x => x.task === spec.task)!;
  const t = r.finalText;
  if (spec.kind === 'negative') {
    const leaked = [c.gold.commitment, c.gold.new_date, c.gold.corrected].filter(m => reAll(m, t)).map(m => m.label);
    return { ok: leaked.length === 0 && t.trim().length > 0, why: leaked.length ? `used the namesake contact's items: ${leaked.join(', ')}` : 'replied without the other contact\'s items' };
  }
  const need = spec.kind === 'task_start' ? [c.gold.commitment, c.gold.new_date] : [c.gold.commitment, c.gold.new_date, c.gold.corrected];
  const missing = need.filter(m => !reAll(m, t)).map(m => m.label);
  return { ok: missing.length === 0, why: missing.length ? `missing ${missing.join(', ')}` : 'stated every needed current value' };
}

function scenarioFor(w: D7World, spec: D7ScenarioSpec, arm: D7Arm): Scenario {
  const harnesses: Harness[] = arm === 'pull' || !D7_CODEX_SEEDS.includes(w.seed) ? ['claude'] : ['claude', 'codex'];
  return {
    id: d7ScenarioId(spec.kind, w.seed, arm),
    title: `D7 ${spec.kind} (${spec.condition}, world ${w.seed}, brief ${arm})`,
    group: 'recall', safety: false, optIn: true, wiresHarness: true, harnesses,
    authorized: { effects: [] }, expectsRelay: false, timeoutMs: D7_SESSION_TIMEOUT_MS,
    prompt: () => spec.prompt,
    setup: box => setupCell(box, w, spec, arm),
    probe: box => probeCell(box, spec),
    success: r => coarseSuccess(w, spec, r),
  };
}

export const D7_SCENARIOS: readonly Scenario[] = D7_FIXTURE.worlds.flatMap(w => w.scenarios.flatMap(spec => D7_ARMS.map(arm => scenarioFor(w, spec, arm))));
