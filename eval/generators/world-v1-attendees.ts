/**
 * world-v1-attendees: a new corpus version of world-v1 whose meeting pages
 * carry attendance in the form gbrain documents (docs/guides/attendance-
 * evidence.md at the pin): a `## Attendees` section holding only bare
 * Markdown links to person pages. Deterministic, no model, world-v1 untouched.
 *
 * Source of every list: the Cat 2 answer key (`_facts.attendees` on each
 * world-v1 meeting, the edges eval/runner/world-v1-gold.ts scores). A seeded
 * 15% of meetings (8 of 50) get a perturbed list, one person added or removed
 * against the key, so a test scored against the page can tell "gbrain read the
 * page" from "gbrain agrees with the key". In this corpus the gold is the list
 * on the page: `_facts.attendees` holds that list, `_facts.attendees_key` the
 * world-v1 key, and `_attendees-ledger.json` every perturbation.
 *
 * Prose is not edited. A person removed from a list may still be named in the
 * meeting's prose; prose-only attendance is unsupported by gbrain (N12-9), so
 * such a person must not come back as an attendee.
 *
 * Usage: bun eval/generators/world-v1-attendees.ts [--check]   (writes eval/data/world-v1-attendees/, or verifies it)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rng } from './seeded.ts';

export const WORLD_V1_ATTENDEES_VERSION = 'world-v1-attendees/1';
export const WORLD_V1_ATTENDEES_SEED = 20261006;
export const PERTURBED_SHARE = 0.15;
const ROOT = join(import.meta.dir, '../..');
export const SOURCE_DIR = join(ROOT, 'eval/data/world-v1');
export const OUT_DIR = join(ROOT, 'eval/data/world-v1-attendees');

interface WorldPage { slug: string; type: string; title: string; compiled_truth: string; timeline: string | string[]; _facts: Record<string, unknown> & { attendees?: string[] } }
export interface Perturbation { meeting: string; kind: 'added' | 'removed'; person: string; key: string[]; page: string[] }
export interface AttendeesLedger {
  generator_version: string;
  seed: number;
  source_corpus_sha256: string;
  meetings: number;
  perturbed: number;
  perturbations: Perturbation[];
  files: Record<string, string>;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function readSource(dir = SOURCE_DIR): Map<string, { file: string; page: WorldPage; raw: string }> {
  const out = new Map<string, { file: string; page: WorldPage; raw: string }>();
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_')).sort()) {
    const raw = readFileSync(join(dir, file), 'utf8');
    const page = JSON.parse(raw) as WorldPage;
    out.set(page.slug, { file, page, raw });
  }
  return out;
}

/** The `## Attendees` section: bare link-list entries only (gbrain's attendance grammar). */
export function attendeesSection(people: ReadonlyArray<{ slug: string; title: string }>): string {
  return ['## Attendees', '', ...people.map(p => `- [${p.title}](${p.slug})`)].join('\n');
}

export function generateWorldV1Attendees(dir = SOURCE_DIR): { pages: Map<string, string>; ledger: AttendeesLedger } {
  const src = readSource(dir);
  const people = [...src.values()].filter(x => x.page.type === 'person').map(x => x.page);
  const title = new Map(people.map(p => [p.slug, String(p.title)]));
  const meetings = [...src.values()].filter(x => x.page.type === 'meeting').map(x => x.page).sort((a, b) => a.slug.localeCompare(b.slug));
  const rng = new Rng(WORLD_V1_ATTENDEES_SEED);
  const n = Math.round(meetings.length * PERTURBED_SHARE);
  const chosen = new Set(rng.shuffle(meetings.map(m => m.slug)).slice(0, n));
  const perturbations: Perturbation[] = [];
  const pages = new Map<string, string>();
  for (const { file, page, raw } of src.values()) {
    if (page.type !== 'meeting') { pages.set(file, raw); continue; }
    const key = (page._facts.attendees ?? []).filter(s => title.has(s));
    let list = [...key];
    if (chosen.has(page.slug)) {
      const remove = key.length >= 2 && rng.float() < 0.5;
      if (remove) {
        const person = rng.pick(key);
        list = key.filter(s => s !== person);
        perturbations.push({ meeting: page.slug, kind: 'removed', person, key, page: list });
      } else {
        const person = rng.pick(people.map(p => p.slug).filter(s => !key.includes(s)).sort());
        list = [...key, person];
        perturbations.push({ meeting: page.slug, kind: 'added', person, key, page: list });
      }
    }
    const truth = Array.isArray(page.compiled_truth) ? (page.compiled_truth as string[]).join('\n\n') : String(page.compiled_truth);
    const out: WorldPage = {
      ...page,
      compiled_truth: `${truth.trimEnd()}\n\n${attendeesSection(list.map(s => ({ slug: s, title: title.get(s)! })))}`,
      _facts: { ...page._facts, attendees: list, attendees_key: key },
    };
    pages.set(file, JSON.stringify(out, null, 2) + '\n');
  }
  const sourceHash = sha(JSON.stringify([...src.values()].map(x => [x.file, sha(x.raw)])));
  const files = Object.fromEntries([...pages.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([f, c]) => [f, sha(c)]));
  return { pages, ledger: { generator_version: WORLD_V1_ATTENDEES_VERSION, seed: WORLD_V1_ATTENDEES_SEED, source_corpus_sha256: sourceHash, meetings: meetings.length, perturbed: perturbations.length, perturbations, files } };
}

export function corpusFingerprint(ledger: AttendeesLedger): string {
  return sha(JSON.stringify(ledger.files));
}

if (import.meta.main) {
  const { pages, ledger } = generateWorldV1Attendees();
  const ledgerText = JSON.stringify(ledger, null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const problems: string[] = [];
    for (const [f, c] of pages) if (!existsSync(join(OUT_DIR, f)) || readFileSync(join(OUT_DIR, f), 'utf8') !== c) problems.push(f);
    if (!existsSync(join(OUT_DIR, '_attendees-ledger.json')) || readFileSync(join(OUT_DIR, '_attendees-ledger.json'), 'utf8') !== ledgerText) problems.push('_attendees-ledger.json');
    const extra = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter(f => f !== '_attendees-ledger.json' && !pages.has(f)) : [];
    if (problems.length || extra.length) { console.error(`world-v1-attendees differs from the generator: ${[...problems, ...extra].slice(0, 10).join(', ')}`); process.exit(1); }
    console.log(`world-v1-attendees: ${pages.size} pages match ${WORLD_V1_ATTENDEES_VERSION}; corpus ${corpusFingerprint(ledger)}`);
  } else {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    for (const [f, c] of pages) writeFileSync(join(OUT_DIR, f), c);
    writeFileSync(join(OUT_DIR, '_attendees-ledger.json'), ledgerText);
    console.log(`wrote ${pages.size} pages to ${OUT_DIR}; ${ledger.perturbed} of ${ledger.meetings} meeting lists perturbed; corpus ${corpusFingerprint(ledger)}`);
  }
}
