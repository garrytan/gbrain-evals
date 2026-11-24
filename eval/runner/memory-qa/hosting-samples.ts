/**
 * Hosting samples for the cost-and-speed experiment (docs/benchmarks/2026-11-24-cost-speed-preregistration.md,
 * "Hosting"): the stack's resident memory and disk, sampled after a bulk import drains and through the probes, the
 * questions and the idle window, never during the bulk import itself. A sample reads every running container's memory
 * (`docker stats`) and every volume's size (`docker system df -v`), plus the harness process's own resident memory
 * for in-process systems. A read that fails is recorded with its error, never dropped.
 */
import { appendFileSync } from 'node:fs';

export interface HostingSample {
  at: string;
  stage: string;
  harness_rss_bytes: number;
  containers: Array<{ name: string; mem_bytes: number }>;
  volumes: Array<{ name: string; bytes: number }>;
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

async function dockerCli(args: string[]): Promise<string> {
  const p = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`docker ${args[0]} exited ${code}: ${err.trim().slice(0, 200)}`);
  return out;
}

/**
 * Samples into `path` every `intervalMs` while a stage is set; `stage(label)` takes a sample at once and sets the label
 * later samples carry, and `stage(null)` pauses sampling (the bulk import).
 */
export class HostingSampler {
  private label: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly intervalMs = 60_000, private readonly read: () => Promise<Pick<HostingSample, 'containers' | 'volumes'>> = () => dockerReading()) {}

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
    try { line = { ...base, ...(await this.read()) }; }
    catch (e) { line = { ...base, containers: [], volumes: [], error: (e as Error).message.slice(0, 300) }; }
    appendFileSync(this.path, JSON.stringify(line) + '\n');
  }
}
