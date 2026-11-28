/**
 * Arm T of the filtered vector search experiment (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md):
 * a copy of the pinned gbrain checkout in which a pooled attempt of any relaxed joined statement gets
 * JOINED_STATEMENT_SETTINGS (enable_material = off), not only one whose statement has an index walk. This is the change
 * gbrain#9817 describes, written here from the issue's text. Each replacement must match exactly once, or the arm is
 * refused.
 *
 *   bun eval/runner/filtered-vector/patch-arm.ts <control checkout> <treatment dir>
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ARM_PATCHES = [
  {
    file: 'src/core/postgres-engine.ts',
    from: '!!shape.indexWalkSql && !walk && !(scopeScan && shape.scopeScanSql) && !exact',
    to: 'shape.relaxed && !walk && !(scopeScan && shape.scopeScanSql) && !exact',
  },
  {
    file: 'src/core/pglite-engine.ts',
    from: '!!stmt.indexWalkSql && !indexWalk && !(scopeScan && stmt.scopeScanSql)',
    to: 'stmt.relaxed && !indexWalk && !(scopeScan && stmt.scopeScanSql)',
  },
] as const;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Applies one replacement to a file's text; throws unless `from` occurs exactly once. */
export function applyPatch(text: string, patch: { file: string; from: string; to: string }): string {
  const first = text.indexOf(patch.from);
  if (first < 0) throw new Error(`${patch.file}: the shipped predicate was not found; the pin changed the code this arm patches`);
  if (text.indexOf(patch.from, first + 1) >= 0) throw new Error(`${patch.file}: the shipped predicate occurs more than once`);
  return text.slice(0, first) + patch.to + text.slice(first + patch.from.length);
}

export interface ArmRecord { file: string; control_sha256: string; treatment_sha256: string }

/** Copies the control checkout (with its node_modules) to `treatment` and patches it. */
export function buildTreatment(control: string, treatment: string): ArmRecord[] {
  if (!existsSync(join(control, 'src/core/postgres-engine.ts'))) throw new Error(`${control} is not a gbrain checkout`);
  rmSync(treatment, { recursive: true, force: true });
  cpSync(control, treatment, { recursive: true, verbatimSymlinks: true });
  return ARM_PATCHES.map(patch => {
    const before = readFileSync(join(control, patch.file), 'utf8');
    const after = applyPatch(before, patch);
    writeFileSync(join(treatment, patch.file), after);
    return { file: patch.file, control_sha256: sha256(before), treatment_sha256: sha256(after) };
  });
}

if (import.meta.main) {
  const [control, treatment] = process.argv.slice(2);
  if (!control || !treatment) throw new Error('usage: patch-arm.ts <control checkout> <treatment dir>');
  console.log(JSON.stringify(buildTreatment(control, treatment), null, 2));
}
