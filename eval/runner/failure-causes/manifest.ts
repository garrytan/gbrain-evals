/**
 * Source manifests for back-classification. A manifest names every input file
 * explicitly with its SHA-256 (never a glob), the adapter that reads it, its
 * visibility and its condition. Files are read from named roots that the
 * caller maps to directories (--root partc=/path/to/archive), so evidence
 * pointers never carry a machine path.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { ArmRole, Condition, Visibility } from './types.ts';

export const SOURCES_SCHEMA = 'failure-cause-sources/1';
export const ADAPTER_IDS = ['refresh-barrier', 'rs1', 'cat40', 'skillopt', 'live-recall', 'nightly'] as const;
export type AdapterId = typeof ADAPTER_IDS[number];
const VISIBILITIES: readonly Visibility[] = ['public', 'synthetic', 'private', 'sealed'];
const CONDITIONS: readonly Condition[] = ['natural', 'forced'];
const ARM_ROLES: readonly ArmRole[] = ['gbrain_default', 'gbrain_variant', 'other_system', 'control', 'oracle'];
/** Paths that hold sealed or custody material; a manifest naming one is refused whatever its visibility says. */
const SEALED_PATHS = [/rs1-custody/i, /\.rs1-seed$/i, /(^|\/)sealed(\/|$)/i];

export interface SourceFile { path: string; sha256: string; role: string }

export interface SourceEntry {
  id: string;
  adapter: AdapterId;
  visibility: Visibility;
  condition: Condition;
  root: string;
  files: SourceFile[];
  /** Arm or cell name to role, for arms the adapter's default mapping does not cover. */
  arm_roles?: Record<string, ArmRole>;
  /** provider:model or bare model names counted from this source; others are skipped. */
  models?: string[];
  gbrain_sha?: string;
  /** The model that produced the rows, when the files do not say (SkillOpt proposer inputs). */
  model?: string;
  note?: string;
}

export interface SourceManifest { schema: typeof SOURCES_SCHEMA; sources: SourceEntry[] }

export interface LoadedFile extends SourceFile { root: string; bytes: Uint8Array }

export function validateManifest(m: unknown): string[] {
  const v: string[] = [];
  const man = m as Partial<SourceManifest> | null;
  if (!man || man.schema !== SOURCES_SCHEMA || !Array.isArray(man.sources)) return [`manifest must be { schema: "${SOURCES_SCHEMA}", sources: [] }`];
  const ids = new Set<string>();
  for (const s of man.sources) {
    const at = s?.id ?? '?';
    if (!s || typeof s.id !== 'string' || !s.id) { v.push('a source has no id'); continue; }
    if (ids.has(s.id)) v.push(`${at}: duplicate source id`);
    ids.add(s.id);
    if (!ADAPTER_IDS.includes(s.adapter)) v.push(`${at}: adapter must be one of ${ADAPTER_IDS.join('|')}`);
    if (!VISIBILITIES.includes(s.visibility)) v.push(`${at}: visibility must be one of ${VISIBILITIES.join('|')}`);
    if (s.visibility === 'sealed') v.push(`${at}: sealed sources are never read`);
    if (!CONDITIONS.includes(s.condition)) v.push(`${at}: condition must be natural or forced`);
    if (typeof s.root !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(s.root)) v.push(`${at}: root must be a short lowercase name`);
    for (const [arm, role] of Object.entries(s.arm_roles ?? {})) if (!ARM_ROLES.includes(role)) v.push(`${at}: arm_roles.${arm} must be one of ${ARM_ROLES.join('|')}`);
    if (!Array.isArray(s.files) || s.files.length === 0) { v.push(`${at}: files must list at least one file`); continue; }
    const paths = new Set<string>();
    for (const f of s.files) {
      if (typeof f?.path !== 'string' || !f.path) { v.push(`${at}: a file has no path`); continue; }
      if (/[*?[\]{}]/.test(f.path)) v.push(`${at}: ${f.path} is a glob; list each file`);
      if (f.path.startsWith('/') || f.path.split('/').includes('..')) v.push(`${at}: ${f.path} must be relative to its root`);
      if (SEALED_PATHS.some(p => p.test(f.path))) v.push(`${at}: ${f.path} is a sealed path`);
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) v.push(`${at}: ${f.path} needs a 64-hex sha256`);
      if (typeof f.role !== 'string' || !f.role) v.push(`${at}: ${f.path} needs a role`);
      if (paths.has(f.path)) v.push(`${at}: ${f.path} is listed twice`);
      paths.add(f.path);
    }
  }
  return v;
}

export function readManifest(path: string): SourceManifest {
  const m = JSON.parse(readFileSync(path, 'utf8'));
  const v = validateManifest(m);
  if (v.length) throw new Error(`invalid source manifest ${path}:\n  ${v.join('\n  ')}`);
  return m as SourceManifest;
}

export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * Read every file of a source from its mapped root, refusing a missing root or file, any hash mismatch, and a root or
 * file that resolves to a sealed path, so a root mapped into a named RS1 custody or sealed path is refused whatever the
 * manifest says.
 */
export function loadSource(entry: SourceEntry, roots: Record<string, string>): LoadedFile[] {
  const dir = roots[entry.root];
  if (!dir) throw new Error(`${entry.id}: no directory for root "${entry.root}"; pass --root ${entry.root}=<dir>`);
  const sealed = (p: string) => SEALED_PATHS.some(s => s.test(p));
  if (sealed(resolve(dir)) || (existsSync(dir) && sealed(realpathSync(dir)))) throw new Error(`${entry.id}: root "${entry.root}" is a sealed path`);
  return entry.files.map(f => {
    const full = join(dir, f.path);
    if (!existsSync(full)) throw new Error(`${entry.id}: ${entry.root}:${f.path} is missing`);
    if (sealed(realpathSync(full))) throw new Error(`${entry.id}: ${entry.root}:${f.path} resolves to a sealed path`);
    const bytes = new Uint8Array(readFileSync(full));
    const got = sha256(bytes);
    if (got !== f.sha256) throw new Error(`${entry.id}: ${entry.root}:${f.path} has sha256 ${got}, the manifest says ${f.sha256}`);
    return { ...f, root: entry.root, bytes };
  });
}

export const fileText = (f: LoadedFile) => new TextDecoder().decode(f.path.endsWith('.gz') ? gunzipSync(f.bytes) : f.bytes);
export const ndjson = (f: LoadedFile): Record<string, any>[] => fileText(f).split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
/** An archive-relative evidence pointer: root, path, the first 8 hex of the file's sha256, and an optional locator. */
export const pointer = (f: Pick<LoadedFile, 'root' | 'path' | 'sha256'>, locator?: string) => `${f.root}:${f.path}#${f.sha256.slice(0, 8)}${locator ? ' ' + locator : ''}`;
