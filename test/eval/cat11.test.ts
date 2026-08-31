/**
 * cat11-multimodal.ts tests — post-audit rewrite.
 *
 * Hermetic (no API keys, no network): text modalities go through gbrain's
 * real importFromContent with noEmbed, in-memory PGLite; audio uses an
 * injected transcriber stub.
 *
 * Regression coverage for the audit findings this runner owned:
 *   - retrieval-cats-03: all-skipped can no longer pass — report verdict
 *     'skipped', CLI exits 2 (0 only with --allow-skip), receipt says skipped.
 *   - retrieval-cats-10: failed items stay in the mean (sut origin, scored 0);
 *     an all-failing transcriber now means WORST fidelity, not a perfect WER.
 *   - retrieval-cats-11: thresholds are enforced — bad input produces
 *     verdict 'fail' and exit 1; good committed fixtures produce 'pass'.
 *   - retrieval-cats-12: the scored artifact is gbrain's indexed output
 *     (chunks read back from the engine), not a harness extractor.
 *   - retrieval-cats-15: audio per_item carries the provider string.
 *   - retrieval-cats-18: manifest sha256 is verified; mismatches become
 *     harness errors excluded from the mean and kill publishability.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import {
  wordRecall,
  wer,
  runCat11,
  main,
  THRESHOLDS,
} from '../../eval/runner/cat11-multimodal.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const COMMITTED_FIXTURES = join(REPO_ROOT, 'eval/data/multimodal');

function tmpRoot(): string {
  const dir = join(tmpdir(), `cat11-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Write a source + canonical pair and return a manifest item with real hashes. */
function writeFixture(dir: string, name: string, ext: string, source: string, canonical: string) {
  writeFileSync(join(dir, `${name}.${ext}`), source);
  writeFileSync(join(dir, `${name}.txt`), canonical);
  return {
    name,
    path: `${name}.${ext}`,
    canonical_path: `${name}.txt`,
    sha256: sha256(source),
    canonical_sha256: sha256(canonical),
  };
}

function writeManifest(dir: string, items: unknown[]): void {
  writeFileSync(join(dir, 'fixtures.json'), JSON.stringify({ version: 1, license: 'synthetic', items }));
}

// ─── Pure math helpers ────────────────────────────────────────────────

describe('wordRecall', () => {
  test('all canonical words present → 1', () => {
    expect(wordRecall('the quick brown fox', 'the lazy fox jumped over the quick brown dog')).toBe(1);
  });

  test('none present → 0', () => {
    expect(wordRecall('one two three', 'alpha beta gamma')).toBe(0);
  });

  test('empty canonical → 1 (trivially satisfied)', () => {
    expect(wordRecall('', 'anything')).toBe(1);
  });

  test('multiset semantics: three "the" vs one "the" → 1/3', () => {
    expect(wordRecall('the the the', 'the cat')).toBeCloseTo(1 / 3, 6);
  });

  test('case-insensitive + strips punctuation', () => {
    expect(wordRecall('Hello, world!', 'hello world')).toBe(1);
  });
});

describe('wer', () => {
  test('perfect transcription → 0', () => {
    expect(wer('hello world', 'hello world')).toBe(0);
  });

  test('one word wrong → 0.5 on 2-word reference', () => {
    expect(wer('hello world', 'hello there')).toBe(0.5);
  });

  test('empty reference vs empty hypothesis → 0', () => {
    expect(wer('', '')).toBe(0);
  });

  test('empty reference + non-empty hypothesis → 1', () => {
    expect(wer('', 'anything')).toBe(1);
  });

  test('completely wrong → 1', () => {
    expect(wer('one two three', 'alpha beta gamma')).toBe(1);
  });
});

// ─── Committed fixture set: the real gate passes on good input ────────

describe('runCat11 on the committed fixture set (hermetic, real gbrain ingest)', () => {
  test('markdown + html run through gbrain and pass their thresholds', async () => {
    const { report, accounting, control_failures } = await runCat11({ fixturesRoot: COMMITTED_FIXTURES });

    const md = report.results.markdown;
    expect(md.skipped).toBe(false);
    expect(md.items).toBe(3);
    expect(md.items_scored).toBe(3);
    expect(md.mean_metric).not.toBeNull();
    expect(md.mean_metric!).toBeGreaterThanOrEqual(THRESHOLDS.markdown);
    expect(md.verdict).toBe('pass');
    // The scored artifact is gbrain's index: chunks actually landed.
    for (const item of md.per_item) {
      expect(item.detail!.chunks).toBeGreaterThan(0);
    }

    const html = report.results.html;
    expect(html.skipped).toBe(false);
    expect(html.items).toBe(2);
    expect(html.mean_metric!).toBeGreaterThanOrEqual(THRESHOLDS.html);
    expect(html.verdict).toBe('pass');

    // pdf + audio are declared skips with real reasons — never silent passes.
    expect(report.results.pdf.skipped).toBe(true);
    expect(report.results.pdf.skip_reason).toContain('no PDF');
    expect(report.results.audio.skipped).toBe(true);
    expect(report.results.audio.skip_reason).toContain('not committed');

    expect(report.verdict).toBe('pass');

    // Negative control: truncated ingest through the SAME pipeline craters.
    for (const mod of [md, html]) {
      expect(mod.negative_control).toBeDefined();
      expect(mod.negative_control!.degradation_ok).toBe(true);
      expect(mod.negative_control!.control_mean).toBeLessThanOrEqual(0.5 * mod.negative_control!.real_mean);
    }
    expect(control_failures).toEqual([]);

    // Accounting: 5 planned probes, 5 scored, no errors, publishable.
    expect(accounting.n_total).toBe(5);
    expect(accounting.n_scored).toBe(5);
    expect(accounting.errors).toEqual([]);
    expect(accounting.publishable).toBe(true);
    expect(accounting.run_invalid).toBe(false);
  }, 120_000);
});

// ─── The gate can FAIL: bad input → verdict fail ──────────────────────

describe('threshold gate is failable (retrieval-cats-11)', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('canonical words absent from the source → modality + report fail', async () => {
    const htmlDir = join(root, 'html');
    mkdirSync(htmlDir, { recursive: true });
    const item = writeFixture(
      htmlDir,
      'mismatch',
      'html',
      '<html><body><p>entirely unrelated prose about garden tools and rain</p></body></html>',
      'zymurgy quokka xylophone phlogiston brachiation',
    );
    writeManifest(htmlDir, [item]);

    const { report } = await runCat11({ fixturesRoot: root });
    expect(report.results.html.skipped).toBe(false);
    expect(report.results.html.mean_metric).toBe(0);
    expect(report.results.html.verdict).toBe('fail');
    expect(report.verdict).toBe('fail');
  }, 120_000);
});

// ─── sha256 verification (retrieval-cats-18) ──────────────────────────

describe('fixture integrity', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('sha256 mismatch → harness error, excluded from mean, not publishable', async () => {
    const htmlDir = join(root, 'html');
    mkdirSync(htmlDir, { recursive: true });
    const good = writeFixture(
      htmlDir,
      'good',
      'html',
      '<html><body><p>alpha beta gamma delta epsilon</p></body></html>',
      'alpha beta gamma delta epsilon',
    );
    const corrupt = writeFixture(
      htmlDir,
      'corrupt',
      'html',
      '<html><body><p>original words here</p></body></html>',
      'original words here',
    );
    corrupt.sha256 = 'deadbeef'.repeat(8); // manifest says one thing, disk says another
    writeManifest(htmlDir, [good, corrupt]);

    const { report, accounting } = await runCat11({ fixturesRoot: root });
    const html = report.results.html;
    expect(html.items).toBe(2);
    expect(html.items_scored).toBe(1); // corrupt item excluded, not silently scored
    expect(html.mean_metric).toBe(1); // mean over the one verified item
    const corruptRow = html.per_item.find(p => p.name === 'corrupt')!;
    expect(corruptRow.metric).toBeNull();
    expect(corruptRow.origin).toBe('harness');
    expect(corruptRow.error).toContain('sha256 mismatch');

    expect(accounting.errors).toHaveLength(1);
    expect(accounting.errors[0].origin).toBe('harness');
    // Smoke-size run (< 10) with an infra error must never be publishable.
    expect(accounting.publishable).toBe(false);
  }, 120_000);
});

// ─── Failed items stay in the mean (retrieval-cats-10 / directive c) ──

describe('audio accounting: sut failures fold into the mean as worst score', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function audioManifest(dir: string, names: string[]) {
    mkdirSync(dir, { recursive: true });
    const items = names.map(n => {
      const src = `fake audio bytes for ${n}`;
      const canonical = 'hello world this is a test';
      writeFileSync(join(dir, `${n}.mp3`), src);
      writeFileSync(join(dir, `${n}.txt`), canonical);
      return {
        name: n,
        path: `${n}.mp3`,
        canonical_path: `${n}.txt`,
        sha256: sha256(src),
        canonical_sha256: sha256(canonical),
      };
    });
    writeManifest(dir, items);
  }

  test('one perfect clip + one throwing clip → mean 0.5, verdict fail, sut error recorded', async () => {
    audioManifest(join(root, 'audio'), ['ok', 'boom']);
    const transcribe = async (path: string) => {
      if (path.includes('boom')) throw new Error('decoder exploded');
      return { text: 'hello world this is a test', provider: 'stub-whisper' };
    };

    const { report, accounting } = await runCat11({ fixturesRoot: root, transcribeAudio: transcribe });
    const audio = report.results.audio;
    expect(audio.skipped).toBe(false);
    expect(audio.items_scored).toBe(2); // the failure is IN the denominator
    expect(audio.mean_metric).toBe(0.5); // (1 + 0) / 2 — not 1.0
    expect(audio.verdict).toBe('fail');

    const boom = audio.per_item.find(p => p.name === 'boom')!;
    expect(boom.metric).toBe(0);
    expect(boom.origin).toBe('sut');
    expect(accounting.errors.some(e => e.origin === 'sut' && e.probe_id === 'audio:boom')).toBe(true);

    // provider identity is the string, not its length (retrieval-cats-15)
    const ok = audio.per_item.find(p => p.name === 'ok')!;
    expect(ok.provider).toBe('stub-whisper');
    expect(ok.detail!.wer).toBe(0);
  }, 120_000);

  test('transcriber failing on EVERY clip → mean 0 (worst), never a perfect score', async () => {
    audioManifest(join(root, 'audio'), ['a', 'b']);
    const transcribe = async () => { throw new Error('always down'); };

    const { report } = await runCat11({ fixturesRoot: root, transcribeAudio: transcribe });
    const audio = report.results.audio;
    // Pre-audit code reported mean WER 0 here — which read as PERFECT.
    // Fidelity semantics: all failures → 0, the worst possible value.
    expect(audio.mean_metric).toBe(0);
    expect(audio.verdict).toBe('fail');
  }, 120_000);

  test('audio without keys or stub → skipped with reason, never scored', async () => {
    audioManifest(join(root, 'audio'), ['clip']);
    const savedGroq = process.env.GROQ_API_KEY;
    const savedOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const { report } = await runCat11({ fixturesRoot: root });
      expect(report.results.audio.skipped).toBe(true);
      expect(report.results.audio.skip_reason).toContain('GROQ_API_KEY');
    } finally {
      if (savedGroq !== undefined) process.env.GROQ_API_KEY = savedGroq;
      if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    }
  }, 120_000);
});

// ─── All-skipped is loud (retrieval-cats-03) ──────────────────────────

describe('all-skipped semantics', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('empty fixtures root → report verdict skipped', async () => {
    const { report, accounting } = await runCat11({ fixturesRoot: root });
    expect(report.verdict).toBe('skipped');
    expect(accounting.n_total).toBe(0);
    for (const r of Object.values(report.results)) {
      expect(r.skipped).toBe(true);
      expect(r.skip_reason).toBeTruthy();
    }
  });

  test('CLI exits 2 on all-skipped without --allow-skip, receipt says skipped', () => {
    const receiptFile = join(root, 'receipt.json');
    const reportFile = join(root, 'report.json');
    const proc = Bun.spawnSync(
      ['bun', 'eval/runner/cat11-multimodal.ts',
        '--fixtures-root', join(root, 'nothing-here'),
        '--receipt-path', receiptFile,
        '--report-path', reportFile],
      { cwd: REPO_ROOT, env: { ...process.env, GROQ_API_KEY: undefined, OPENAI_API_KEY: undefined } as Record<string, string | undefined> },
    );
    expect(proc.exitCode).toBe(2);
    expect(existsSync(receiptFile)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt.run_status).toBe('skipped');
    expect(receipt.skip_reason).toBeTruthy();
    expect(receipt.publishable).toBe(false);
  }, 60_000);

  test('CLI exits 0 on all-skipped only with explicit --allow-skip', () => {
    const receiptFile = join(root, 'receipt.json');
    const proc = Bun.spawnSync(
      ['bun', 'eval/runner/cat11-multimodal.ts',
        '--fixtures-root', join(root, 'nothing-here'),
        '--receipt-path', receiptFile,
        '--report-path', join(root, 'report.json'),
        '--allow-skip'],
      { cwd: REPO_ROOT, env: { ...process.env, GROQ_API_KEY: undefined, OPENAI_API_KEY: undefined } as Record<string, string | undefined> },
    );
    expect(proc.exitCode).toBe(0);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt.run_status).toBe('skipped'); // acknowledged, but never a pass
  }, 60_000);
});

// ─── main() exit-code + receipt wiring ────────────────────────────────

describe('main() receipt + exit codes', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('failing fixtures → returns 1, receipt completed/fail', async () => {
    const htmlDir = join(root, 'fixtures/html');
    mkdirSync(htmlDir, { recursive: true });
    const item = writeFixture(
      htmlDir,
      'mismatch',
      'html',
      '<html><body><p>totally different content lives in this page body</p></body></html>',
      'zymurgy quokka xylophone phlogiston brachiation',
    );
    writeManifest(htmlDir, [item]);
    const receiptFile = join(root, 'receipt.json');

    const code = await main([
      '--fixtures-root', join(root, 'fixtures'),
      '--receipt-path', receiptFile,
      '--report-path', join(root, 'report.json'),
    ]);
    expect(code).toBe(1);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('fail');
    expect(receipt.gbrain_version).not.toBe('unknown');
  }, 120_000);

  test('committed fixtures → returns 0, receipt completed/pass with resolved_config', async () => {
    const receiptFile = join(root, 'receipt.json');
    const code = await main([
      '--fixtures-root', COMMITTED_FIXTURES,
      '--receipt-path', receiptFile,
      '--report-path', join(root, 'report.json'),
    ]);
    expect(code).toBe(0);
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
    expect(receipt.run_status).toBe('completed');
    expect(receipt.verdict).toBe('pass');
    expect(receipt.n_total).toBe(5);
    expect(receipt.n_scored).toBe(5);
    expect(receipt.resolved_config.modalities_run).toEqual(['markdown', 'html']);
    expect(receipt.resolved_config.search_mode).toContain('not-exercised');
    expect(receipt.data.modalities.markdown.negative_control.degradation_ok).toBe(true);
  }, 120_000);
});
