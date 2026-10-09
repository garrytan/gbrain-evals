/**
 * Campaign preflight (runbook step 2): checks the custodian runs before any material is read or any money is spent.
 *
 *   dependencies     bun >= 1.4.0, git, tar and rsync on PATH, the pinned gbrain installed
 *   prices           a verified price for every G6 model and judge (cat40 CHAT_PRICE_OVERRIDES)
 *   provider keys    ANTHROPIC_API_KEY and OPENAI_API_KEY present (names only; values are never read into output)
 *   build identities --baseline and --candidate `<checkout>@<ref>` resolve to commits; SHAs recorded
 *   output roots     the campaign root and every --custody-dir sit outside every git worktree and are writable
 *   access log       each --custody-dir can take an access-log line (checked for writability; nothing is read)
 * The receipt lists each check as a gate; the campaign records it as step `preflight`.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHAT_PRICE_OVERRIDES } from '../budget-ledger.ts';
import { parseGbrainSpec, resolveGbrainUnderTest } from '../gbrain-under-test.ts';
import { p5Receipt } from '../p5-brain.ts';
import { flagValue } from '../p5-agent.ts';
import { provider } from '../cat40/loop.ts';
import { writeReceipt, type GateOutcome } from '../receipt.ts';
import { assertOutsideRepository } from '../sealed-confirmation-lib.ts';
import { campaignGuard, type CampaignManifest } from './campaign.ts';
import { Q2_LINE_JUDGES } from './judge.ts';

/** G6 models (preregistration amendment 4, owner rule 2026-10-07): Fable 5.1 is smoke-test only and never a counted cell. */
export const G6_MODELS: readonly string[] = ['claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-opus-5-5'];
export const G6_JUDGE = 'gpt-6.1-sol';
export const G6_AUDIT_JUDGE = 'claude-opus-5-5';

export interface Check { id: string; ok: boolean; detail: string; fix?: string }

export function bunAtLeast(version: string, min = [1, 4, 0]): boolean {
  const v = version.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((v[i] ?? 0) > min[i]) return true; if ((v[i] ?? 0) < min[i]) return false; }
  return true;
}

export function priceChecks(models: readonly string[]): Check[] {
  return models.map(m => {
    const ok = !!CHAT_PRICE_OVERRIDES[`${provider(m)}:${m}`];
    return { id: `price:${m}`, ok, detail: ok ? 'verified price registered' : 'no verified price', ...(ok ? {} : { fix: `look up ${m}'s published rate and add it to CHAT_PRICE_OVERRIDES in eval/runner/budget-ledger.ts, then rerun preflight` }) };
  });
}

const onPath = (bin: string) => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch { return false; } };

export async function runPreflight(argv: readonly string[], m: CampaignManifest): Promise<void> {
  const campaign = campaignGuard(argv, { manifest: m });
  const checks: Check[] = [];
  checks.push({ id: 'bun', ok: bunAtLeast(Bun.version), detail: `bun ${Bun.version}`, fix: 'run `bun upgrade` (Q2 needs bun >= 1.4.0)' });
  for (const bin of ['git', 'tar', 'rsync']) checks.push({ id: `bin:${bin}`, ok: onPath(bin), detail: bin, fix: `install ${bin}` });
  checks.push({ id: 'gbrain-installed', ok: existsSync(resolve(import.meta.dir, '../../../node_modules/gbrain/package.json')), detail: 'node_modules/gbrain', fix: 'run `bun install --frozen-lockfile`' });
  checks.push(...priceChecks([...new Set([...G6_MODELS, ...Q2_LINE_JUDGES, G6_JUDGE, G6_AUDIT_JUDGE])]));
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) checks.push({ id: `key:${k}`, ok: !!process.env[k], detail: process.env[k] ? 'present' : 'missing', fix: `export ${k} in the custodian's shell` });
  const builds: Record<string, unknown> = {};
  for (const role of ['baseline', 'candidate'] as const) {
    const spec = flagValue(argv, `--${role}`);
    if (!spec) { checks.push({ id: `build:${role}`, ok: false, detail: 'not given', fix: `pass --${role} <gbrain checkout>@<frozen ref>` }); continue; }
    try {
      const { checkout, ref } = parseGbrainSpec(spec);
      const commit = execFileSync('git', ['-C', checkout, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
      builds[role] = { ref, commit };
      checks.push({ id: `build:${role}`, ok: true, detail: `${ref} = ${commit}` });
    } catch (e) { checks.push({ id: `build:${role}`, ok: false, detail: (e as Error).message.slice(0, 200), fix: `check that --${role} names a gbrain checkout and a ref that exists there` }); }
  }
  const dirs = (flagValue(argv, '--custody-dir') ?? '').split(',').filter(Boolean);
  if (!dirs.length) checks.push({ id: 'custody-dirs', ok: false, detail: 'none given', fix: 'pass --custody-dir <dir>[,<dir>...] for every custody directory the campaign reads' });
  for (const d of dirs) {
    let ok = true; let detail = 'outside every git worktree and writable';
    try { assertOutsideRepository(d, '--custody-dir'); if (!existsSync(d) || !statSync(d).isDirectory()) throw new Error(`${d} is not a directory`); accessSync(d, constants.W_OK); if (existsSync(join(d, 'access-log.jsonl'))) accessSync(join(d, 'access-log.jsonl'), constants.W_OK); }
    catch (e) { ok = false; detail = (e as Error).message.slice(0, 300); }
    checks.push({ id: `custody:${d.split('/').slice(-1)[0]}`, ok, detail, ...(ok ? {} : { fix: 'move the custody files outside every checkout and make the directory writable for the access log' }) });
  }
  const gates: GateOutcome[] = checks.map(c => ({ gate: `preflight.${c.id}`, outcome: c.ok ? 'pass' : 'fail', threshold: 'check holds', observed: c.ok ? 1 : 0, denominators: { planned: 1, attempted: 1, scored: 1, errors: 0 }, ...(c.ok ? {} : { failed_threshold: c.detail, reason: c.fix }) }));
  const out = campaign?.output ?? flagValue(argv, '--output');
  if (!out) throw new Error('preflight needs --campaign <root> --step preflight --run preflight, or --output <dir>');
  const receipt = p5Receipt({ category: 'q2-preflight', gut: resolveGbrainUnderTest(null), startedAt: new Date().toISOString(), rows: checks.map(c => ({ ...c })), summary: { builds, failed: checks.filter(c => !c.ok).map(c => c.id) }, harnessError: null, gates, basis: 'no model call', resolvedConfig: { g6_models: G6_MODELS, line_judges: Q2_LINE_JUDGES, g6_judge: G6_JUDGE, audit_judge: G6_AUDIT_JUDGE } });
  writeReceipt(join(out, 'receipt.json'), receipt);
  campaign?.finish(join(out, 'receipt.json'), 0);
  for (const c of checks) process.stderr.write(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}${c.ok || !c.fix ? '' : ` -> ${c.fix}`}\n`);
  if (checks.some(c => !c.ok)) process.exitCode = 3;
}
