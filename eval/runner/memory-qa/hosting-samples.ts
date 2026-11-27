/**
 * Hosting samples for the cost-and-speed experiment (docs/benchmarks/2026-11-24-cost-speed-preregistration.md,
 * "Hosting"): the stack's resident memory and disk, sampled after a bulk import drains and through the probes, the
 * questions and the idle window, never during the bulk import itself. A sample reads every running container's memory
 * (`docker stats`) and every volume's size (`docker system df -v`), plus the harness process's own resident memory
 * for in-process systems. A read that fails is recorded with its error, never dropped.
 */
import { appendFileSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface HostingSample {
  at: string;
  stage: string;
  harness_rss_bytes: number;
  containers: Array<{ name: string; mem_bytes: number }>;
  volumes: Array<{ name: string; bytes: number }>;
  /** An in-process system's own files (the file agent's tree), by path. */
  dirs?: Array<{ path: string; bytes: number }>;
  error?: string;
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** Docker's human sizes (`123.4MiB`, `12.3MB`, `0B`) in bytes; null when unreadable. */
export function parseBytes(s: string): number | null {
  const m = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(s);
  const unit = UNITS[(m?.[2] || 'b').toLowerCase()];
  return m && unit ? Math.round(Number(m[1]) * unit) : null;
}

/** One reading of every running container's memory and every volume's size through the docker CLI. */
export async function dockerReading(run: (args: string[]) => Promise<string> = dockerCli): Promise<Pick<HostingSample, 'containers' | 'volumes'>> {
  const stats = await run(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']);
  const containers = stats.split('\n').filter(Boolean).map(l => {
    const [name, usage] = l.split('\t');
    return { name, mem_bytes: parseBytes(usage.split('/')[0]) ?? 0 };
  });
  const df = JSON.parse(await run(['system', 'df', '-v', '--format', '{{json .}}'])) as { Volumes?: Array<{ Name: string; Size: string }> };
  return { containers, volumes: (df.Volumes ?? []).map(v => ({ name: v.Name, bytes: parseBytes(v.Size) ?? 0 })) };
}

/** Runs `cmd` and collects its output; past `timeoutMs` it kills the process and throws, so a hung CLI becomes an errored sample. */
export async function spawnText(cmd: string[], timeoutMs = 60_000): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (timedOut) throw new Error(`${cmd.join(' ').slice(0, 80)} timed out after ${timeoutMs} ms`);
    return { out, err, code };
  } finally { clearTimeout(timer); }
}

/**
 * The docker CLI as the sampler's user, or through `sudo -n` when that user can't reach the docker socket (a VM user
 * outside the docker group), the way bootstrap.sh's compose falls back.
 */
export async function dockerCli(args: string[], exec: typeof spawnText = spawnText): Promise<string> {
  let r = await exec(['docker', ...args]);
  if (r.code !== 0 && /permission denied/i.test(r.err)) r = await exec(['sudo', '-n', 'docker', ...args]);
  if (r.code !== 0) throw new Error(`docker ${args[0]} exited ${r.code}: ${r.err.trim().slice(0, 200)}`);
  return r.out;
}

/** Bytes of every regular file under `root` (0 when it doesn't exist yet). */
export function treeBytes(root: string): number {
  let n = 0;
  const walk = (p: string) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (st.isDirectory()) for (const e of readdirSync(p).sort()) walk(join(p, e));
    else if (st.isFile()) n += st.size;
  };
  walk(root);
  return n;
}

/**
 * Samples into `path` every `intervalMs` while a stage is set; `stage(label)` takes a sample at once and sets the label
 * later samples carry, and `stage(null)` pauses sampling (the bulk import).
 */
export class HostingSampler {
  private label: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly intervalMs = 60_000, private readonly read: () => Promise<Pick<HostingSample, 'containers' | 'volumes'>> = () => dockerReading(),
    private readonly dirs: readonly string[] = []) {}

  async stage(label: string | null): Promise<void> {
    this.label = label;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (label === null) return this.pending;
    this.timer = setInterval(() => { this.pending = this.pending.then(() => this.sample()); }, this.intervalMs);
    this.pending = this.pending.then(() => this.sample());
    return this.pending;
  }

  async stop(): Promise<void> { await this.stage(null); }

  private async sample(): Promise<void> {
    const stage = this.label;
    if (stage === null) return;
    const base = { at: new Date().toISOString(), stage, harness_rss_bytes: process.memoryUsage().rss };
    let line: HostingSample;
    try { line = { ...base, ...(await this.read()), ...(this.dirs.length ? { dirs: this.dirs.map(p => ({ path: p, bytes: treeBytes(p) })) } : {}) }; }
    catch (e) { line = { ...base, containers: [], volumes: [], error: (e as Error).message.slice(0, 300) }; }
    appendFileSync(this.path, JSON.stringify(line) + '\n');
  }
}
