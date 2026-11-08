// Deterministic synthetic skill catalogs. Each catalog of size N is the first
// N skills of one 1,500-skill master list (so 50 ⊂ 150 ⊂ 300 ⊂ 750 ⊂ 1,500).
// Description lengths are drawn from description-lengths.json: pick one of the
// three public sources with equal probability, then one of its skills, and
// use that skill's length. Names and text are invented placeholders.
//
// Usage: bun catalog.ts <n> <out-dir>   (writes <out-dir>/<name>/SKILL.md)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SEED = 377;
export const MASTER_SIZE = 1500;
export const SIZES = [50, 150, 300, 750, 1500];

export type SyntheticSkill = { name: string; description: string };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAME_WORDS = (
  "audit backup billing brief budget calendar canary changelog chart cleanup contract crm deck deploy design digest docs " +
  "email expense export feedback forecast grant hiring import inbox incident invoice journal ledger lint meeting memo " +
  "metrics migrate notes onboard outline payroll pitch plan podcast policy postmortem pricing profile qa recap recruit " +
  "release report research retro review roadmap schema scorecard security sitemap slides snapshot spec standup survey " +
  "sync task test ticket timeline transcript travel triage tutorial update vendor video webhook weekly wiki"
).split(" ");

const TEXT_WORDS = (
  "use when the user asks to draft check update summarize prepare review plan export import clean track compare " +
  "a an the this that their weekly monthly quarterly project team customer vendor release meeting report page note " +
  "file sheet ticket task list record entry draft version summary outline checklist schedule budget invoice " +
  "and or then before after with from into for each every new old open closed pending recent shared local " +
  "steps rules format fields owners dates totals changes links sources examples placeholders acme-example alice-example"
).split(" ");

export function lengthPool(path = join(import.meta.dir, "description-lengths.json")): number[][] {
  const data = JSON.parse(readFileSync(path, "utf8"));
  return data.sources.map((s: { skills: Array<{ chars: number }> }) => s.skills.map((x) => x.chars));
}

function description(rand: () => number, length: number): string {
  let text = "Use when the user asks to";
  while (text.length < length + 20) text += " " + TEXT_WORDS[Math.floor(rand() * TEXT_WORDS.length)];
  return text.slice(0, length - 1).trimEnd() + ".";
}

export function masterCatalog(pool = lengthPool()): SyntheticSkill[] {
  const rand = mulberry32(SEED);
  const used = new Set<string>();
  const skills: SyntheticSkill[] = [];
  while (skills.length < MASTER_SIZE) {
    const a = NAME_WORDS[Math.floor(rand() * NAME_WORDS.length)];
    const b = NAME_WORDS[Math.floor(rand() * NAME_WORDS.length)];
    let name = `${a}-${b}`;
    for (let k = 2; used.has(name); k++) name = `${a}-${b}-${k}`;
    used.add(name);
    const source = pool[Math.floor(rand() * pool.length)];
    const length = source[Math.floor(rand() * source.length)];
    skills.push({ name, description: description(rand, length) });
  }
  return skills;
}

export function writeCatalog(skills: SyntheticSkill[], dir: string): void {
  for (const s of skills) {
    mkdirSync(join(dir, s.name), { recursive: true });
    writeFileSync(
      join(dir, s.name, "SKILL.md"),
      `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n# ${s.name}\n\nPlaceholder body for a synthetic skill used to measure skill listings.\n`,
    );
  }
}

if (import.meta.main) {
  const n = Number(process.argv[2]);
  const out = process.argv[3];
  if (!SIZES.includes(n) || !out) throw new Error("usage: bun catalog.ts <50|150|300|750|1500> <out-dir>");
  writeCatalog(masterCatalog().slice(0, n), out);
}
