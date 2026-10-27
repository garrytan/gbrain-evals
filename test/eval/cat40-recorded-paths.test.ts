/**
 * The Cat 40 runner scrubs every file it writes under --out (experiment.json, the receipt, results, transcripts,
 * served files, run.log): the gbrain checkout becomes `gbrain`, the slot root `<slots>`, and the evals checkout,
 * home and temp paths are rewritten as scrubMachinePaths does. The D5 brief smoke (2026-10-14) committed receipts
 * with `~/.capy/work/...` and `/workspace/...` paths because the runner wrote them unscrubbed. Hermetic, $0.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bindExperiment, cat40Recorder, main } from '../../eval/runner/cat40-model-ladder.ts';
import { MACHINE_LOCAL_PATH } from '../../eval/runner/receipt.ts';

const ROOT = resolve(import.meta.dir, '../..');
const CAPY_LOCAL_PATH = /(?:^|[\s"'=(:,\[])(?:\/workspace\/|~\/\.capy\/|\$HOME\/\.capy\/)/;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cat40-paths-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('cat40Recorder', () => {
  test('names the gbrain checkout and slot root by role, then scrubs checkout, home and temp paths', () => {
    const record = cat40Recorder('/home/u/.capy/work/gbrain', '/home/u/.capy/work/gbrain-slots', '/home/u', '/var/t');
    expect(record({
      flags: { '--gbrain': '/home/u/.capy/work/gbrain@14ea3e2e', '--gbrain-root': '/home/u/.capy/work/gbrain-slots', '--world': `${ROOT}/eval/data/w.json` },
      ledger: `${ROOT}/.budget/x.sqlite`,
      tail: '[init] Content: /home/u/.capy/work/gbrain-slots/slots-14ea3e2e-7909/slot0/home/.gbrain/content',
      build: '/home/u/.capy/work/gbrain/src/cli.ts',
      other: ['/home/u/notes.txt', '/var/t/run/out.json'],
    })).toEqual({
      flags: { '--gbrain': 'gbrain@14ea3e2e', '--gbrain-root': '<slots>', '--world': 'eval/data/w.json' },
      ledger: '.budget/x.sqlite',
      tail: '[init] Content: <slots>/slots-14ea3e2e-7909/slot0/home/.gbrain/content',
      build: 'gbrain/src/cli.ts',
      other: ['~/notes.txt', '<tmp>/run/out.json'],
    });
  });

  test('binds an experiment.json written before scrubbing to the same experiment', () => {
    const out = tmp();
    const record = cat40Recorder('/home/u/.capy/work/gbrain', '/home/u/.capy/work/gbrain-slots', '/home/u', '/var/t');
    const manifest = { gbrain_commit: 'aaa', slot_commit: 'aaa', world_digest: 'd', models: ['m'], arms: ['gbrain'], label: 'gbrain', flags: { '--gbrain': '/home/u/.capy/work/gbrain@aaa' } };
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'experiment.json'), JSON.stringify({ schema: 'cat40-experiment-v1', ...manifest, budget_run_id: null }, null, 2));
    bindExperiment(out, record(manifest) as typeof manifest, () => null, { scrub: record });
    expect(JSON.parse(readFileSync(join(out, 'experiment.json'), 'utf8')).flags).toEqual({ '--gbrain': 'gbrain@aaa' });
    expect(() => bindExperiment(out, record({ ...manifest, gbrain_commit: 'bbb' }) as typeof manifest, () => null, { scrub: record })).toThrow('different experiment');
  });
});

describe('a scripted run writes no machine path', () => {
  test('every file under --out is free of checkout, home, temp and Capy paths', async () => {
    const out = join(tmp(), 'run');
    const gbrainRoot = join(homedir(), '.capy/work/cat40/gbrain-paths-test');
    await main(['--scripted', '--arms', 'fs', '--tasks', 'A01,B01', '--transcripts', '--gbrain-root', gbrainRoot, '--out', out]);
    const files = readdirSync(out);
    expect(files).toEqual(expect.arrayContaining(['experiment.json', 'results.jsonl', 'transcripts.jsonl', 'run.log']));
    expect(files.some(f => f.startsWith('receipt-'))).toBe(true);
    const offenders = files.filter(f => {
      const text = readFileSync(join(out, f), 'utf8');
      return MACHINE_LOCAL_PATH.test(text) || CAPY_LOCAL_PATH.test(text) || text.includes(ROOT) || text.includes(out);
    });
    expect(offenders).toEqual([]);
    expect(JSON.parse(readFileSync(join(out, 'experiment.json'), 'utf8')).flags['--gbrain-root']).toBe('<slots>');
  });
});
