/**
 * Per-reader token calibration from dev smoke cells (preregistration "Arms": each reader's factor is measured on dev
 * packs against provider-reported input tokens).
 *
 *   bun eval/runner/q1/calibrate.ts <cell output dir>... [--json]
 *
 * A cell output dir is what `bun eval/runner/q1/cell.ts run` writes (`runs/<cell>/contexts.ndjson` holds every packed
 * prompt, `runs/<cell>/r/<realization>/answers.ndjson` the provider-reported input tokens of each reader call). For
 * every packed answer the sample is (local count of the exact prompt bytes in the reader's encoding, provider input
 * tokens); `measureCalibration` (eval/runner/systems/render.ts) turns each reader's samples into its factor and the
 * largest per-call error under it. Only packed component contexts count: whole-history and agent prompts are not
 * the bytes the packer budgets.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodingCount, measureCalibration, readerTokenizer } from '../systems/render.ts';

const lines = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as T) : [];

export interface CalibrationSample { reader: string; local: number; provider: number }

/** Samples from one cell output dir: each packed answer's prompt counted locally against its provider input tokens. */
export function calibrationSamples(out: string): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  const runs = join(out, 'runs');
  if (!existsSync(runs)) return samples;
  for (const cell of readdirSync(runs)) {
    const prompts = new Map(lines<{ prompt: string; meta: { context_sha256: string } }>(join(runs, cell, 'contexts.ndjson')).map(c => [c.meta.context_sha256, c.prompt]));
    const rdir = join(runs, cell, 'r');
    if (!existsSync(rdir)) continue;
    for (const rid of readdirSync(rdir)) {
      for (const a of lines<{ reader: string; context_sha256: string; provider_input_tokens: number | null; outcome: string }>(join(rdir, rid, 'answers.ndjson'))) {
        const prompt = prompts.get(a.context_sha256);
        if (!prompt || !a.provider_input_tokens || a.outcome !== 'scored') continue;
        samples.push({ reader: a.reader, local: encodingCount(readerTokenizer(a.reader).encoding, prompt), provider: a.provider_input_tokens });
      }
    }
  }
  return samples;
}

export function calibrate(samples: readonly CalibrationSample[]) {
  const readers = [...new Set(samples.map(s => s.reader))].sort();
  return Object.fromEntries(readers.map(r => {
    const mine = samples.filter(s => s.reader === r);
    const m = measureCalibration(mine);
    return [r, { encoding: readerTokenizer(r).encoding, factor: Math.round(m.factor * 10_000) / 10_000, max_error: Math.round(m.max_error * 10_000) / 10_000, needs_provider_count: m.needs_provider_count, samples: mine.length }];
  }));
}

if (import.meta.main) {
  const dirs = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!dirs.length) { console.error('usage: bun eval/runner/q1/calibrate.ts <cell output dir>... [--json]'); process.exit(2); }
  const result = calibrate(dirs.flatMap(calibrationSamples));
  console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : Object.entries(result).map(([r, x]) => `${r}: ${x.encoding} x ${x.factor} (max error ${(x.max_error * 100).toFixed(1)}%, ${x.samples} packs)`).join('\n'));
}
