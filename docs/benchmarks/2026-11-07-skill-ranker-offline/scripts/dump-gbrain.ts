/**
 * Dump gbrain's bundled skills, their RESOLVER.md routing rows and the spring
 * index block from a gbrain checkout, so the catalog builder never imports
 * gbrain at rank time.
 *
 *   bun docs/benchmarks/2026-11-07-skill-ranker-offline/scripts/dump-gbrain.ts <gbrain-checkout> > data/gbrain-bundled.json
 */
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
if (!root) throw new Error('usage: dump-gbrain.ts <gbrain-checkout>');
const bundled = await import(join(root, 'src/core/skills/bundled.ts'));
const spring = await import(join(root, 'src/core/skills/spring-index.ts'));
const triggerIndex = await import(join(root, 'src/core/skill-trigger-index.ts'));

const skills = bundled.bundledSkills('owner');
const routing = new Map<string, string[]>();
for (const e of triggerIndex.loadSkillTriggerIndex(join(root, 'skills'))) {
  if (e.source !== 'resolver_md' || e.isGStack) continue;
  const m = /^skills\/([^/]+)\//.exec(e.skillPath);
  if (!m) continue;
  routing.set(m[1], [...(routing.get(m[1]) ?? []), e.trigger]);
}
const out = {
  gbrain_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  bundled_catalog_id: bundled.bundledCatalogId(),
  spring_block: spring.renderSkillIndexBlock(skills, 'gbrain', { refresh: 'gbrain setup <harness> --skill-loading spring', optOut: 'gbrain setup <harness> --skill-loading off' }),
  skills: await Promise.all(skills.map(async (s: { name: string; audience: string }) => ({
    name: s.name,
    audience: s.audience,
    description: await bundled.bundledSkillDescription(s),
    triggers: bundled.bundledSkillTriggers(s),
    routing: routing.get(s.name) ?? [],
    text: bundled.bundledSkillText(s),
  }))),
};
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
