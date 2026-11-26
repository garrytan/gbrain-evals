#!/usr/bin/env bun
/**
 * Multi-writer behavior suite: does gbrain keep data right when several writers use one brain at once?
 *
 * A free, keyless, black-box check (no model or embedding calls; invented data only; a scratch brain per run). Each
 * check runs the same scenario with writers in separate processes (every operation its own `gbrain call` process) and
 * with in-process writers (concurrent lanes on one open engine), on PGLite, Postgres or Rust, then reads the brain back:
 *
 *   c1 lost updates        concurrent tags, rewrites and facts on one page and one entity
 *   c2 duplicate pages     concurrent creates of one slug (and its case and .md variants)
 *   c3 links               concurrent add_link to one target while the target is rewritten
 *   c4 timeline            concurrent entries: all present once, in date order, per-writer times never backward;
 *                          on Rust also across a store-owner takeover (the owner process is killed halfway)
 *   c5 deletion            a purge while other writers keep writing the page; nothing of it may remain
 *   c6 facts               a forgotten fact and the facts of a deleted entity page never come back
 *   c7 access              through `gbrain serve --http` with member credentials: a labelled-only member cannot
 *                          write an unlabelled page, a private page never shows in another member's keyword search, a
 *                          hidden page answers like a missing one, out-of-range numbers (compared across engines), and
 *                          the refusal for re-remembering a forgotten fact
 *   c8 latency             p50/p95 put latency, reported and never judged
 *
 * Verdicts are pass, fail (wrong data, or an error that is not a typed refusal), not_supported (the engine refused the
 * step by name: the expected fail-closed answer on Rust until its multi-user lanes land) and invalid (classify.ts).
 *
 * The engine comes from GBRAIN_EVAL_ENGINE=pglite|postgres|rust (eval/runner/eval-engine.ts), the gbrain build from
 * `--gbrain <checkout>@<ref>` (a verified copied overlay, gbrain-under-test.ts), Postgres from `--pg-url` or
 * LIFECYCLE_PG_URL (a local pgvector server; each run creates and drops its own database). On Rust, `--switch on|off`
 * sets GBRAIN_RUST_MULTIUSER for every child exactly (on is `1`, off is unset) and the run must prove the mode from
 * the running engine: a probe process opens the store as its owner and reports the store's own multi-user answer and
 * whether a session probe reaches the store's token check, which only a multi-user store does. A switch-on run without
 * that proof is invalid, never a pass.
 *
 *   bun eval/runner/multi-writer-behavior.ts run --gbrain <checkout>@<ref> [--switch on|off] [--pg-url <url>]
 *       [--writers 4] [--rounds 4] [--checks c1,c4] [--out <dir>]
 *   bun eval/runner/multi-writer-behavior.ts matrix --gbrain-clone <path> --ref <branch|sha> [--baseline-ref master]
 *       --pg-url <url> [--cargo-target <dir>] [--out <dir>]
 *   bun eval/runner/multi-writer-behavior.ts report <receipt.json> [...]
 *   bun eval/runner/multi-writer-behavior.ts parity <a.json> <b.json>
 *
 * `matrix` fetches the ref (and the baseline) in the clone, records the SHAs, builds each Rust addon from the same
 * commit, and runs PGLite, Postgres, Rust with the switch on and Rust with it unset, then Rust at the baseline with the
 * switch unset, and compares the switch-off run's serial transcript with the baseline's byte for byte. Receipts and a
 * Markdown summary go to eval/reports/multi-writer/<date>/ by default.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evalEngineKind, rustAddonIdentity, type EvalEngineKind } from './eval-engine.ts';
import { gbrainSpecFrom, overlaySummary, resolveGbrainUnderTest, OVERLAY_ROOT, type GbrainUnderTest } from './gbrain-under-test.ts';
import { createBrain, operatorCalls, runWriters, type SwitchSetting } from './multi-writer/brain.ts';
import { judgeSwitch, normalizeForParity, type Status, type SwitchProof } from './multi-writer/classify.ts';
import { checkAccess, checkDeletion, checkDuplicates, checkFacts, checkLinks, checkLostUpdates, checkTimeline, measureLatency, SERIAL_SCRIPT, type CheckResult, type Ctx } from './multi-writer/scenarios.ts';

const REPO = resolve(import.meta.dir, '../..');
export const SCHEMA = 'gbrain-evals.multi-writer-behavior.v1';

const CHECKS: Record<string, (ctx: Ctx) => Promise<CheckResult>> = {
  c1: checkLostUpdates, c2: checkDuplicates, c3: checkLinks, c4: checkTimeline, c5: checkDeletion, c6: checkFacts, c7: checkAccess,
};

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

export interface Receipt {
  schema: typeof SCHEMA;
  started_at: string;
  finished_at: string;
  engine: EvalEngineKind;
  switch_requested: SwitchSetting | null;
  gbrain: { version: string; commit: string | null; overlay: Record<string, unknown> | null; rust_addon: unknown };
  gbrain_evals_commit: string | null;
  writers: number;
  rounds: number;
  config: Record<string, unknown>;
  switch_proof: SwitchProof;
  status_by_check: Record<string, Status>;
  checks: CheckResult[];
  latency: Record<string, unknown>;
  write_lock_bug_failures: number;
  serial: { sha256: string; transcript: unknown };
}

const gitHead = (dir: string) => { try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } };

async function probe(gut: GbrainUnderTest, brain: Awaited<ReturnType<typeof createBrain>>): Promise<Record<string, unknown>> {
  const r = await runWriters(brain, gut, [{ mode: 'engine', lanes: [], probe: true }]);
  return (r.ready[0]?.probe as Record<string, unknown> | undefined) ?? { start_error: r.startErrors[0] ?? 'no ready line' };
}

export async function runArm(o: { gut: GbrainUnderTest; kind: EvalEngineKind; switchSetting: SwitchSetting; pgAdminUrl?: string; writers: number; rounds: number; checks: string[]; log: (s: string) => void }): Promise<Receipt> {
  const started = new Date().toISOString();
  // The serial transcript runs alone on its own fresh brain, so its ids and order are the same on every build.
  const serialBrain = await createBrain({ gut: o.gut, kind: o.kind, switchSetting: o.switchSetting, pgAdminUrl: o.pgAdminUrl, label: 'mwserial' });
  let serial: Receipt['serial'];
  try {
    const r = await operatorCalls(serialBrain, o.gut, SERIAL_SCRIPT);
    const transcript = normalizeForParity(r.ops.map(l => ({ tag: l.tag, op: l.op, ok: l.ok, code: l.code ?? null, result: l.ok ? l.result : null })), [serialBrain.work, serialBrain.home]);
    serial = { sha256: createHash('sha256').update(JSON.stringify(transcript)).digest('hex'), transcript };
  } finally { await serialBrain.close(); }
  const brain = await createBrain({ gut: o.gut, kind: o.kind, switchSetting: o.switchSetting, pgAdminUrl: o.pgAdminUrl, label: 'mwbehavior' });
  const probes: Array<Record<string, unknown>> = [];
  const checks: CheckResult[] = [];
  let latency: Record<string, unknown> = {};
  try {
    probes.push({ when: 'before', ...await probe(o.gut, brain) });
    const ctx: Ctx = { gut: o.gut, brain, writers: o.writers, rounds: o.rounds, log: o.log };
    let putMs: number[] = [];
    for (const id of o.checks) {
      const fn = CHECKS[id];
      if (!fn) continue;
      o.log(`[mw] ${o.kind}${o.kind === 'rust' ? ` switch=${o.switchSetting}` : ''}: ${id}`);
      const mark = brain.stderrLog.length;
      const attachStderr = (c: CheckResult) => {
        const seen = new Map<string, number>();
        for (const t of brain.stderrLog.slice(mark)) { const k = t.slice(-4000); seen.set(k, (seen.get(k) ?? 0) + 1); }
        if (seen.size) c.writer_stderr = [...seen].slice(0, 40).map(([text, count]) => ({ count, text }));
        return c;
      };
      try {
        const r = await fn(ctx);
        if (id === 'c1') putMs = ((r.latency?.put_ms as number[] | undefined) ?? []);
        checks.push(attachStderr(r));
      } catch (e) {
        checks.push({ id, title: id, status: 'fail', phases: [{ phase: 'processes', status: 'fail', tally: { total: 0, acked: 0, refused: {}, errors: { harness: { count: 1, sample: String((e as Error).message).slice(0, 400) } }, pending_never_applied: 0, write_lock_bug: 0, conflicts: {}, handoff: {} }, findings: [], notes: ['the check threw; see errors.harness'] }] });
        attachStderr(checks.at(-1)!);
      }
    }
    latency = await measureLatency(ctx, putMs);
    probes.push({ when: 'after', ...await probe(o.gut, brain) });
  } finally { await brain.close(); }
  const proof = judgeSwitch(o.kind, o.switchSetting, probes);
  const invalid = proof.verdict === 'invalid';
  for (const c of checks) { if (invalid) c.status = 'invalid'; delete c.latency; }
  const status_by_check: Record<string, Status> = Object.fromEntries(checks.map(c => [c.id, c.status]));
  return {
    schema: SCHEMA, started_at: started, finished_at: new Date().toISOString(), engine: o.kind,
    switch_requested: o.kind === 'rust' ? o.switchSetting : null,
    gbrain: { version: o.gut.version, commit: o.gut.overlay?.build.commit ?? gitHead(o.gut.root), overlay: overlaySummary(o.gut), rust_addon: o.kind === 'rust' ? rustAddonIdentity(o.gut) : null },
    gbrain_evals_commit: gitHead(REPO), writers: o.writers, rounds: o.rounds,
    config: { embedding_disabled: true, schema_pack: 'gbrain-base-v2', note: 'the same config on every engine; only the store location differs' },
    switch_proof: proof, status_by_check, checks, latency,
    write_lock_bug_failures: checks.reduce((n, c) => n + c.phases.reduce((m, p) => m + p.tally.write_lock_bug, 0), 0),
    serial,
  };
}

// ─── Report ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function armLabel(r: Pick<Receipt, 'engine' | 'switch_requested' | 'gbrain'>): string {
  return r.engine === 'rust' ? `Rust ${r.switch_requested === 'on' ? 'on' : 'off'} @${(r.gbrain.commit ?? '?').slice(0, 10)}` : `${r.engine === 'pglite' ? 'PGLite' : 'Postgres'} @${(r.gbrain.commit ?? '?').slice(0, 10)}`;
}

/** Markdown: the per-check table, cross-engine differences of check 7, the switch proof and latency of every receipt. */
export function renderReport(receipts: Receipt[], parity?: { a: string; b: string; identical: boolean; firstDiff?: string }): string {
  const ids = [...new Set(receipts.flatMap(r => r.checks.map(c => c.id)))];
  const titles = new Map(receipts.flatMap(r => r.checks.map(c => [c.id, c.title] as const)));
  const cell = (r: Receipt, id: string) => {
    const c = r.checks.find(x => x.id === id);
    if (!c) return 'not run';
    const per = c.phases.map(p => `${p.phase}:${p.status}`).join(', ');
    const bug = c.phases.reduce((n, p) => n + p.tally.write_lock_bug, 0);
    return `**${c.status}** (${per}${bug ? `; write-lock bug ${bug}` : ''})`;
  };
  const lines = [`| Check | ${receipts.map(armLabel).join(' | ')} |`, `|---|${receipts.map(() => '---').join('|')}|`];
  for (const id of ids) lines.push(`| ${titles.get(id)} | ${receipts.map(r => cell(r, id)).join(' | ')} |`);
  lines.push(`| Latency (reported only) | ${receipts.map(r => { const s = r.latency.serial_put as Record<string, unknown> | undefined; const c = r.latency.concurrent_put as Record<string, unknown> | undefined; return `serial p50 ${s?.p50_ms ?? 'n/a'} / p95 ${s?.p95_ms ?? 'n/a'} ms; concurrent p50 ${c?.p50_ms ?? 'n/a'} / p95 ${c?.p95_ms ?? 'n/a'} ms`; }).join(' | ')} |`);
  const out = ['## Results', '', ...lines, ''];
  out.push('## Switch proof', '');
  for (const r of receipts) out.push(`- ${armLabel(r)}: ${r.switch_proof.verdict} (${r.switch_proof.reason})`);
  const keys = [...new Set(receipts.flatMap(r => Object.keys(r.checks.find(c => c.id === 'c7_access')?.cross_engine ?? {})))];
  if (keys.length) {
    out.push('', '## Check 7 outcomes across engines', '', `| Input | ${receipts.map(armLabel).join(' | ')} | Same? |`, `|---|${receipts.map(() => '---').join('|')}|---|`);
    for (const k of keys) {
      const vals = receipts.map(r => r.checks.find(c => c.id === 'c7_access')?.cross_engine?.[k] ?? 'not run');
      const ran = vals.filter(v => v !== 'not run');
      out.push(`| ${k} | ${vals.map(v => v.replace(/\|/g, '/')).join(' | ')} | ${new Set(ran).size <= 1 ? 'yes' : '**DIFFERENT**'} |`);
    }
  }
  out.push('', '## Findings (wrong data and errors)', '');
  for (const r of receipts) for (const c of r.checks) for (const p of c.phases) {
    const errs = Object.entries(p.tally.errors).map(([k, v]) => `${k} x${v.count}: ${v.sample.slice(0, 160)}`);
    const refused = Object.entries(p.tally.refused).map(([k, v]) => `${k} x${v}`);
    const conflicts = Object.entries(p.tally.conflicts ?? {}).map(([k, v]) => `${k} x${v}`);
    const handoff = Object.entries(p.tally.handoff ?? {}).map(([k, v]) => `${k} x${v}`);
    if (p.findings.length || errs.length || refused.length || conflicts.length || handoff.length) out.push(`- ${armLabel(r)} ${c.id} ${p.phase}: ${[...p.findings, ...errs.map(e => `error ${e}`), ...(refused.length ? [`refused ${refused.join(', ')}`] : []), ...(handoff.length ? [`store owner went away or refused this process (outcome unknown): ${handoff.join(', ')}`] : []), ...(conflicts.length ? [`lost races, told so (not wrong data): ${conflicts.join(', ')}`] : [])].join('; ')}`);
  }
  if (parity) out.push('', '## Switch-off parity', '', `- serial transcript ${parity.a} vs ${parity.b}: ${parity.identical ? 'byte-identical' : `DIFFERENT (${parity.firstDiff})`}`);
  return `${out.join('\n')}\n`;
}

export function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = firstDifference(a[i], b[i], `${path}[${i}]`); if (d) return d; }
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) { const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`); if (d) return d; }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 160)} vs ${JSON.stringify(b)?.slice(0, 160)}`;
}

// ─── Matrix ───────────────────────────────────────────────────────────────────────────────────────────────────────

function fetchRef(clone: string, ref: string): string {
  if (/^[0-9a-f]{40}$/.test(ref)) { spawnSync('git', ['-C', clone, 'fetch', '-q', 'origin', ref]); return ref; }
  execFileSync('git', ['-C', clone, 'fetch', '-q', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`]);
  return execFileSync('git', ['-C', clone, 'rev-parse', `refs/remotes/origin/${ref}^{commit}`], { encoding: 'utf8' }).trim();
}

/** Build the Rust addon from the overlay's own sources and keep it outside the overlay, so the overlay still verifies. */
function buildAddon(gut: GbrainUnderTest, cargoTarget: string, log: (s: string) => void): string {
  const sha = gut.overlay?.build.commit ?? 'local';
  const dest = join(OVERLAY_ROOT, 'addons', `gbrain_engine-${sha}.node`);
  if (existsSync(dest)) return dest;
  log(`[mw] building the Rust addon at ${sha.slice(0, 10)}`);
  // The build runs code from the ref under test, so it gets the toolchain's variables and nothing else (no provider key).
  const env: Record<string, string> = { CARGO_TARGET_DIR: cargoTarget };
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'CARGO_HOME', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'CC', 'CXX']) if (process.env[k]) env[k] = process.env[k]!;
  const r = spawnSync('bun', ['run', 'rust:build'], { cwd: gut.root, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const built = /GBRAIN_RUST_ENGINE_ADDON=(\S+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  if (r.status !== 0 || !built) throw new Error(`rust:build at ${sha} failed: ${`${r.stderr}${r.stdout}`.trim().split('\n').slice(-5).join(' | ')}`);
  mkdirSync(join(OVERLAY_ROOT, 'addons'), { recursive: true });
  copyFileSync(built, dest);
  rmSync(join(gut.root, 'rust', 'target'), { recursive: true, force: true });
  return dest;
}

async function matrix(argv: string[], log: (s: string) => void): Promise<void> {
  const clone = resolve(flag(argv, '--gbrain-clone') ?? '');
  const ref = flag(argv, '--ref');
  const baselineRef = flag(argv, '--baseline-ref') ?? 'master';
  const pgAdminUrl = flag(argv, '--pg-url') ?? process.env.LIFECYCLE_PG_URL;
  const cargoTarget = resolve(flag(argv, '--cargo-target') ?? join(OVERLAY_ROOT, 'cargo-target'));
  if (!ref || !existsSync(clone)) throw new Error('matrix needs --gbrain-clone <path> and --ref <branch|sha>');
  const out = resolve(flag(argv, '--out') ?? join(REPO, 'eval/reports/multi-writer', new Date().toISOString().slice(0, 10)));
  mkdirSync(out, { recursive: true });
  const sha = fetchRef(clone, ref);
  const baseSha = fetchRef(clone, baselineRef);
  log(`[mw] ${ref} = ${sha}; ${baselineRef} = ${baseSha}`);
  // Default arms: the four the suite reports plus Rust at the baseline; the PGLite and Postgres baselines run on request.
  const arms: Array<{ name: string; sha: string; kind: EvalEngineKind; sw: SwitchSetting }> = [
    { name: 'pglite', sha, kind: 'pglite', sw: 'off' },
    { name: 'postgres', sha, kind: 'postgres', sw: 'off' },
    { name: 'rust-on', sha, kind: 'rust', sw: 'on' },
    { name: 'rust-off', sha, kind: 'rust', sw: 'off' },
    { name: 'rust-baseline-off', sha: baseSha, kind: 'rust', sw: 'off' },
    { name: 'pglite-baseline', sha: baseSha, kind: 'pglite', sw: 'off' },
    { name: 'postgres-baseline', sha: baseSha, kind: 'postgres', sw: 'off' },
  ];
  const only = flag(argv, '--arms')?.split(',') ?? ['pglite', 'postgres', 'rust-on', 'rust-off', 'rust-baseline-off'];
  const receipts: Record<string, Receipt> = {};
  for (const arm of arms.filter(a => only.includes(a.name))) {
    const gut = resolveGbrainUnderTest(`${clone}@${arm.sha}`);
    const env = { ...process.env };
    if (arm.kind === 'rust') process.env.GBRAIN_RUST_ENGINE_ADDON = buildAddon(gut, cargoTarget, log);
    const r = await runArm({ gut, kind: arm.kind, switchSetting: arm.sw, pgAdminUrl, writers: Number(flag(argv, '--writers') ?? 4), rounds: Number(flag(argv, '--rounds') ?? 4), checks: (flag(argv, '--checks') ?? Object.keys(CHECKS).join(',')).split(','), log });
    process.env.GBRAIN_RUST_ENGINE_ADDON = env.GBRAIN_RUST_ENGINE_ADDON;
    if (env.GBRAIN_RUST_ENGINE_ADDON === undefined) delete process.env.GBRAIN_RUST_ENGINE_ADDON;
    receipts[arm.name] = r;
    writeFileSync(join(out, `${arm.name}.json`), `${JSON.stringify(r, null, 2)}\n`);
    log(`[mw] ${arm.name}: ${JSON.stringify(r.status_by_check)} proof=${r.switch_proof.verdict}`);
  }
  const off = receipts['rust-off'];
  const base = receipts['rust-baseline-off'];
  const parity = off && base ? { a: `rust-off @${sha.slice(0, 10)}`, b: `rust @${baselineRef} ${baseSha.slice(0, 10)}`, identical: off.serial.sha256 === base.serial.sha256, firstDiff: firstDifference(off.serial.transcript, base.serial.transcript) ?? undefined } : undefined;
  const ordered = arms.map(a => receipts[a.name]).filter((r): r is Receipt => !!r);
  const md = `# Multi-writer behavior: ${ref} ${sha}\n\nBaseline ${baselineRef} ${baseSha}; gbrain-evals ${gitHead(REPO)}.\n\n${renderReport(ordered, parity)}`;
  writeFileSync(join(out, 'summary.md'), md);
  if (parity) writeFileSync(join(out, 'parity.json'), `${JSON.stringify(parity, null, 2)}\n`);
  console.log(md);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const log = (s: string) => console.error(s);
  const cmd = argv[0];
  if (cmd === 'report') {
    console.log(renderReport(argv.slice(1).map(f => JSON.parse(readFileSync(f, 'utf8')) as Receipt)));
    return;
  }
  if (cmd === 'matrix') { await matrix(argv, log); return; }
  if (cmd === 'parity') {
    // Compare two receipts' serial transcripts byte for byte (for example Rust with the switch unset against a baseline).
    const [a, b] = argv.slice(1, 3).map(f => JSON.parse(readFileSync(f!, 'utf8')) as Receipt);
    const d = firstDifference(a!.serial.transcript, b!.serial.transcript);
    console.log(JSON.stringify({ a: armLabel(a!), b: armLabel(b!), identical: a!.serial.sha256 === b!.serial.sha256, a_sha256: a!.serial.sha256, b_sha256: b!.serial.sha256, first_difference: d }, null, 2));
    return;
  }
  if (cmd !== 'run') { console.error('usage: multi-writer-behavior.ts run|matrix|report (see the header of this file)'); process.exit(2); }
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const kind = evalEngineKind();
  const sw = (flag(argv, '--switch') ?? (process.env.GBRAIN_RUST_MULTIUSER === '1' ? 'on' : 'off')) as SwitchSetting;
  if (sw !== 'on' && sw !== 'off') throw new Error('--switch is on or off');
  const r = await runArm({ gut, kind, switchSetting: sw, pgAdminUrl: flag(argv, '--pg-url') ?? process.env.LIFECYCLE_PG_URL, writers: Number(flag(argv, '--writers') ?? 4), rounds: Number(flag(argv, '--rounds') ?? 4), checks: (flag(argv, '--checks') ?? Object.keys(CHECKS).join(',')).split(','), log });
  const out = resolve(flag(argv, '--out') ?? join(REPO, 'eval/reports/multi-writer', `engine-${kind}${kind === 'rust' ? `-${sw}` : ''}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'receipt.json'), `${JSON.stringify(r, null, 2)}\n`);
  console.log(renderReport([r]));
  console.error(`[mw] receipt: ${join(out, 'receipt.json')}`);
}

if (import.meta.main) {
  try { await main(); process.exit(0); } catch (e) { console.error(`multi-writer-behavior: ${(e as Error).stack ?? e}`); process.exit(1); }
}
