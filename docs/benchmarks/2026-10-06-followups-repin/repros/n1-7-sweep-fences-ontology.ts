// N1-7: one serve-resident maintenance sweep (`gbrain sweep --once`, what `gbrain serve` runs after ~3 s of stdin
// silence) makes an acknowledged ontology observation unreadable. Since gbrain 7007ba60 (#6024, v0.60.53.0) the
// sweep's facts reconcile (runExtractFacts) first fences every `row_num IS NULL` fact row of the source onto its
// entity page (facts/unfenced-facts.ts planUnfencedFacts). Ontology observations (ontology_propose ->
// mergeOntologyFact) are `row_num IS NULL` rows with a `dimension`, so they are fenced too, and ontology_get loses them.
// The fenced row then belongs to the page's fence: the next page write plus sweep expires it as a row that left the
// fence. Keyless; exit 1 while the bug reproduces, 0 when the observation survives with its own source.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { finish, gbrain, keylessHome } from '../../2026-10-03-wave8-f1-repin/checks/lib.ts';

const h = keylessHome();
const repo = mkdtempSync(join(tmpdir(), 'n1-7-repo-'));
mkdirSync(join(repo, 'people'), { recursive: true });
const page = '---\ntitle: Alder Example\ntype: person\n---\nAlder Example is a fictional engineer.\n\n## Facts\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Alder Example likes example tea | preference | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->\n';
writeFileSync(join(repo, 'people/alder-example.md'), page);
const init = await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env, repo);
const imp = await gbrain(['import', repo, '--no-embed'], h.env, repo);
const propose = await gbrain(['call', 'ontology_propose', JSON.stringify({ entity: 'people/alder-example', dimension: 'location', value: 'Example City', valid_from: '2026-02-01', source: 'manual', visibility: 'world', confidence: 0.9 })], h.env, repo);
const read = async () => { const r = await gbrain(['call', 'ontology_get', JSON.stringify({ entity: 'people/alder-example' })], h.env, repo); return { code: r.code, location: /"dimension":\s*"location"[^}]*?"value":\s*"([^"]+)"|"value":\s*"([^"]+)"[^}]*?"dimension":\s*"location"/.exec(r.stdout)?.slice(1).find(Boolean) ?? null, raw: r.stdout.slice(0, 600) }; };
const before = await read();
const sweep = await gbrain(['sweep', '--once', '--json'], h.env, repo);
const afterFirst = await read();
// The agent then rewrites the page (an ordinary put_page of its own text, which has no ontology row in its fence).
const got = await gbrain(['call', 'get_page', JSON.stringify({ slug: 'people/alder-example' })], h.env, repo);
const revision = /"revision":\s*"([^"]+)"/.exec(got.stdout)?.[1];
const rewrite = await gbrain(['call', 'put_page', JSON.stringify({ slug: 'people/alder-example', content: page.replace('example tea', 'example coffee'), expected_revision: revision })], h.env, repo);
const sweep2 = await gbrain(['sweep', '--once', '--json'], h.env, repo);
const after = await read();
h.cleanup();
finish('n1-7-sweep-fences-ontology', {
  setup_ok: init.code === 0 && imp.code === 0 && propose.code === 0 && sweep.code === 0 && rewrite.code === 0 && sweep2.code === 0,
  readable_before_sweep: before.location === 'Example City',
  source_kept_after_first_sweep: /"source":\s*"manual"/.test(afterFirst.raw),
  readable_after_rewrite_and_sweep: after.location === 'Example City',
}, { init: init.code, import: imp.code, propose: propose.stdout.slice(0, 300), before, afterFirst, rewrite: { code: rewrite.code, out: (rewrite.stdout + rewrite.stderr).slice(0, 900) }, after });
