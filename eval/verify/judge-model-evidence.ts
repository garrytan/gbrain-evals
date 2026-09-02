/**
 * judge-model-evidence — a receipt judged by a movable model alias carries
 * server-reported evidence of what actually ran.
 *
 * Issue #26 gap 4: the published Cat 35 runs record `judge_model:
 * claude-sonnet-4-6`, a movable alias, while the Haiku calls are pinned to a
 * dated snapshot. No dated snapshot exists for that model, so the fix
 * (2026-09-01) was disclosure, not pinning: receipts record the server's
 * per-call `resp.model` in `judge_models_resolved`, and cross-run deltas are
 * suppressed unless both sides resolve to one identical model. This check
 * is the enforcement half of that contract.
 *
 * Receipt rules (every docs/** /*.json with a string `judge_model`):
 *   - dated snapshot (`…-YYYYMMDD`) → info
 *   - alias, `timestamp` at/after the contract date (2026-09-01T00:00:00Z)
 *     → must carry `judge_models_resolved` naming exactly one real model
 *     (no 'null' key, no mix) → FAIL otherwise
 *   - alias, older or undated → legacy: info when docs/receipts-manifest.json
 *     covers the file with a note that names the alias caveat; WARN when the
 *     manifest does not cover it (the caveat lives nowhere)
 *
 * Code inventory (info only): every `claude-<family>-<n>` literal under
 * eval/runner/, tagged alias or snapshot, so a reviewer sees at a glance
 * which judges are pinned. Policy for code is disclosure, not pinning, so
 * nothing here fails on the inventory.
 *
 * Keyless, $0, no network.
 *
 * Usage: bun eval/verify/judge-model-evidence.ts [--root <dir>] [--contract-date <iso>] [--quiet] [--strict] [--json]
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, parseArgs, rel, runCli, walk, type CheckReport, type Finding } from './lib.ts';

export const CHECK = 'judge-model-evidence';
export const CONTRACT_DATE = '2026-09-01T00:00:00Z';

/** A dated snapshot ends in an 8-digit date; anything else is a movable alias. */
export function classifyModelId(id: string): 'snapshot' | 'alias' {
  return /-\d{8}$/.test(id) ? 'snapshot' : 'alias';
}

/**
 * Mirrors eval/runner/cat35-judges.ts singleResolvedModel: a map is
 * trustworthy for deltas only when it names exactly one real model.
 */
export function singleResolvedModel(map: unknown): string | null {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return null;
  const keys = Object.keys(map as Record<string, unknown>);
  if (keys.length !== 1) return null;
  const [k] = keys;
  if (k === 'null' || k === '') return null;
  const n = (map as Record<string, unknown>)[k];
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null;
  return k;
}

interface ManifestLite {
  entries: Array<{ artifact_path: string | null; note: string }>;
}

function manifestNoteFor(root: string, artifact: string): string | null {
  const p = join(root, 'docs/receipts-manifest.json');
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as ManifestLite;
    const e = m.entries.find(x => x.artifact_path === artifact);
    return e ? e.note : null;
  } catch {
    return null;
  }
}

export interface JudgeEvidenceOpts {
  root?: string;
  contractDate?: string;
  /** Override receipt list (repo-relative). Default: docs/** /*.json. */
  receipts?: string[];
  /** Skip the code inventory (tests on synthetic roots). */
  skipInventory?: boolean;
}

export function checkReceipt(
  surface: string,
  doc: Record<string, unknown>,
  root: string,
  contractDate: string,
): Finding[] {
  const jm = doc.judge_model;
  if (typeof jm !== 'string') return [];
  if (classifyModelId(jm) === 'snapshot') {
    return [{ severity: 'info', where: surface, message: `judge_model ${jm} is a dated snapshot` }];
  }
  const ts = typeof doc.timestamp === 'string' ? doc.timestamp : null;
  const underContract = ts !== null && Date.parse(ts) >= Date.parse(contractDate);
  if (underContract) {
    const resolved = singleResolvedModel(doc.judge_models_resolved);
    if (resolved === null) {
      const have = doc.judge_models_resolved === undefined ? 'absent' : JSON.stringify(doc.judge_models_resolved);
      return [
        {
          severity: 'fail',
          where: surface,
          message: `judge_model ${jm} is a movable alias and this receipt (timestamp ${ts}) is under the 2026-09-01 contract, but judge_models_resolved does not name exactly one real model (${have})`,
        },
      ];
    }
    return [{ severity: 'info', where: surface, message: `alias ${jm} resolved server-side to ${resolved}` }];
  }
  const note = manifestNoteFor(root, surface);
  if (note && /alias/i.test(note)) {
    return [{ severity: 'info', where: surface, message: `legacy receipt (${ts ?? 'undated'}): alias ${jm}, caveat disclosed in docs/receipts-manifest.json` }];
  }
  return [
    {
      severity: 'warn',
      where: surface,
      message: `legacy receipt (${ts ?? 'undated'}) judged by alias ${jm} with no judge_models_resolved and no manifest note naming the caveat`,
    },
  ];
}

export function inventoryModelIds(root: string): Finding[] {
  const byId = new Map<string, Set<string>>();
  const re = /claude-(?:opus|sonnet|haiku)-[0-9][\w.-]*/g;
  for (const f of walk(join(root, 'eval/runner'))) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(re)) {
      const id = m[0].replace(/[.,;:'"`)]+$/, '');
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id)!.add(rel(root, f));
    }
  }
  const out: Finding[] = [];
  for (const [id, files] of [...byId.entries()].sort()) {
    out.push({
      severity: 'info',
      where: `code:${id}`,
      message: `${classifyModelId(id)} in ${files.size} runner file(s)`,
    });
  }
  return out;
}

export function checkJudgeModelEvidence(opts: JudgeEvidenceOpts = {}): CheckReport {
  const root = opts.root ?? REPO_ROOT;
  const contractDate = opts.contractDate ?? CONTRACT_DATE;
  const receipts =
    opts.receipts ??
    walk(join(root, 'docs'))
      .filter(f => f.endsWith('.json'))
      .map(f => rel(root, f));
  const findings: Finding[] = [];
  let seen = 0;
  for (const r of receipts) {
    const abs = join(root, r);
    if (!existsSync(abs)) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(abs, 'utf8'));
    } catch {
      continue; // cited-artifacts reports unparseable surfaces
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const fs = checkReceipt(r, doc as Record<string, unknown>, root, contractDate);
    if (fs.length > 0) seen++;
    findings.push(...fs);
  }
  findings.push({ severity: 'info', where: `${seen} receipt(s) with judge_model`, message: `contract date ${contractDate}` });
  if (!opts.skipInventory) findings.push(...inventoryModelIds(root));
  return { check: CHECK, findings };
}

if (import.meta.main) {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = typeof flags.get('root') === 'string' ? String(flags.get('root')) : REPO_ROOT;
  const contractDate = typeof flags.get('contract-date') === 'string' ? String(flags.get('contract-date')) : undefined;
  runCli([checkJudgeModelEvidence({ root, contractDate })], flags);
}
