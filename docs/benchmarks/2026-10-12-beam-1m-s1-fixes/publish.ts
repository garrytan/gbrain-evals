/**
 * Copies one S1 arm's run output into arms/<name>/ for commit: each shard's receipt.json and run-config.json, and its
 * rows as rows.ndjson.gz, with machine-local paths rewritten (scrubMachinePaths; the gbrain checkout becomes
 * `<gbrain checkout>`), plus the ledger run id.
 * Usage: bun docs/benchmarks/2026-10-12-beam-1m-s1-fixes/publish.ts <run output dir> <arm name> [<ledger run id file>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { scrubMachinePaths } from '../../../eval/runner/receipt.ts';

const [src, name, runIdFile] = process.argv.slice(2);
if (!src || !name) throw new Error('usage: publish.ts <run output dir> <arm name> [<ledger run id file>]');
const checkout = process.env.GBRAIN_CHECKOUT;
if (!checkout) throw new Error('set GBRAIN_CHECKOUT to the gbrain checkout the arms ran against, so its path is scrubbed from the published rows');
const scrub = (v: unknown) => JSON.parse(JSON.stringify(scrubMachinePaths(v)).split(checkout).join('<gbrain checkout>'));
const dest = join(import.meta.dir, 'arms', name);
for (const shard of readdirSync(src).filter(d => /^shard-\d+$/.test(d)).sort()) {
  const from = join(src, shard), to = join(dest, shard);
  mkdirSync(to, { recursive: true });
  for (const f of ['receipt.json', 'run-config.json']) {
    if (existsSync(join(from, f))) writeFileSync(join(to, f), JSON.stringify(scrub(JSON.parse(readFileSync(join(from, f), 'utf8'))), null, 2) + '\n');
  }
  const rows = existsSync(join(from, 'rows.ndjson')) ? readFileSync(join(from, 'rows.ndjson'), 'utf8').split('\n').filter(Boolean) : [];
  writeFileSync(join(to, 'rows.ndjson.gz'), gzipSync(rows.map(l => JSON.stringify(scrub(JSON.parse(l)))).join('\n') + (rows.length ? '\n' : '')));
}
if (runIdFile && existsSync(runIdFile)) writeFileSync(join(dest, 'ledger-run-id.txt'), readFileSync(runIdFile, 'utf8').trim() + '\n');
process.stdout.write(`published ${name} to ${dest}\n`);
