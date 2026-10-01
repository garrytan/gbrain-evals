/**
 * Records the N9 findings that came from reading the hermetic receipt and the
 * minimal repro, in the shared wave bug ledger. N9-1 (the composed-plan
 * feature gap) is written by the runner itself with --record-bugs.
 *
 *   bun docs/benchmarks/2026-10-01-n9-multi-hop/record-findings.ts
 */
import { upsertBug, type BugEntry } from '../../../eval/runner/bug-ledger.ts';

const SHA = '3a284aea26889b77c633aebb4149c3016d834ee6';
const REPRO = 'env -u OPENAI_API_KEY GBRAIN_HOME=$(mktemp -d) bun docs/benchmarks/2026-10-01-n9-multi-hop/repro-relational-edges.ts';

export const N9_MANUAL_FINDINGS: BugEntry[] = [
  {
    id: 'N9-2', category: 'multi-hop-paraphrase', classification: 'bug', gbrain_sha: SHA,
    contract: 'gbrain maps frontmatter `investors:` on company pages and `attendees:` on meeting pages as incoming edges (person to company invested_in, person to meeting attended): src/core/link-extraction.ts:1333-1344 FRONTMATTER_LINK_MAP, direction incoming ("subject of the verb lives elsewhere").',
    surface: 'src/core/link-extraction.ts:1724 extractFrontmatterLinks (schema-pack mappings are built with direction outgoing)',
    repro: REPRO,
    expected: 'with the default schema pack, `extract links --source db --include-frontmatter` stores people/bob-example -> companies/gamma-example (invested_in) and people/alice-example -> meetings/board-beta-example (attended); relationalFanout from the company in the parsed direction (in) returns people/bob-example',
    actual: 'stored companies/gamma-example -> people/bob-example and meetings/board-beta-example -> people/alice-example, people/bob-example; the fanout returns []. Every field the default pack declares in frontmatter_links (company investors, key_people, partner; deal investors, lead; meeting attendees) is written outgoing, reversing the in-code map, so "Who invested in X?" and "Who attended X?" miss frontmatter-derived edges',
    status: 'open',
  },
  {
    id: 'N9-3', category: 'multi-hop-paraphrase', classification: 'bug', gbrain_sha: SHA,
    contract: 'Attendance written on a meeting page is stored person to meeting (src/core/link-extraction.ts:938 orientCanonicalAttendance, used by resolvedLinkCandidate :926-936; src/core/derived-links.ts reversedAttendance), the direction the relational parser walks for "Who attended X?" (src/core/search/relational-intent.ts attended verb, direction in).',
    surface: 'src/core/link-extraction.ts:665-671 typeFor (the pack page-type-bound verb is returned before the canonical-attendance branch at :673-685)',
    repro: REPRO,
    expected: 'the body line "Attendees: [Alice Example](people/alice-example), [Bob Example](people/bob-example)" on meetings/board-acme-example is stored people/alice-example -> meetings/board-acme-example (and Bob likewise), as extractPageLinks produces when no pack is passed; fanout in direction in from the meeting returns both attendees',
    actual: 'with the default schema pack (gbrain-base.yaml link_types: attended, page_type: meeting) the edges are stored meetings/board-acme-example -> people/alice-example and -> people/bob-example; typeFor returns { linkType: attended } without canonicalAttendance, so nothing reorients them; fanout in direction in returns [] (direction out returns both)',
    status: 'open',
  },
  {
    id: 'N9-4', category: 'multi-hop-paraphrase', classification: 'bug', gbrain_sha: SHA,
    contract: 'src/core/search/relational-intent.ts:14-18 and :164-169: the parser emits a "Who attended X?" archetype whose seed X is a meeting, and the arm fires when the seed resolves; src/core/search/relational-recall.ts:94-104 resolves seeds with resolveEntitySlugWithSource and drops fallback_slugify results.',
    surface: 'src/core/search/relational-recall.ts:94-104 resolveSeedScoped -> src/core/entities/resolve.ts:257 resolveEntitySlugWithSource',
    repro: REPRO,
    expected: '"Who attended Acme Example Board Meeting?" resolves its seed to meetings/board-acme-example (the exact page title) and the relational arm fires',
    actual: 'the seed resolves only to fallback_slugify "acme-example-board-meeting", because the resolver returns people, companies, hosts, projects and concepts basenames and entity pages only (resolve.ts:209-227, :517-526); the arm reports seeds_resolved 0 and never fires. In the N9 hermetic run, 0 of 150 world-v1 "Who attended" template runs fired',
    status: 'open',
  },
  {
    id: 'N9-5', category: 'multi-hop-paraphrase', classification: 'feature-gap', gbrain_sha: SHA,
    contract: 'None broken: src/core/entities/resolve.ts:13-21 and :32-34 document that a bare one-word name resolves only when prefix expansion finds exactly one candidate; collisions fall through.',
    surface: 'src/core/entities/resolve.ts:280-283 resolveEntitySlugWithSource (bare-name prefix expansion)',
    repro: 'bun eval/runner/n9-multi-hop-paraphrase.ts (data.one_hop.per_query: parsed true, seeds_resolved 0, templates works_at, invested_in, advises)',
    expected: 'as a capability: "Who works at Acme?" resolves Acme to companies/acme-0, whose title is exactly "Acme"',
    actual: '"Acme" collides with companies/acme-labs-50 under prefix expansion, falls back to slugify and the arm does not fire. 15 of 145 world-v1 one-hop template questions are affected (8 works_at, 5 invested_in, 2 advises: Acme, Delta, Epsilon, Helix, Iris, Nimbus, Quantum, Vector)',
    status: 'deferred',
    reason: 'documented precision-first resolver design, not a broken contract; an exact-title tier for bare names would be a product change',
  },
];

if (import.meta.main) {
  for (const f of N9_MANUAL_FINDINGS) upsertBug(f);
  console.log(`recorded ${N9_MANUAL_FINDINGS.map(f => f.id).join(', ')}`);
}
