// Materializes gbrain's bundled skills for the native arm through the same CLI the spring
// arm uses (`gbrain bundled-skill <name> --json`, `--asset <path> --json`), so both arms carry
// identical text: every skill's SKILL.md at <name>/SKILL.md and every file a skill names at
// its relative path, so links like ../conventions/brain-first.md resolve.
// bun export-bundled.ts <gbrain launcher> <out dir>
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'bun';
const [gbrain, out] = process.argv.slice(2);
const home = mkdtempSync(join(tmpdir(), 'skeval-export-'));
const call = (args: string[]) => {
  const r = spawnSync([gbrain!, 'bundled-skill', ...args, '--json'], { env: { ...process.env, HOME: home } });
  if (r.exitCode !== 0) throw new Error('bundled-skill ' + args.join(' ') + ' failed: ' + r.stderr.toString());
  return JSON.parse(r.stdout.toString());
};
const put = (rel: string, text: string) => { const p = join(out!, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const list = call([]);
let files = 0;
for (const s of list.skills as Array<{ name: string }>) {
  const d = call([s.name]);
  put(s.name + '/SKILL.md', d.content); files++;
  for (const a of d.assets as string[]) if (!existsSync(join(out!, a))) { put(a, call([s.name, '--asset', a]).content); files++; }
}
console.log(JSON.stringify({ skills: list.skills.length, files, catalog: list.catalog }));
