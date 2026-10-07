/**
 * BEAM-10M manifest generator, run by the custodian on the custody host (Q1
 * PLAN §4.2, §4.8.10). It fills eval/decisions/datasets/beam-10m-9b20961.json,
 * whose hashes stay null until then.
 *
 *   bun eval/runner/q1/beam10m-manifest.ts status [--json]                          ($0, reads the manifest only)
 *   bun eval/runner/q1/beam10m-manifest.ts fetch [--root <dataset root>] [--write] [--json]   (custodian; GBRAIN_EVALS_CUSTODY_LOG)
 *
 * `fetch` downloads the two parquet shards at the pinned hub revision (or
 * reuses verified local copies), checks each against the hub's published LFS
 * SHA-256 and the listed size, extracts every conversation into a corpus file
 * (`chat` only) and a question file (`probing_questions` only) with
 * eval/runner/q1/beam10m_extract.py under a pinned pyarrow, refuses unless the
 * conversation ids are exactly the manifest's, and hashes every output.
 * `--write` records the hashes in the manifest; without it the command prints
 * what it would record. Output is ids, sizes and hashes only. The extractor
 * runs as `uv run --no-project --python 3.12 --with pyarrow==21.0.0 python`;
 * GBRAIN_EVALS_BEAM10M_PYTHON names another Python that has pyarrow.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { decideError, DecideError, exitCodeFor, renderOperatorMessage, type OperatorMessage } from '../decisions/errors.ts';
import { appendAccessLog } from '../sealed-confirmation-lib.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
export const MANIFEST_PATH = join(REPO_ROOT, 'eval/decisions/datasets/beam-10m-9b20961.json');
export const EXTRACT_SCRIPT = join(REPO_ROOT, 'eval/runner/q1/beam10m_extract.py');

export interface Beam10mManifest {
  dataset: string; source: string; revision: string; license: string; resolve_base: string; status: 'unfilled' | 'filled'; note: string;
  shards: Array<{ path: string; bytes: number; sha256: string | null }>;
  extraction: { script: string; script_sha256: string | null; runner: string; layout: string };
  conversations: Array<{ conversation: string; hf_conversation_id: string; chat_path: string; chat_sha256: string | null; chat_bytes: number | null; questions_path: string; questions_sha256: string | null; questions_bytes: number | null }>;
  filled: null | { at: string; hub_lfs_verified: boolean; conversation_id_source: string };
}

const fileSha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const FETCH = ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'fetch'];

/** Hub LFS SHA-256 per shard path at the pinned revision (public listing; no data). */
export async function hubLfsHashes(m: Pick<Beam10mManifest, 'source' | 'revision'>): Promise<Record<string, string>> {
  const repo = m.source.replace('https://huggingface.co/datasets/', '');
  const res = await fetch(`https://huggingface.co/api/datasets/${repo}/tree/${m.revision}/data`);
  if (!res.ok) throw new Error(`hub listing failed (${res.status})`);
  const list = await res.json() as Array<{ path: string; lfs?: { oid: string } }>;
  return Object.fromEntries(list.filter(x => x.lfs).map(x => [x.path, x.lfs!.oid]));
}

async function download(url: string, path: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  mkdirSync(dirname(path), { recursive: true });
  const out = createWriteStream(`${path}.partial`);
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
  await new Promise<void>((r, j) => out.end((e?: Error | null) => e ? j(e) : r()));
  renameSync(`${path}.partial`, path);
}

export type Extractor = (shards: string[], outDir: string) => { rows: number; conversations: Array<{ conversation: string; hf_conversation_id: string; conversation_id_source: string }> };

export const pythonExtractor: Extractor = (shards, outDir) => {
  const py = process.env.GBRAIN_EVALS_BEAM10M_PYTHON;
  const argv = py ? [py, EXTRACT_SCRIPT] : ['uv', 'run', '--no-project', '--python', '3.12', '--with', 'pyarrow==21.0.0', 'python', EXTRACT_SCRIPT];
  const p = Bun.spawnSync([...argv, '--out', outDir, ...shards], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw decideError({ code: 'ARM_FAILED', message: `the BEAM-10M extractor exited ${p.exitCode}`, why: p.stderr.toString().split('\n').filter(Boolean).slice(-1)[0] ?? 'no error output',
    fix: { next: 'run', argv: ['uv', '--version'], user_message: 'install uv (or set GBRAIN_EVALS_BEAM10M_PYTHON to a Python with pyarrow) and rerun', verify: [...FETCH] } });
  return JSON.parse(p.stdout.toString().trim().split('\n').pop()!);
};

/**
 * Verify shards, extract, hash, and return the filled manifest. `shardFile`
 * returns a local path for a shard (downloading when needed); `hub` holds the
 * hub's LFS hashes.
 */
export async function fillManifest(m: Beam10mManifest, o: { root: string; hub: Record<string, string>; shardFile: (shard: Beam10mManifest['shards'][number]) => Promise<string>; extract: Extractor; log: string }): Promise<Beam10mManifest> {
  const shardPaths: string[] = [];
  const shards = [];
  for (const s of m.shards) {
    const path = await o.shardFile(s);
    const sha = fileSha(path), bytes = statSync(path).size;
    const want = s.sha256 ?? o.hub[s.path];
    if (!want || sha !== want || bytes !== s.bytes) throw decideError({ code: 'DATASET_HASH_MISMATCH', message: `${s.path}: SHA-256 ${sha.slice(0, 12)} and ${bytes} bytes, expected ${(want ?? 'a hub hash').slice(0, 12)} and ${s.bytes} bytes`,
      why: 'only the pinned revision\'s bytes enter the manifest', fix: { next: 'report', user_message: 'the hub shard differs from the pinned revision; a new pin needs review' } });
    shardPaths.push(path); shards.push({ ...s, sha256: sha });
  }
  const outDir = join(o.root, dirname(dirname(m.conversations[0].chat_path)));
  appendAccessLog(o.log, { action: 'write', purpose: 'beam-10m manifest: extract corpus and question files and hash them', decision_id: 'q1-scoreboard', labels_sha256: shards.map(s => s.sha256).join(','), run_sha256: null });
  const summary = o.extract(shardPaths, outDir);
  const got = summary.conversations.map(c => c.hf_conversation_id).sort();
  const want = m.conversations.map(c => c.hf_conversation_id).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) throw decideError({ code: 'SPEC_INVALID', message: `the shards hold conversation ids ${got.join(', ')}, the manifest expects ${want.join(', ')}`,
    why: 'the split file and the exclusion record name conversations by these ids, so they must match before anything is pinned', fix: { next: 'ask_user', user_message: 'the BEAM-10M conversation ids differ from the plan; the split file needs review before the manifest is filled' } });
  const conversations = m.conversations.map(c => {
    const chat = join(o.root, c.chat_path), questions = join(o.root, c.questions_path);
    return { ...c, chat_sha256: fileSha(chat), chat_bytes: statSync(chat).size, questions_sha256: fileSha(questions), questions_bytes: statSync(questions).size };
  });
  return { ...m, status: 'filled', shards, conversations, extraction: { ...m.extraction, script_sha256: fileSha(EXTRACT_SCRIPT) },
    filled: { at: new Date().toISOString(), hub_lfs_verified: m.shards.every(s => o.hub[s.path] !== undefined), conversation_id_source: [...new Set(summary.conversations.map(c => c.conversation_id_source))].join(',') } };
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Beam10mManifest;
    if (argv[0] === 'status') {
      const unfilled = [...m.shards.filter(s => !s.sha256).map(s => s.path), ...m.conversations.flatMap(c => [c.chat_sha256 ? null : c.chat_path, c.questions_sha256 ? null : c.questions_path]).filter(Boolean)];
      process.stdout.write(JSON.stringify({ status: m.status, revision: m.revision, shards: m.shards.length, conversations: m.conversations.length, unfilled: unfilled.length }) + '\n');
      return 0;
    }
    if (argv[0] !== 'fetch') throw decideError({ code: 'SPEC_INVALID', message: `unknown command ${JSON.stringify(argv[0] ?? '')}`, why: 'commands are status and fetch', fix: { next: 'run', argv: ['bun', 'eval/runner/q1/beam10m-manifest.ts', 'status'] } });
    const log = process.env.GBRAIN_EVALS_CUSTODY_LOG;
    if (!log) throw decideError({ code: 'CUSTODY_MISSING', message: 'filling the BEAM-10M manifest is a custodian step', why: 'it downloads and splits sealed data, which stays on the custody host and is logged',
      fix: { next: 'tell_user_to_run', argv: [...FETCH, '--write'], user_message: 'the custodian runs this on the custody host with GBRAIN_EVALS_CUSTODY_LOG set, then commits the manifest' } });
    const root = resolve(one('--root') ?? process.env.GBRAIN_EVALS_DATASETS ?? join(homedir(), 'datasets', 'gbrain-evals'));
    const hub = await hubLfsHashes(m);
    const filled = await fillManifest(m, { root, hub, log, extract: pythonExtractor, shardFile: async s => {
      const path = join(root, 'beam-10m', m.revision.slice(0, 7), 'shards', s.path);
      const good = existsSync(path) && statSync(path).size === s.bytes && fileSha(path) === (s.sha256 ?? hub[s.path]);
      if (!good) { rmSync(path, { force: true }); await download(m.resolve_base + s.path, path); }
      return path;
    } });
    if (argv.includes('--write')) writeFileSync(MANIFEST_PATH, JSON.stringify(filled, null, 1) + '\n');
    process.stdout.write(JSON.stringify({ written: argv.includes('--write'), shards: filled.shards.map(s => ({ path: s.path, sha256: s.sha256 })),
      conversations: filled.conversations.map(c => ({ conversation: c.conversation, chat_sha256: c.chat_sha256, questions_sha256: c.questions_sha256 })) }, null, 1) + '\n');
    return 0;
  } catch (e) {
    if (!(e instanceof DecideError)) throw e;
    const op: OperatorMessage = e.op;
    process.stderr.write((json ? JSON.stringify(op) : renderOperatorMessage(op)) + '\n');
    return exitCodeFor(op);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
