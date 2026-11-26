#!/usr/bin/env bun
/**
 * Embeds corpus W of the filtered vector search experiment
 * (docs/benchmarks/2026-11-26-filtered-vector-material-preregistration.md) with voyage-4 at 1024 dimensions, through
 * the budget ledger: every request is reserved against --budget-usd before it is sent and settled to Voyage's reported
 * tokens. Reads <dir>/pages.tsv and <dir>/chunks.txt from gbrain's scripts/bench/hnsw-real-corpus-prep.py at the pin and
 * appends unit-normalized vectors to <dir>/vectors.f32 in chunk order, so a stopped run resumes where it stopped. A cap
 * stop throws at a batch boundary; nothing is retried past it.
 *
 *   VOYAGE_API_KEY=... bun eval/runner/filtered-vector/embed-wiki.ts --corpus-dir ~/wiki --chunks 375000 --budget-usd 15
 */
import { budgetOptionsFrom, startPaidRun } from '../budget-ledger.ts';
import { closeSync, existsSync, openSync, readFileSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf('--' + name); if (i >= 0 && argv[i + 1]) return argv[i + 1]!; if (fallback === undefined) throw new Error('--' + name + ' is required'); return fallback; };
const DIR = resolve(flag('corpus-dir'));
const CHUNKS = Number(flag('chunks'));
const DIMS = 1024;
const CONCURRENCY = Number(flag('concurrency', '8'));
const log = (m: string) => console.error('[embed-wiki ' + new Date().toISOString().slice(11, 19) + '] ' + m);

const counts: number[] = [];
let total = 0;
for (const line of readFileSync(join(DIR, 'pages.tsv'), 'utf8').trim().split('\n')) {
  if (total >= CHUNKS) break;
  const c = Math.min(Number(line.split('\t')[2]), CHUNKS - total);
  counts.push(c);
  total += c;
}
if (total !== CHUNKS) throw new Error(DIR + ' holds ' + total + ' chunks, fewer than ' + CHUNKS);
const texts = readFileSync(join(DIR, 'chunks.txt'));
const offsets = new Float64Array(total + 1);
for (let i = 0, pos = 0; i <= total; i++) { offsets[i] = pos; if (i < total) pos = texts.indexOf(10, pos) + 1; }
const text = (i: number) => texts.toString('utf8', offsets[i]!, offsets[i + 1]! - 1);
const estimateUsd = (offsets[total]! / 4 / 1e6) * 0.06;

const file = join(DIR, 'vectors.f32');
const width = DIMS * 4;
let have = existsSync(file) ? Math.floor(statSync(file).size / width) : 0;
if (existsSync(file) && statSync(file).size !== have * width) truncateSync(file, have * width);
log(counts.length + ' pages, ' + total + ' chunks, ' + have + ' already embedded; estimate $' + estimateUsd.toFixed(2) + ' for the whole corpus');
if (have >= total) process.exit(0);
if (!process.env.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY is not set');

const { run, guard } = startPaidRun('filtered-vector-embed-wiki', { ...budgetOptionsFrom(process.argv), estimateUsd: estimateUsd * (1 - have / total), log });
let tokens = 0, requests = 0;

async function voyage(batch: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.VOYAGE_API_KEY },
      body: JSON.stringify({ model: 'voyage-4', input: batch, input_type: 'document', output_dimension: DIMS }),
    });
    requests++;
    if (res.ok) {
      const body = await res.json() as { data: Array<{ embedding: number[] }>; usage: { total_tokens: number } };
      tokens += body.usage.total_tokens;
      return body.data.map(d => {
        const v = Float32Array.from(d.embedding);
        let n = 0;
        for (const x of v) n += x * x;
        const inv = 1 / Math.sqrt(n);
        for (let i = 0; i < v.length; i++) v[i]! *= inv;
        return v;
      });
    }
    const retry = res.status === 429 || res.status >= 500;
    if (!retry || attempt >= 6 || guard.exhausted) throw new Error('voyage ' + res.status + ': ' + (await res.text()).slice(0, 200));
    await Bun.sleep(Math.min(60_000, 1000 * 2 ** attempt));
  }
}

const fd = openSync(file, 'a');
const t0 = performance.now(), start = have;
try {
  while (have < total) {
    const batches: string[][] = [];
    let i = have;
    for (let b = 0; b < CONCURRENCY && i < total; b++) {
      const batch: string[] = [];
      let chars = 0;
      while (i < total && batch.length < 128 && chars < 90_000) { const t = text(i++); batch.push(t); chars += t.length; }
      batches.push(batch);
    }
    const results = await Promise.all(batches.map(voyage));
    for (const vectors of results) writeSync(fd, Buffer.concat(vectors.map(v => Buffer.from(v.buffer, v.byteOffset, v.byteLength))));
    have = i;
    if ((have - start) % 20_000 < 1024) log('embedded ' + have + '/' + total + ', ' + tokens + ' tokens, ' + Math.round((have - start) / ((performance.now() - t0) / 60_000)) + ' chunks/min');
  }
} finally {
  closeSync(fd);
  guard.uninstall();
  const summary = run.close();
  writeFileSync(join(DIR, 'embed-receipt.json'), JSON.stringify({ chunks: total, embedded: have, tokens, requests, ledger: summary }, null, 2));
  log('ledger: $' + summary.actual_usd.toFixed(4) + ' over ' + summary.requests + ' requests; ' + have + '/' + total + ' chunks embedded');
}
