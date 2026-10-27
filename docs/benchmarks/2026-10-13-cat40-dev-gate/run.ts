// d4b gate runner: builds keyless brains for W (a798de1f, all-on) and B (09d21554d) under conditions O and E,
// then records every surface's served output per case. Zero providers: run with provider keys unset.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
const H = '/home/user/.capy/work/wt-dev-harness';
const { GbrainSlot, MeteringProxy } = await import(`${H}/eval/runner/cat40/gbrain-arm.ts`);
const { prepareBuild } = await import(`${H}/eval/runner/lifecycle/builds.ts`);

const ROOT = import.meta.dir;
const REPO = '/home/user/.capy/work/gbrain-wave';
const ALL_ON: Array<[string, string]> = [
  ['entity.names_references', 'true'], ['entity.record_types', 'contract,amendment'], ['entity.row_page_status', 'true'],
  ['search.long_page_unit', 'section'], ['search.long_page_min_chars', '20000'], ['mcp.instructions_governing_rule', 'in_effect'],
];
const BUILDS = {
  W: { ref: 'a798de1f966dcce401546170b9c1882b1fb56904', config: ALL_ON, buildConfig: [['mentions.owner_phrases', 'true']] as Array<[string, string]> },
  B: { ref: '09d21554d', config: [] as Array<[string, string]>, buildConfig: [] as Array<[string, string]> },
};
const { cases } = JSON.parse(readFileSync(join(ROOT, 'cases.json'), 'utf8'));
const walk = (d: string): string[] => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);

const proxy = new MeteringProxy();
proxy.start();
const out: Record<string, unknown> = {};
try {
  for (const [name, b] of Object.entries(BUILDS)) {
    const root = join(ROOT, 'work', name);
    const build = prepareBuild(REPO, { label: 'under-test', ref: b.ref, description: `d4b gate ${name}` }, join(root, 'builds'));
    for (const cond of ['O', 'E']) {
      const dir = join(ROOT, 'pages', cond);
      const docs = walk(dir).map(p => ({ id: relative(dir, p).replace(/\.md$/, ''), type: /\ntype: "?([\w-]+)/.exec(readFileSync(p, 'utf8'))![1], path: p }));
      const slot = new GbrainSlot(`slot-${cond}`, join(root, 'slots'), build.dir, proxy.port, 'starter', null, true);
      slot.buildConfig = b.buildConfig;
      const built = await slot.build({ docs }, proxy, false, { render: (d: { path: string }) => readFileSync(d.path, 'utf8'), embed: false });
      const run = async (config: Array<[string, string]>, calls: (c: (n: string, a: Record<string, unknown>) => Promise<string>) => Promise<Record<string, unknown>>) => {
        slot.config = config;
        await slot.restore();
        try { return await calls((n, a) => slot.client!.call(n, a)); } finally { await slot.stop(); }
      };
      const perCase: Record<string, Record<string, string>> = {};
      const main = await run(b.config, async call => {
        const r: Record<string, Record<string, string>> = {};
        for (const c of cases) {
          const pack = await call('context_pack', { entities: c.accounts.join(',') });
          r[c.id] = {
            S1: await call('entity', { names: c.accounts }),
            S2: await call('entity', { name: c.accounts[0] }),
            S3S4: pack,
            S5: await call('search', { query: c.query }),
            S7: await call('search', { query: c.query, snippet_chars: 300 }),
            S8: await call('search', { query: c.query, token_budget: 2000 }),
            S9: await call('search', { query: c.query, token_budget: 24000 }),
          };
        }
        return { cases: r, instructions: slot.client!.instructions, tools: slot.client!.tools.map(t => t.name) };
      });
      Object.assign(perCase, (main as { cases: Record<string, Record<string, string>> }).cases);
      if (name === 'W') {
        const off = await run(b.config.map(([k, v]) => [k, k === 'search.long_page_unit' ? 'off' : v] as [string, string]), async call => {
          const r: Record<string, string> = {};
          for (const c of cases) r[c.id] = await call('search', { query: c.query });
          return r;
        });
        for (const c of cases) perCase[c.id].S6 = (off as Record<string, string>)[c.id];
      }
      out[`${name}-${cond}`] = { ref: b.ref, commit: build.commit, version: build.version, config: Object.fromEntries(b.config), build_config: Object.fromEntries(b.buildConfig),
        owner_phrases: built.owner_phrases, extract: built.steps.find((s: { step: string }) => s.step === 'extract')?.tail, instructions_sha256: new Bun.CryptoHasher('sha256').update(String((main as { instructions: string }).instructions)).digest('hex'),
        tools: (main as { tools: string[] }).tools, cases: perCase };
      console.error(`[d4b] ${name}-${cond} done (${build.version} ${build.commit.slice(0, 9)})`);
    }
  }
} finally { proxy.stop(); }
mkdirSync(join(ROOT, 'results'), { recursive: true });
writeFileSync(join(ROOT, 'results', 'outputs.json'), JSON.stringify(out, null, 1));
console.error('[d4b] wrote results/outputs.json');
