import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignGuard, campaignStatus, legitimatelyNotRun, readLedger, recordNotRun, type CampaignManifest } from '../../eval/runner/q2/campaign.ts';
import { Q2_EXPORT_ALLOWLIST } from '../../eval/runner/q2/export.ts';
import { stepReceipt } from '../../eval/runner/q2/junk-audit.ts';
import { loadCareerCorpus } from '../../eval/runner/q2/q-set.ts';
import { loadCustodyPages } from '../../eval/runner/line-grammar-typing.ts';
import { loadReceipt, writeReceipt } from '../../eval/runner/receipt.ts';
import { exportAggregates } from '../../eval/runner/sealed-confirmation-lib.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'q2-fix-'));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('g2-sample and label receipts carry run_status (no hand-made wrapper needed)', () => {
  test('a finished step writes a completed receipt the campaign accepts; work left makes it an error with the resume instruction', () => {
    const dir = scratch();
    const ok = stepReceipt('q2-grammar-label', { lines: 3 }, null, { planned: 6, attempted: 6, scored: 5, errors: 1 }, {});
    writeReceipt(join(dir, 'ok.json'), ok);
    expect(loadReceipt(join(dir, 'ok.json'))).toMatchObject({ run_status: 'completed', accounting: { planned: 6, attempted: 6, scored: 5, errors: 1 } });
    const left = stepReceipt('q2-grammar-label', { lines: 3 }, '2 of 6 (line, judge) labels are still retryable or unstarted; rerun the same command to finish them', { planned: 6, attempted: 5, scored: 3, errors: 1 }, {});
    writeReceipt(join(dir, 'left.json'), left);
    expect(loadReceipt(join(dir, 'left.json'))).toMatchObject({ run_status: 'error' });
    const g2 = stepReceipt('q2-g2-sample', { relation_lines: 300 }, null, { planned: 600, attempted: 600, scored: 600, errors: 0 }, {});
    writeReceipt(join(dir, 'g2.json'), g2);
    expect(loadReceipt(join(dir, 'g2.json')).run_status).toBe('completed');
  }, 60_000);
  test('both commands write receipt.json and record it in the campaign', () => {
    const src = readFileSync(join(import.meta.dir, '../../eval/runner/q2/junk-audit.ts'), 'utf8');
    expect(src).not.toContain("campaign?.finish(join(output, 'g2-sample-summary.json')");
    expect(src).not.toContain("campaign?.finish(join(output, 'label-summary.json')");
    expect(src.match(/campaign\?\.finish\(join\(output, 'receipt\.json'\)/g)!.length).toBeGreaterThanOrEqual(4);
  });
});

describe('manifest keys: W manifests keyed pages, career manifests keyed documents', () => {
  test('a W manifest keyed pages is read and hash-checked; both keys at once are refused', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'pages'));
    const page = JSON.stringify({ slug: 'people/alice-example', type: 'person', title: 'Alice', compiled_truth: 'x', timeline: '', _facts: { type: 'person' } });
    writeFileSync(join(dir, 'pages', 'a.json'), page);
    writeFileSync(join(dir, 'w1-manifest.json'), JSON.stringify({ pages: [{ path: 'pages/a.json', sha256: sha(page) }] }));
    expect(loadCustodyPages(dir, { decisionId: 'q2', purpose: 'W1' }).pages.map(p => p.slug)).toEqual(['people/alice-example']);
    writeFileSync(join(dir, 'w1-manifest.json'), JSON.stringify({ pages: [{ path: 'pages/a.json', sha256: sha(page) }], files: [] }));
    expect(() => loadCustodyPages(dir, { decisionId: 'q2', purpose: 'W1' })).toThrow('both files and pages');
  });
  test('a career manifest keyed documents loads like one keyed files', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'e1.md'), 'Subject: hello');
    writeFileSync(join(dir, 'career-manifest.json'), JSON.stringify({ documents: [{ path: 'e1.md', sha256: sha('Subject: hello') }], today: '2026-09-30' }));
    expect(loadCareerCorpus(dir, { decisionId: 'q2', purpose: 'G6' })).toMatchObject({ docs: [{ path: 'e1.md', content: 'Subject: hello' }], today: '2026-09-30' });
    writeFileSync(join(dir, 'career-manifest.json'), JSON.stringify({ today: '2026-09-30' }));
    expect(() => loadCareerCorpus(dir, { decisionId: 'q2', purpose: 'G6' })).toThrow('files or documents');
  });
});

const manifest: CampaignManifest = { schema: 'q2-campaign-v1', decision_id: 'd', approved_usd: 2100, alert_usd: 2800, units: ['U1'], steps: [
  { id: 'grammar-score', title: '', after: [], runs: ['gates'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'g5', title: '', after: [], runs: ['decision'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'g6-answers', title: '', after: ['grammar-score', 'g5'], requires_pass: ['grammar-score', 'g5'], runs: ['amara-A'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'g6-judging', title: '', after: ['g6-answers'], runs: ['amara-A'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'g6-decision', title: '', after: ['g6-judging'], runs: ['decision'], estimate_usd: 0, commands: [], expected: '' },
  { id: 'export', title: '', after: ['g6-decision', 'grammar-score', 'g5'], runs: ['aggregate'], estimate_usd: 0, commands: [], expected: '' },
] };
function record(root: string, step: string, run: string, verdict: string) {
  const h = campaignGuard(['--campaign', root, '--step', step, '--run', run], { manifest })!;
  mkdirSync(h.output, { recursive: true });
  writeFileSync(join(h.output, 'receipt.json'), JSON.stringify({ run_status: 'completed', verdict }));
  h.finish(join(h.output, 'receipt.json'), 0);
}

describe('export when G6 legitimately does not run', () => {
  test('a not-run G6 decision is refused while G1-G5 passed, and recorded when one failed; export then starts', () => {
    const root = scratch();
    record(root, 'grammar-score', 'gates', 'pass');
    record(root, 'g5', 'decision', 'pass');
    expect(legitimatelyNotRun(manifest, readLedger(root), 'g6-decision', root)).toBeNull();
    expect(() => recordNotRun(manifest, root, 'g6-decision', 'decision')).toThrow('must run');
    record(root, 'grammar-score', 'gates', 'fail');
    expect(() => campaignGuard(['--campaign', root, '--step', 'export', '--run', 'aggregate'], { manifest })).toThrow('step g6-decision has no completed receipt');
    const e = recordNotRun(manifest, root, 'g6-decision', 'decision');
    expect(e).toMatchObject({ run_status: 'not_run', spend_usd: 0 });
    expect(e.note).toContain('requires grammar-score to pass, and grammar-score did not pass (gates: fail)');
    const receipt = loadReceipt(join(root, e.receipt));
    expect(receipt.run_status).toBe('not_run');
    expect(receipt.gates![0]).toMatchObject({ gate: 'g6-decision', outcome: 'not_run' });
    expect(campaignGuard(['--campaign', root, '--step', 'export', '--run', 'aggregate'], { manifest })).not.toBeNull();
    expect(campaignStatus(manifest, readLedger(root), root).steps.find(s => s.id === 'g6-decision')!.done).toEqual(['decision']);
    expect(exportAggregates(receipt, Q2_EXPORT_ALLOWLIST).aggregate).toMatchObject({ run_status: 'not_run', gates: [{ gate: 'g6-decision', outcome: 'not_run' }] });
  });
  test('the committed manifest stops the G6 decision when grammar-score fails', async () => {
    const { loadCampaignManifest } = await import('../../eval/runner/q2/campaign.ts');
    const m = loadCampaignManifest();
    const entries = [{ step: 'grammar-score', run: 'gates', receipt: 'x', receipt_sha256: 'x', run_status: 'completed', verdict: 'fail', spend_usd: 0, at: '' }];
    expect(legitimatelyNotRun(m, entries, 'g6-decision')).toContain('grammar-score did not pass');
    expect(legitimatelyNotRun(m, [], 'g6-decision')).toBeNull();
  });
});
