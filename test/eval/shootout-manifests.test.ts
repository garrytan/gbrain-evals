/**
 * The Phase 4 draft cell manifests (docs/benchmarks/2026-10-06-oss-memory-shootout/manifests) load, every arms file
 * they name parses, parameters switch and scale cells, and no recipe cell runs LongMemEval-S. Keyless.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Campaign, loadCampaign } from '../../eval/runner/shootout-cell.ts';
import { loadArms } from '../../eval/runner/memory-qa/arms.ts';

const ROOT = resolve(import.meta.dir, '../..');
const DIR = join(ROOT, 'docs/benchmarks/2026-10-06-oss-memory-shootout/manifests');
const withParams = (params: Record<string, unknown>) => {
  const tmp = mkdtempSync(join(tmpdir(), 'manifests-'));
  const c = JSON.parse(readFileSync(join(DIR, 'campaign.json'), 'utf8'));
  writeFileSync(join(tmp, 'campaign.json'), JSON.stringify({ ...c, parameters: { ...c.parameters, ...params }, cells_from: c.cells_from.map((f: string) => join(DIR, f)) }));
  return loadCampaign(join(tmp, 'campaign.json')).manifest;
};

describe('Phase 4 draft manifests', () => {
  const { manifest } = loadCampaign(join(DIR, 'campaign.json'));
  test('load, with every arms file present and valid and every vendor stack present', () => {
    expect(manifest.cells.length).toBeGreaterThan(40);
    for (const c of manifest.cells) {
      for (const m of c.command.matchAll(/--arms (\S+)/g)) { expect(existsSync(join(ROOT, m[1]))).toBe(true); loadArms(join(ROOT, m[1])); }
      for (const m of c.command.matchAll(/up --system (\S+)/g)) expect(existsSync(join(ROOT, 'eval/systems', m[1], 'docker-compose.yml'))).toBe(true);
      expect(c.setup_command).toContain('eval/systems/bootstrap.sh setup');
      expect(c.lease_usd).toBeGreaterThan(0);
    }
    for (const f of ['four-arms', 'full-context', 'no-memory', 'd2-frontier']) for (const b of ['locomo', 'lme-s', 'beam-100k']) loadArms(join(DIR, 'arms', `${f}-${b}.json`));
  });
  test('recipe cells stay off LongMemEval-S, and LoCoMo is ingested twice per configuration', () => {
    expect(manifest.cells.filter(c => c.config === 'recipe' && c.id.includes('lme-s'))).toEqual([]);
    const noVariance = new Set(['gbrain-legacy', 'full-context', 'no-memory']);
    const systems = [...new Set(manifest.cells.filter(c => c.id.includes('-locomo-r1') && !noVariance.has(c.system)).map(c => `${c.system}:${c.config}`))];
    expect(systems.length).toBe(15);
    for (const s of systems) expect(manifest.cells.some(c => `${c.system}:${c.config}` === s && c.id.endsWith('locomo-r2') && c.command.includes('--ingest-replicate 2'))).toBe(true);
  });
  test('gbrain runs at the pin and at frozen master; no lease is reserved before the master SHA is filled', () => {
    const master = manifest.cells.filter(c => c.system === 'gbrain-shootout-master');
    expect(master.map(c => c.id).sort()).toEqual(['gbrain-shootout-master-common-beam-100k', 'gbrain-shootout-master-common-lme-s', 'gbrain-shootout-master-common-locomo-r1', 'gbrain-shootout-master-common-locomo-r2',
      'gbrain-shootout-master-recipe-beam-100k', 'gbrain-shootout-master-recipe-locomo-r1', 'gbrain-shootout-master-recipe-locomo-r2']);
    const sha = String(manifest.parameters!.gbrain_master_sha);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(master.every(c => c.command.includes(`--gbrain "$HOME/gbrain-master@${sha}"`) && c.setup_command!.includes(`checkout -q ${sha}`))).toBe(true);
    expect(manifest.cells.filter(c => c.system === 'gbrain-shootout').every(c => !c.command.includes('--gbrain'))).toBe(true);
    const tmp = mkdtempSync(join(tmpdir(), 'unfilled-'));
    const c = JSON.parse(readFileSync(join(DIR, 'campaign.json'), 'utf8'));
    writeFileSync(join(tmp, 'campaign.json'), JSON.stringify({ ...c, ledger: join(tmp, 'l.sqlite'), parameters: { ...c.parameters, gbrain_master_sha: 'fill-at-freeze' }, cells_from: c.cells_from.map((f: string) => join(DIR, f)) }));
    const camp = new Campaign(join(tmp, 'campaign.json'), join(tmp, 'state'));
    camp.init();
    expect(() => camp.reserve('mem0-common-locomo-r1')).toThrow(/gbrain_master_sha are still fill-at-freeze/);
    const filled = withParams({ gbrain_master_sha: 'b51ad15ff45e74348df9991b5673cff5a58b10cb' });
    expect(filled.cells.find(x => x.id === 'gbrain-shootout-master-common-lme-s')!.command).toContain('gbrain-master@b51ad15ff45e74348df9991b5673cff5a58b10cb');
  });

  test('the frozen values: cap $1,450, LongMemEval-S 100, Graphiti recipe off BEAM', () => {
    expect([manifest.cap_usd, manifest.parameters]).toEqual([1450, { lme_s_limit: 100, graphiti_beam_recipe: false, gbrain_master_sha: 'c5fb0201d1960a0a5a81c35d77718311b03154b7' }]);
  });

  test('parameters: the Graphiti BEAM recipe cell switches off, and LongMemEval-S leases follow the slice', () => {
    const lme = (m: typeof manifest) => m.cells.filter(c => c.id.includes('lme-s')).reduce((s, c) => s + c.lease_usd, 0);
    const off = withParams({ graphiti_beam_recipe: false, lme_s_limit: 50 });
    expect(manifest.cells.some(c => c.id === 'graphiti-recipe-beam-100k')).toBe(false);
    expect(withParams({ graphiti_beam_recipe: true }).cells.some(c => c.id === 'graphiti-recipe-beam-100k')).toBe(true);
    expect(off.cells.some(c => c.id === 'graphiti-recipe-beam-100k')).toBe(false);
    expect(lme(off)).toBeLessThan(lme(manifest) * 0.55);
    expect(off.cells.find(c => c.id === 'mem0-common-lme-s')!.command).toContain('--limit 50');
  });
});
