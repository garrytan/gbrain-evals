/**
 * Prove the vendored scoreSkillMatch (rank.ts) equals gbrain's at the pinned
 * commit: score every turn against every core skill (with triggers) both ways.
 *
 *   bun scripts/check-a2.ts <gbrain-checkout>   -> results/check-a2.json
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DIR, readJsonl } from './lib.ts';
import { scoreSkillMatch, view, type Skill } from './rank.ts';

const root = process.argv[2];
const gb = await import(join(root, 'src/core/skill-catalog.ts'));
const cat = view(readJsonl<Skill>(join(DIR, 'data/catalog.jsonl')), 1500, 'T');
const turns = [...readJsonl<{ text: string }>(join(DIR, 'data/dev.jsonl')), ...readJsonl<{ text: string }>(join(DIR, 'data/test.jsonl'))];
let compared = 0, mismatches = 0;
for (const t of turns) for (const s of cat) {
  compared++;
  if (JSON.stringify(gb.scoreSkillMatch(s, t.text)) !== JSON.stringify(scoreSkillMatch(s, t.text))) mismatches++;
}
const out = { gbrain_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), compared, mismatches };
writeFileSync(join(DIR, 'results/check-a2.json'), JSON.stringify(out, null, 1) + '\n');
console.log(out);
