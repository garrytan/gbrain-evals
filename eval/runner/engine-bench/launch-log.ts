/**
 * engine-bench launcher log: run a launcher command (scripts/ubicloud/ubi-runner.sh and the like), pass its output
 * through to the terminal unchanged, and write the published log with run-machine details rewritten: Ubicloud VM names
 * as `<vm>`, IP addresses other than loopback as `<ip>`, passwords in URLs as `<redacted>`, and checkout, home, temp
 * and Capy scratch paths as writeScrubbedJson writes them. A dotted quad ending in .0 is a version (gstack 1.97.0.0),
 * never a host, so it stays. The VMs are destroyed when a run ends, so these details identify nothing a reader
 * needs; the run's own receipts carry what does.
 *
 *   bun eval/runner/engine-bench/launch-log.ts --out <log> -- <command> [args...]
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { redactUrlPasswords } from '../hermetic-env.ts';
import { scrubPathsText } from '../receipt.ts';

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`(?<![\\w.])(?!127\\.)(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]\\d?)(?:\\.${OCTET}){2}\\.(?!0(?![\\d]))${OCTET}(?!\\w|\\.\\w)`, 'g');
const IPV6 = /(?<![\w:])(?=[0-9a-f:]*(?:::|[a-f])|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:]))[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;
const VM_NAME = /\bubirun-[a-z0-9]+(?:-[a-z0-9]+)*/gi;
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Rewrite VM names, non-loopback IP addresses, URL passwords and machine paths in launcher output. */
export function scrubLauncherLog(text: string, home = homedir()): string {
  return redactUrlPasswords(scrubPathsText(text, home), '<redacted>')
    .replace(VM_NAME, '<vm>')
    .replace(IPV4, '<ip>')
    .replace(IPV6, ip => (ip === '::1' ? ip : '<ip>'));
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
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  for (const signal of FORWARDED) process.on(signal, forward);
  const pipe = (from: NodeJS.ReadableStream, to: NodeJS.WriteStream) => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    from.on('data', (chunk: Buffer) => {
      to.write(chunk);
      pending += decoder.write(chunk);
      const end = pending.lastIndexOf('\n');
      if (end < 0) return;
      log.write(scrubLauncherLog(pending.slice(0, end + 1)));
      pending = pending.slice(end + 1);
    });
    return () => { pending += decoder.end(); if (pending) log.write(scrubLauncherLog(pending)); };
  };
  const flushOut = pipe(child.stdout!, process.stdout);
  const flushErr = pipe(child.stderr!, process.stderr);
  const code = await new Promise<number>(res => {
    child.on('error', err => {
      if (child.pid !== undefined) { log.write(scrubLauncherLog(`launch-log: ${argv[sep + 1]}: ${err.message}\n`)); return; }
      log.write(scrubLauncherLog(`launch-log: could not start ${argv[sep + 1]}: ${err.message}\n`));
      res(127);
    });
    child.on('close', c => res(c ?? 1));
  });
  for (const signal of FORWARDED) process.off(signal, forward);
  flushOut();
  flushErr();
  await new Promise<void>(res => log.end(res));
  return code;
}

if (import.meta.main) process.exit(await main());
