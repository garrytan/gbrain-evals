#!/usr/bin/env bun
/**
 * Sealed Cat 40 Hard world: generate it, or print only its digest.
 *
 *   bun eval/generators/hard-sealed/cli.ts --seed <s> --out <dir> --digest-only
 *   bun eval/generators/hard-sealed/cli.ts --seed <s> --out <dir> [--knobs <file.json>] [--scale large]
 *
 * --digest-only builds the world in memory and prints its digest and counts.
 * It writes nothing and never prints the seed or any document text.
 * Without it, the command writes <out>/world.json (the file the runner's
 * --world takes), <out>/docs/<id>.md and <out>/digest.txt.
 * See docs/benchmarks/cat40-hard/SEALED.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { renderDoc } from '../model-ladder-gen.ts';
import { DEFAULT_HARD_KNOBS, validateKnobs } from '../hard/schema.ts';
import { generateSealedWorld, sealedWorldDigest } from './generate.ts';

const USAGE = `usage: bun eval/generators/hard-sealed/cli.ts --seed <non-negative integer> --out <dir> [--digest-only] [--knobs <file.json>] [--scale large]`;

function fail(msg: string): never {
  console.error(`[hard-sealed] ${msg}\n${USAGE}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
const flags: Record<string, string | true> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--digest-only') { flags[a] = true; continue; }
  if (!['--seed', '--out', '--knobs', '--scale'].includes(a)) fail(`unknown argument ${a}`);
  const v = argv[++i];
  if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
  flags[a] = v;
}
const seedText = flags['--seed'];
if (typeof seedText !== 'string' || !/^\d+$/.test(seedText) || !Number.isSafeInteger(Number(seedText))) fail('--seed must be a non-negative integer');
if (typeof flags['--out'] !== 'string') fail('--out is required');
const scale = flags['--scale'] ?? 'v1';
if (scale !== 'v1' && scale !== 'large') fail('--scale takes "large" (omit it for the 4k world)');
const knobs = typeof flags['--knobs'] === 'string' ? validateKnobs(JSON.parse(readFileSync(flags['--knobs'], 'utf8')), flags['--knobs']) : DEFAULT_HARD_KNOBS;

const world = generateSealedWorld(Number(seedText), knobs, scale);
const digest = sealedWorldDigest(world);
console.log(`hard-sealed digest ${digest}`);
console.log(`scale ${scale}, knob digest ${world.knob_digest}, ${world.entities.length} entities, ${world.docs.length} documents, ${world.tasks.length} tasks`);
if (flags['--digest-only']) process.exit(0);

const out = resolve(flags['--out']);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'world.json'), JSON.stringify(world));
for (const d of world.docs) {
  const path = join(out, 'docs', `${d.id}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderDoc(d));
}
writeFileSync(join(out, 'digest.txt'), `${digest}\n`);
console.log(`wrote ${join(out, 'world.json')} and ${world.docs.length} documents under ${join(out, 'docs')}`);
