/**
 * engine-bench launcher log: run a launcher command (scripts/ubicloud/ubi-runner.sh and the like), pass its output
 * through to the terminal unchanged, and write the published log with run-machine details rewritten: Ubicloud VM names
 * as `<vm>`, IP addresses other than loopback as `<ip>`, and checkout, home, temp and Capy scratch paths as
 * writeScrubbedJson writes them. The VMs are destroyed when a run ends, so these details identify nothing a reader
 * needs; the run's own receipts carry what does.
 *
 *   bun eval/runner/engine-bench/launch-log.ts --out <log> -- <command> [args...]
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { scrubPathsText } from '../receipt.ts';

const IPV4 = /(?<![\w.])(?!127\.)(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d?)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\w.])/g;
const IPV6 = /(?<![\w:])(?=[0-9a-f:]*(?:::|[a-f]))[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;
const VM_NAME = /\bubirun-[a-z0-9]+(?:-[a-z0-9]+)*/gi;

/** Rewrite VM names, non-loopback IP addresses and machine paths in launcher output. */
export function scrubLauncherLog(text: string, home = homedir()): string {
  return scrubPathsText(text, home)
    .replace(VM_NAME, '<vm>')
    .replace(IPV4, '<ip>')
    .replace(IPV6, '<ip>');
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const sep = argv.indexOf('--');
  const outAt = argv.indexOf('--out');
  if (sep < 0 || outAt < 0 || outAt > sep || !argv[outAt + 1] || sep + 1 >= argv.length) {
    process.stderr.write('usage: bun eval/runner/engine-bench/launch-log.ts --out <log> -- <command> [args...]\n');
    return 2;
  }
  const out = argv[outAt + 1]!;
  mkdirSync(dirname(out), { recursive: true });
  const log = createWriteStream(out);
  const child = spawn(argv[sep + 1]!, argv.slice(sep + 2), { stdio: ['inherit', 'pipe', 'pipe'] });
  let pending = '';
  const take = (chunk: Buffer, to: NodeJS.WriteStream) => {
    to.write(chunk);
    pending += chunk.toString('utf8');
    const end = pending.lastIndexOf('\n');
    if (end < 0) return;
    log.write(scrubLauncherLog(pending.slice(0, end + 1)));
    pending = pending.slice(end + 1);
  };
  child.stdout.on('data', (c: Buffer) => take(c, process.stdout));
  child.stderr.on('data', (c: Buffer) => take(c, process.stderr));
  const code = await new Promise<number>(res => child.on('close', c => res(c ?? 1)));
  if (pending) log.write(scrubLauncherLog(pending));
  await new Promise<void>(res => log.end(res));
  return code;
}

if (import.meta.main) process.exit(await main());
