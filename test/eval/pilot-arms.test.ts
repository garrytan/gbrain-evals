/**
 * Wave 1 pilot arms (A4): the byte-identical A0 replay against the frozen W10
 * manifests, the evidence substitution every other arm uses, the TRUNC
 * control, the FALLBACK rule, CACHE's body, and the keyless 2-question smoke
 * of every arm.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bodySha, type ArmManifest } from '../../eval/runner/batch/manifest.ts';
import { cacheBody, escalate, frontierBody, qualityCells } from '../../eval/runner/pilot/cells.ts';
import { cl100k, loadPilotEvidence, pilotSplit, truncEvidence, withEvidence } from '../../eval/runner/pilot/evidence.ts';
import { runSmoke } from '../../eval/runner/pilot/smoke.ts';
import { briefModuleAvailable } from '../../eval/runner/pilot/run.ts';

const ROOT = join(import.meta.dir, '../..');
const manifest = (arm: string) => JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks/2026-10-06-longmemeval-w10-manifests', `${arm}.json`), 'utf8')) as ArmManifest;
const ev = loadPilotEvidence();
const { pilot, confirm } = pilotSplit();

describe('A0 replay', () => {
  test('Sonnet 5.5 A0 bodies are byte-identical to the W10a manifest, all 500', () => {
    const m = manifest('w10a-sonnet55-notes');
    expect(m.requests).toHaveLength(500);
    for (const r of m.requests) expect(bodySha(frontierBody('claude-sonnet-5-5', ev.get(r.question_id)!.capture))).toBe(r.body_sha256);
  });

  test('gpt-6.1-sol A0 bodies are byte-identical to the W10c current-pin manifest', () => {
    const m = manifest('w10c-sol-currentpin');
    for (const r of m.requests) expect(bodySha(frontierBody('gpt-6.1-sol', ev.get(r.question_id)!.capture))).toBe(r.body_sha256);
    const covered = new Set(m.requests.map(r => r.question_id));
    expect(pilot.every(id => covered.has(id))).toBe(true);
  });

  test('replacing the evidence with itself reproduces the captured request', () => {
    for (const q of ev.values()) expect(withEvidence(q, q.evidence).user).toBe(q.capture.user);
  });
});

describe('split', () => {
  test('100 pilot and 400 confirm questions, disjoint and stable', () => {
    expect(pilot).toHaveLength(100);
    expect(confirm).toHaveLength(400);
    expect(pilot.filter(id => confirm.includes(id))).toHaveLength(0);
    expect(pilotSplit().pilot).toEqual(pilot);
  });
});

describe('arms', () => {
  test('TRUNC keeps whole sessions in rank order within the budget', () => {
    for (const id of pilot.slice(0, 20)) {
      const q = ev.get(id)!;
      for (const b of [1000, 2000, 4000, 7000]) {
        const t = truncEvidence(q, b);
        expect(t.tokens).toBeLessThanOrEqual(b);
        expect(cl100k(t.evidence)).toBe(t.tokens);
        if (!t.cut) expect(q.evidence.startsWith(t.evidence)).toBe(true);
      }
    }
  });

  test('FALLBACK escalates on errors, abstentions, hedges and missing labels only', () => {
    expect(escalate({ error: null, label: 'confident' })).toBe(false);
    expect(escalate({ error: null, label: 'hedged' })).toBe(true);
    expect(escalate({ error: null, label: 'abstain' })).toBe(true);
    expect(escalate({ error: null, label: null })).toBe(true);
    expect(escalate({ error: 'reader_max_tokens', label: 'confident' })).toBe(true);
  });

  test('CACHE sends A0 text with only caching markers added', () => {
    const q = ev.get(pilot[0])!;
    const a = cacheBody('claude-sonnet-5-5', q.capture, 'k') as any;
    expect(a.system[0].text).toBe(q.capture.system);
    expect(a.messages[0].content[0].text).toBe(q.capture.user);
    expect(a.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    const o = cacheBody('gpt-6.1-sol', q.capture, 'k') as any;
    const { prompt_cache_key, ...rest } = o;
    expect(prompt_cache_key).toBe('k');
    expect(bodySha(rest)).toBe(bodySha(frontierBody('gpt-6.1-sol', q.capture)));
  });

  // The brief builder is gbrain's src/eval/longmemeval/evidence-brief.ts (wave 1 A3); it loads from the pinned
  // dependency once that carries it, else from a sibling gbrain checkout.
  test.skipIf(!briefModuleAvailable())('keyless 2-question smoke runs every arm end to end', async () => {
    const r = await runSmoke();
    expect(r.cells).toBe(qualityCells().length);
    expect(r.rows.every(x => x.n === 2)).toBe(true);
    expect(r.hosts.sort()).toEqual(['api.anthropic.com', 'api.openai.com']);
    expect(r.models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'gpt-4o-2024-08-06', 'gpt-6-luna', 'gpt-6.1-sol']);
    const brief = r.rows.find(x => x.cell === 'brief@2000:gpt-6-luna:claude-sonnet-5-5')!;
    expect(brief.delivered!).toBeLessThanOrEqual(2000);
  }, 60_000);
});

describe('decision rule', () => {
  const row = (cell: string, correct: number, cw: number, usd: number) => ({ cell, n: 100, correct, committed_wrong: cw, usd_per_q: usd, discordance_vs_a0: { a0_right_arm_wrong: 3, a0_wrong_arm_right: 1 }, p95_ms: null, digest_write_usd_per_q: null });
  const R = 'claude-sonnet-5-5';
  const base = [row(`a0:${R}`, 93, 6, 0.047), row(`brief@2000:gpt-6-luna:${R}`, 91, 5, 0.011), row(`brief@2000:claude-haiku-5-5:${R}`, 92, 6, 0.008)];
  const t = (cell: string, ms: number) => Array.from({ length: 20 }, (_, i) => ({ cell, total_ms: ms + i, error: null }));
  test('a cheaper design that matches at lower dollars and latency fires the off-ramp', async () => {
    const { decide } = await import('../../eval/runner/pilot/decide.ts');
    const rows = [...base, row('direct:claude-haiku-5-5', 89, 7, 0.0025)];
    expect(decide(rows, [...t(`brief@2000:claude-haiku-5-5:${R}`, 5000), ...t('direct:claude-haiku-5-5', 3000)]).off_ramp_fires).toBe(true);
    expect(decide(rows, [...t(`brief@2000:claude-haiku-5-5:${R}`, 5000), ...t('direct:claude-haiku-5-5', 9000)]).off_ramp_fires).toBe(false);
    expect(decide([...base, row('direct:claude-haiku-5-5', 88, 7, 0.0025)], [...t(`brief@2000:claude-haiku-5-5:${R}`, 5000), ...t('direct:claude-haiku-5-5', 3000)]).off_ramp_fires).toBe(false);
  });
  test('a brief more than the tolerance below A0 for both builders fires the off-ramp', async () => {
    const { decide } = await import('../../eval/runner/pilot/decide.ts');
    expect(decide([row(`a0:${R}`, 93, 6, 0.047), row(`brief@2000:gpt-6-luna:${R}`, 89, 5, 0.011), row(`brief@2000:claude-haiku-5-5:${R}`, 89, 6, 0.008)], []).brief_misses).toBe(true);
  });
});
