/**
 * W13 configuration identity: hashes the BEAM-1M retrieval arguments with the current field set and with the
 * starting line's (no QA field, before gbrain-evals 4171288). The last line must print ed768142..., the starting
 * line's run_config_hash. Usage: bun docs/benchmarks/2026-10-06-beam-1m-dates/hash-check.ts (keyless; needs `eval:decide fetch --benchmark beam-1m`).
 */
import { createHash } from 'node:crypto';
import { parseRunArgs } from '../../../eval/runner/memory-qa/run.ts';
import { loadCorpus } from '../../../eval/runner/memory-qa/corpus.ts';
const argv = ['--benchmark','beam-1m','--split','dev','--embed','real','--gbrain','<gbrain checkout>@6622a119e40ea09a7719233046aca24741863ed2','--pin','search.mode=balanced','--pin','search.reranker.enabled=false','--pin','search.autocut=false','--top-k','10','--seed','42','--shard','0/3','--output','/tmp/x'];
const a = parseRunArgs(argv) as any;
const corpus = loadCorpus('beam-1m');
const mk = (qa: unknown) => createHash('sha256').update(JSON.stringify({ benchmark: a.benchmark, split: a.split, config: a.config, pins: a.pins, embed: a.embed, model: a.embeddingModel, dims: a.embeddingDims, qa, categories: a.categories, limit: a.limit, seed: a.seed, topK: a.topK, gbrain: '6622a119e40ea09a7719233046aca24741863ed2', data: corpus.source.files })).digest('hex');
console.log('current', mk(a.qa));
const { context, ...noctx } = a.qa; console.log('without qa.context', mk(noctx));
const h = createHash('sha256').update(JSON.stringify({ benchmark: a.benchmark, split: a.split, config: a.config, pins: a.pins, embed: a.embed, model: a.embeddingModel, dims: a.embeddingDims, categories: a.categories, limit: a.limit, seed: a.seed, topK: a.topK, gbrain: '6622a119e40ea09a7719233046aca24741863ed2', data: corpus.source.files })).digest('hex');
console.log('starting-line field set (no qa)', h);
