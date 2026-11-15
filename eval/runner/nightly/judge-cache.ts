/**
 * Content-addressed caches the nightly carries from night to night (on the VM's results volume, then the drive).
 *
 * judge    one judgment per (judge model, prompt version, question id, gold, answer): an answer judged once is never
 *          judged again on a later night, and a different verdict for the same key is recorded as judge drift.
 * context  one reader answer and judgment per (reader, judge, prompt version, question id, context digest), where the
 *          digest is the SHA-256 of the exact reader prompt: a QA question whose retrieved context is byte-identical to an
 *          earlier night's reuses that night's answer and judgment instead of asking the reader again.
 *
 * The prompt version is the SHA-256 of the memory-qa prompt and judging code (qa.ts, qa-v2.ts), so a prompt change starts
 * fresh entries without anyone remembering to bump a number. chat/ under the same root is memory-qa's own provider-call
 * cache (GBRAIN_EVALS_QA_CACHE), kept with these so a resumed night repeats no call.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);

const QA_DIR = resolve(import.meta.dir, '../memory-qa');
let promptVersion: string | null = null;
export function qaPromptVersion(): string {
  promptVersion ??= sha256(Buffer.concat(['qa.ts', 'qa-v2.ts'].map(f => readFileSync(join(QA_DIR, f))))).slice(0, 16);
  return promptVersion;
}

export interface JudgeKey { judge: string; promptVersion: string; questionId: string; gold: unknown; answer: string }
export interface ContextKey { reader: string; judge: string; promptVersion: string; questionId: string; contextDigest: string }
export interface JudgeEntry { score: number; night: string }
export interface ContextEntry { answer: string; score: number; night: string; row: Record<string, unknown> }

export const judgeKey = (k: JudgeKey) => sha256(stable({ kind: 'judge', ...k }));
export const contextKey = (k: ContextKey) => sha256(stable({ kind: 'context', ...k }));
export const contextDigest = (readerPrompt: string) => sha256(readerPrompt);

export class NightlyCache {
  constructor(readonly root: string) {}
  /** memory-qa's provider-call cache directory (GBRAIN_EVALS_QA_CACHE). */
  get chatDir(): string { return join(this.root, 'chat'); }
  private path(kind: 'judge' | 'context', key: string) { return join(this.root, kind, key.slice(0, 2), `${key}.json`); }
  private read<T>(kind: 'judge' | 'context', key: string): T | null {
    const p = this.path(kind, key);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : null;
  }
  private write(kind: 'judge' | 'context', key: string, value: unknown): void {
    const p = this.path(kind, key);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, p);
  }
  getJudgment(k: JudgeKey): JudgeEntry | null { return this.read<JudgeEntry>('judge', judgeKey(k)); }
  /** Records a judgment; returns the earlier entry when one existed with another score (judge drift), else null. */
  putJudgment(k: JudgeKey, e: JudgeEntry): JudgeEntry | null {
    const prior = this.getJudgment(k);
    if (!prior) this.write('judge', judgeKey(k), e);
    return prior && prior.score !== e.score ? prior : null;
  }
  getContext(k: ContextKey): ContextEntry | null { return this.read<ContextEntry>('context', contextKey(k)); }
  putContext(k: ContextKey, e: ContextEntry): void { if (!this.getContext(k)) this.write('context', contextKey(k), e); }
}
