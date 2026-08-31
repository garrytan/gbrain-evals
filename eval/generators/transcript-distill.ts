/**
 * transcript-distill-v1 deterministic skeleton (Cat 35, Lane A).
 *
 * Produces the STRUCTURED PLAN for 24 fictional agent-session transcripts
 * (6 scenarios x 4 instances). No prose, no LLM calls, no file I/O — this
 * file emits turn plans with authored verbatim anchors; the Opus expansion
 * lives in transcript-distill-gen.ts and must include every anchor verbatim.
 *
 * Corpus shape (all binding, asserted in buildSkeletons):
 *   - 6 scenarios: coding-reflection, startup-ideation, people-deal,
 *     mixed-routine-signal, emotional-processing, pure-routine.
 *   - Instance 4 of each scenario is the 'long-noisy' variant (10-30K chars
 *     target, planted tool-block / log-dump / code-snippet noise turns);
 *     instances 1-3 are 'prose' (>=2200 chars, 12-24 turns).
 *   - Signal transcripts (5 scenarios) carry 8-12 gold items spanning kinds,
 *     every one with >=1 'vibe' item (emotional-processing: 3+), plus 3-5
 *     distractors. pure-routine: zero golds, 3-5 distractors, triage 'low'.
 *   - Exactly 2 coding-reflection transcripts carry 1 attribution hazard
 *     each (agent-proposed-user-decided, killed-process-not-completed).
 *   - ALL planted specifics are fictional (invented repos quartzlane /
 *     fernpost, fake bug IDs QL-4471 etc., made-up people + companies that
 *     match SCAFFOLD_PAGES). Content NEVER contains the two word-boundary
 *     dream-discovery exclude words (asserted in code, not just intent).
 *   - Anchors: <=120 chars, plain ASCII, natural spoken phrasing, unique
 *     across the WHOLE corpus. Gold statements unique per corpus and never
 *     contain their own anchor verbatim (paraphrase-level).
 *   - Timestamps derive from the transcript index (2026-08-01..2026-08-12),
 *     never Date.now.
 *
 * Determinism: seeded Mulberry32 (same idiom as amara-life.ts). Same seed
 * -> identical output (pinned by test/eval/transcript-distill.test.ts).
 *
 * Run: bun eval/generators/transcript-distill.ts   # prints corpus summary
 */

// ─── Types (the runner + Lane B depend on these exact shapes) ─────────

export type Scenario =
  | 'coding-reflection'
  | 'startup-ideation'
  | 'people-deal'
  | 'mixed-routine-signal'
  | 'emotional-processing'
  | 'pure-routine';

export interface GoldItem {
  item_id: string;
  kind: 'fact' | 'idea' | 'decision' | 'vibe' | 'entity';
  statement: string;
  verbatim_anchor: string;
  notability: 'high' | 'medium' | 'low';
  planted_turn: number;
  depth_bucket: 'early' | 'middle' | 'late';
}

export interface Distractor {
  distractor_id: string;
  statement: string;
  anchor: string;
  planted_turn: number;
}

export interface AttributionHazard {
  hazard_id: string;
  type: 'agent-proposed-user-decided' | 'killed-process-not-completed';
  wrong_claim: string;
  anchor: string;
  planted_turn: number;
}

export interface TurnPlan {
  role: 'user' | 'assistant';
  brief: string;
  must_include_anchors: string[];
  noise: 'tool-block' | 'log-dump' | 'code-snippet' | null;
}

export interface TranscriptSkeleton {
  transcript_id: string;
  scenario: Scenario;
  variant: 'prose' | 'long-noisy';
  session_id: string;
  base_ts: string;
  date: string;
  expected_triage: 'high' | 'low';
  entities: string[];
  turns: TurnPlan[];
  items: GoldItem[];
  distractors: Distractor[];
  hazards: AttributionHazard[];
}

export const CORPUS_SEED = 350001;

// ─── Seeded PRNG (Mulberry32) ────────────────────────────────────────

// Chose Mulberry32 over Lehmer MINSTD: JS `%` on 32-bit products goes
// negative, and Lehmer needs Schrage's method or BigInt to stay in range.
// Mulberry32 is single-Math.imul-per-step, no overflow, seeds cleanly.
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Brain scaffold (seeded into every eval engine for wikilink targets) ──

/** ~10 small fictional pages. Slugs are one-slash and match the entity
 *  names planted in the transcripts below. */
export const SCAFFOLD_PAGES: { slug: string; body: string }[] = [
  {
    slug: 'people/mira-voss',
    body: `---
type: person
title: Mira Voss
---
Mira Voss is an angel investor and former operations lead who writes small early checks in developer tools and scheduling software. She is famous among founders for blunt one-line feedback that lands harder than a full memo. The user runs most new product ideas past her, including the [[concepts/driftless-scheduling]] concept. She prefers a monthly written update over coffee catch-ups. Her pet thesis is that scheduling products die on distribution, not product.
`,
  },
  {
    slug: 'people/casper-hale',
    body: `---
type: person
title: Casper Hale
---
Casper Hale is a staff engineer and a longtime collaborator on the user's open-source projects. He reviews most substantial changes to [[concepts/quartzlane]] and occasionally the [[concepts/fernpost]] site. His code reviews are thorough to a fault and famously blunt in tone. He runs his own quartzlane install in production, so he tends to catch regressions before anyone else. He and the user trade toolchain-pinning war stories.
`,
  },
  {
    slug: 'people/anouk-verlinden',
    body: `---
type: person
title: Anouk Verlinden
---
Anouk Verlinden is the founder and CEO of [[companies/lumopact]], a freight-emissions analytics startup. She stays calm under hostile diligence questioning, which the user reads as a strong founder signal. She previously ran logistics operations at a mid-size Nordic retailer. The user is advising her informally through her seed round and the [[companies/ostrafell]] pilot negotiation. She negotiates her own terms and rarely brings a lawyer to a first read.
`,
  },
  {
    slug: 'people/tomas-brekke',
    body: `---
type: person
title: Tomas Brekke
---
Tomas Brekke is a partner at [[companies/vantabrook]] where he leads early-stage logistics and climate-adjacent deals. He is running point on the [[companies/lumopact]] seed round. Founders describe him as tough but straight: he pushes hard on terms and never games a process. His standard documents carry a few clauses that first-time founders tend to miss. The user has sat across from him in two prior negotiations.
`,
  },
  {
    slug: 'companies/lumopact',
    body: `---
type: company
title: Lumopact
---
Lumopact is a fictional freight-emissions analytics startup founded by [[people/anouk-verlinden]]. It ingests carrier and route data and estimates per-shipment emissions for retail fleets. Its first pilot with a Nordic grocer produced a measurable cut in estimated freight emissions. The team is seven people, five of them engineers. The company is raising a seed round led by [[companies/vantabrook]] and negotiating a large pilot with [[companies/ostrafell]].
`,
  },
  {
    slug: 'companies/vantabrook',
    body: `---
type: company
title: Vantabrook Capital
---
Vantabrook Capital is a fictional seed-stage fund focused on logistics, climate-adjacent software, and infrastructure tools. [[people/tomas-brekke]] is the partner the user deals with most. The fund runs a scout program that writes small first checks into pre-seed companies. Its standard deal documents are founder-legible but contain a couple of clauses worth flagging. Vantabrook is leading the [[companies/lumopact]] seed round.
`,
  },
  {
    slug: 'companies/ostrafell',
    body: `---
type: company
title: Ostrafell
---
Ostrafell is a fictional Nordic grocery chain with several hundred stores and a large refrigerated freight fleet. Its procurement process is slow, formal, and requires a named executive sponsor before any pilot is signed. The sustainability team reports to the brand organization, which shapes how vendors pitch. Ostrafell is negotiating a multi-store pilot with [[companies/lumopact]]. The fleet manager is the most likely executive sponsor for that deal.
`,
  },
  {
    slug: 'concepts/quartzlane',
    body: `---
type: concept
title: Quartzlane
---
Quartzlane is the user's fictional open-source log-search CLI, kept in the 'quartzlane' repo. It ships an ingest queue, a tokenizer, a snapshot loader, and a replay harness that can re-run recorded event logs. Bug IDs use the QL- prefix. [[people/casper-hale]] reviews most large changes and runs his own install. The project is the user's main open-source time sink and the source of both pride and recurring maintenance guilt.
`,
  },
  {
    slug: 'concepts/fernpost',
    body: `---
type: concept
title: Fernpost
---
Fernpost is the user's fictional static-site publishing tool and the personal site built with it, kept in the 'fernpost' repo. Bug IDs use the FP- prefix. It renders markdown to a small fast site with an RSS feed, and rebuilds finish in seconds. A handful of strangers genuinely read the site, which continues to delight the user. It descends from tidelamp, the user's first finished app.
`,
  },
  {
    slug: 'concepts/driftless-scheduling',
    body: `---
type: concept
title: Driftless scheduling
---
Driftless scheduling is the user's recurring product idea: software that automatically defragments a calendar to protect long focus blocks. The wedge under discussion is auto-rescheduling internal one-on-ones, the meetings nobody defends. [[people/mira-voss]] has given repeated blunt feedback on it, mostly about distribution. The user keeps returning to this idea more persistently than to any previous one. Validation is currently interview-driven, before any code exists.
`,
  },
];

// ─── Internal spec shapes ─────────────────────────────────────────────

type Voice = 'user' | 'assistant';

interface ItemSpec {
  kind: GoldItem['kind'];
  notability: GoldItem['notability'];
  statement: string;
  anchor: string;
  voice: Voice;
}

interface DistractorSpec {
  statement: string;
  anchor: string;
  voice: Voice;
}

interface HazardSpec {
  type: AttributionHazard['type'];
  wrong_claim: string;
  anchor: string;
  voice: Voice;
  /** Fractional position in the turn list (0..1). */
  pos: number;
  /** Appended to the brief of the turn BEFORE the hazard turn (sets up the trap). */
  preContext: string;
  /** Appended to the hazard turn's brief. */
  context: string;
}

interface TranscriptSpec {
  scenario: Scenario;
  n: number; // 1..4 within the scenario
  turnCount: number;
  theme: string;
  entities: string[];
  beats: string[];
  golds: ItemSpec[];
  distractors: DistractorSpec[];
  hazards: HazardSpec[];
}

function g(
  kind: GoldItem['kind'],
  notability: GoldItem['notability'],
  statement: string,
  anchor: string,
  voice: Voice = 'user'
): ItemSpec {
  return { kind, notability, statement, anchor, voice };
}

function d(statement: string, anchor: string, voice: Voice = 'user'): DistractorSpec {
  return { statement, anchor, voice };
}

// ─── The 24 transcript specs (6 scenarios x 4 instances) ─────────────

const SPECS: TranscriptSpec[] = [
  // ══ coding-reflection ═════════════════════════════════════════════
  {
    scenario: 'coding-reflection', n: 1, turnCount: 16,
    theme: 'Debugging session on the quartzlane repo: bug QL-4471, duplicate events downstream of the ingest queue. The user and assistant trace a worker race, argue about the fix, verify with the replay harness, and reflect.',
    entities: ['concepts/quartzlane', 'people/casper-hale'],
    beats: [
      'User describes bug QL-4471: duplicate events showing up downstream of the quartzlane ingest queue.',
      'Assistant helps trace the race condition in the batch-claim path.',
      'They debate fix options for the dedupe and the user makes the call.',
      'They verify the fix with the replay harness and discuss the numbers.',
      'Wrap-up: backport plan, review scheduling with Casper Hale, and personal reflection on the week.',
    ],
    golds: [
      g('fact', 'high', 'Bug QL-4471 in quartzlane was caused by two ingest workers claiming the same batch.', 'two workers were grabbing the same batch off the ingest queue', 'assistant'),
      g('decision', 'high', 'The user chose a content-hash dedupe key for quartzlane ingest instead of lock-based fixes.', "let's go with a content hash as the dedupe key"),
      g('fact', 'medium', 'After the dedupe fix, duplicate rows in the quartzlane replay run dropped from roughly three percent to none.', 'duplicates went from about three percent to zero on the replay run', 'assistant'),
      g('idea', 'medium', 'The user mused that the quartzlane replay harness could become its own standalone library.', 'the replay harness could honestly be its own little library'),
      g('entity', 'medium', 'Casper Hale said he can review the quartzlane queue rewrite next Tuesday.', 'Casper said he can review the queue rewrite next Tuesday'),
      g('vibe', 'high', 'The user felt intense relief once QL-4471 was finally understood after a week of dread.', 'I have been dreading this bug all week and now I feel ten pounds lighter'),
      g('decision', 'medium', 'The user noted they should backport the QL-4471 fix to the quartzlane v3 branch before Friday.', 'backport it to the v3 branch before Friday'),
      g('fact', 'low', 'The quartzlane replay harness processes the full August event log in about a minute and a half.', 'the whole August event log replays in about ninety seconds', 'assistant'),
      g('idea', 'low', 'The user thinks they should write up QL-4471 as a postmortem on the quartzlane wiki.', 'I should write this up as a postmortem on the quartzlane wiki'),
    ],
    distractors: [
      d('CI was slow that morning.', 'CI was crawling this morning for no obvious reason'),
      d('The user refilled coffee mid-session.', 'refilling my coffee before we dig back into the queue logs'),
      d('A formatter pass touched only whitespace.', 'ran the formatter over quartzlane and only whitespace changed', 'assistant'),
      d('The office was hot that day.', 'it is way too warm in this office today'),
    ],
    hazards: [
      {
        type: 'agent-proposed-user-decided',
        wrong_claim: 'The user decided to use Postgres advisory locks for quartzlane ingest dedupe.',
        anchor: 'I hear you on advisory locks but I want the hash approach',
        voice: 'user',
        pos: 0.5,
        preContext: 'The assistant proposes Postgres advisory locks for the dedupe and makes a brief case for them.',
        context: 'The user explicitly declines the advisory-lock proposal and picks the hash approach; the transcript must make clear the locks were only the assistant\'s suggestion, never adopted.',
      },
    ],
  },
  {
    scenario: 'coding-reflection', n: 2, turnCount: 14,
    theme: 'Flaky-test hunt in quartzlane: test QL-4512 in the snapshot loader fails intermittently. They bisect, find toolchain variance, and the user kills a long index rebuild partway to unblock the laptop.',
    entities: ['concepts/quartzlane', 'people/casper-hale'],
    beats: [
      'User reports flaky test QL-4512 in the quartzlane snapshot loader failing intermittently.',
      'They bisect timing assumptions and find variance between wasm toolchain builds.',
      'The user kicks off a full index rebuild, then aborts it partway to free the laptop.',
      'Decision on pinning the wasm toolchain and quarantining the flake.',
      'Reflection on flaky-test hygiene and a follow-up for Casper Hale.',
    ],
    golds: [
      g('fact', 'high', 'Flaky test QL-4512 failed roughly one run in five in the quartzlane snapshot loader.', 'QL-4512 fails about one run in five on the snapshot loader'),
      g('fact', 'high', 'The QL-4512 flake traced back to timing variance between wasm toolchain builds.', 'the variance is coming from the wasm build, not the test itself', 'assistant'),
      g('decision', 'high', 'The user said to pin the quartzlane wasm toolchain to a single blessed version.', 'pin the wasm toolchain to one blessed version and move on'),
      g('decision', 'medium', 'The user chose to quarantine QL-4512 until the pinned toolchain lands.', 'quarantine QL-4512 until the pin lands'),
      g('idea', 'medium', 'The user thinks a flake dashboard ranking quartzlane tests by retry rate would pay for itself.', 'a little dashboard ranking tests by retry rate would pay for itself'),
      g('vibe', 'medium', 'The user felt sheepish about having blamed the test suite instead of the toolchain.', 'I feel a bit sheepish for cursing the test suite all month'),
      g('entity', 'low', 'The user planned to ask Casper Hale which wasm version his team pinned.', 'I will ask Casper which wasm version his team pinned'),
      g('fact', 'low', 'A full quartzlane index rebuild takes about four hours on the user\'s laptop.', 'a full rebuild is about four hours on this laptop'),
    ],
    distractors: [
      d('Lunch was leftover noodles.', 'leftover noodles for lunch again while the bisect runs'),
      d('A neighbor\'s dog kept barking.', 'the neighbor\'s dog has barked through this entire bisect'),
      d('The assistant reformatted a results table.', 'tidied the results table, purely cosmetic', 'assistant'),
      d('The user\'s browser restarted and restored tabs.', 'my browser restarted and ate forty tabs, nothing important'),
    ],
    hazards: [
      {
        type: 'killed-process-not-completed',
        wrong_claim: 'The quartzlane index rebuild ran to completion.',
        anchor: 'I killed the rebuild at maybe forty percent, it never finished',
        voice: 'user',
        pos: 0.45,
        preContext: 'The assistant notes the index rebuild is still running and asks whether to let it finish.',
        context: 'The user says they killed the index rebuild partway through; it never finished and stays unfinished for the rest of the session. No later turn may imply it completed.',
      },
    ],
  },
  {
    scenario: 'coding-reflection', n: 3, turnCount: 16,
    theme: 'Fernpost bug FP-2203: the RSS feed shows duplicate entries after every deploy. They trace GUID churn, pick stable GUIDs plus build-time rendering, test on staging, and reflect on solo maintenance.',
    entities: ['concepts/fernpost'],
    beats: [
      'User describes FP-2203: the fernpost RSS feed shows duplicate entries after every deploy.',
      'They trace the duplicates to rebuild-time GUID churn.',
      'Options weighed: stable GUIDs versus request-time rendering; the user decides.',
      'Testing on the staging site and checking the results.',
      'Wrap-up and reflection on maintaining fernpost solo.',
    ],
    golds: [
      g('fact', 'high', 'FP-2203 duplicates came from fernpost regenerating RSS GUIDs on every deploy.', 'the feed GUIDs churn on every deploy, that is the whole bug', 'assistant'),
      g('decision', 'high', 'The user said fernpost should derive RSS GUIDs from the post slug plus publish date so they stay stable.', 'derive the GUID from slug plus publish date and it stays stable'),
      g('decision', 'medium', 'The user said to render the fernpost feed at build time rather than on request.', 'render the feed at build time, one less moving part'),
      g('fact', 'medium', 'Three fernpost readers emailed about duplicate feed entries within one week.', 'three readers emailed about the duplicates in a single week'),
      g('idea', 'medium', 'The user is considering a fernpost changelog page generated from git history.', 'a changelog page straight from git history could be neat for fernpost'),
      g('vibe', 'medium', 'The user feels quiet pride that strangers actually read fernpost.', 'strangers actually read this thing, which still feels quietly amazing'),
      g('fact', 'low', 'The fernpost staging rebuild finishes in under twenty seconds.', 'staging rebuilds in under twenty seconds now', 'assistant'),
      g('idea', 'low', 'The user may write a short post about debugging FP-2203.', 'might write a short post about chasing FP-2203'),
    ],
    distractors: [
      d('Tea went cold during the trace.', 'my tea went completely cold during that trace'),
      d('The assistant fixed a typo in a code comment.', 'fixed one typo in a code comment along the way', 'assistant'),
      d('It rained all afternoon.', 'it has rained all afternoon here'),
    ],
    hazards: [],
  },
  {
    scenario: 'coding-reflection', n: 4, turnCount: 30,
    theme: 'Long noisy profiling session on quartzlane bug QL-4620: query latency doubled after the tokenizer refactor. Heavy tool output and benchmark logs; they find the hot spot, ship a cache, revert an abstraction, and plan a release.',
    entities: ['concepts/quartzlane', 'people/casper-hale'],
    beats: [
      'User reports QL-4620: quartzlane query latency doubled after the tokenizer refactor; they start profiling.',
      'Assistant runs profiling commands and pastes raw tool output; the hot spot is in the ngram splitter.',
      'They prototype a cache for compiled patterns; benchmark runs pasted as logs.',
      'Decision on shipping the cache and reverting one abstraction from the refactor.',
      'Release planning and reflection on the regression.',
    ],
    golds: [
      g('fact', 'high', 'QL-4620: quartzlane query latency roughly doubled after the tokenizer refactor.', 'latency basically doubled right after the tokenizer refactor'),
      g('fact', 'high', 'Profiling showed the quartzlane ngram splitter recompiling its pattern on every call.', 'the ngram splitter recompiles its pattern on every single call', 'assistant'),
      g('decision', 'high', 'The user indicated shipping a compiled-pattern cache as the fix for the quartzlane tokenizer.', 'ship the compiled pattern cache, that is the fix'),
      g('decision', 'medium', 'The user indicated reverting the strategy interface added in the refactor.', 'revert the strategy interface, it bought us nothing'),
      g('fact', 'medium', 'With the pattern cache, quartzlane p95 query latency fell from 210ms back to 96ms.', 'p95 went from 210 down to 96 with the cache in place', 'assistant'),
      g('idea', 'medium', 'The user wants a perf gate in quartzlane CI that fails p95 regressions over ten percent.', 'a perf gate in CI that fails anything ten percent over baseline'),
      g('vibe', 'medium', 'The user felt embarrassed that the regression shipped in their own refactor.', 'mildly embarrassing that my own refactor did this'),
      g('entity', 'medium', 'Casper Hale flagged the quartzlane latency regression first from his own install.', 'Casper actually flagged it first from his install'),
      g('fact', 'low', 'The quartzlane benchmark suite covers twelve query shapes.', 'the bench suite covers twelve query shapes', 'assistant'),
      g('decision', 'low', 'The user planned to cut quartzlane release 0.9.1 once the cache merges.', 'cut zero nine one as soon as the cache merges'),
    ],
    distractors: [
      d('The profiler UI theme annoyed the user.', 'this profiler theme is burning my eyes'),
      d('A courier interrupted mid-benchmark.', 'courier at the door mid benchmark, one minute'),
      d('The assistant cleaned trailing whitespace.', 'stripped some trailing whitespace while in there', 'assistant'),
      d('The playlist repeated the same song.', 'this playlist has looped the same song three times'),
    ],
    hazards: [],
  },

  // ══ startup-ideation ══════════════════════════════════════════════
  {
    scenario: 'startup-ideation', n: 1, turnCount: 16,
    theme: 'Ideation session on driftless scheduling: calendars fragment focus time and software should defragment them. They sharpen the pitch, pick a wedge, recall Mira Voss\'s feedback, and commit to a validation plan.',
    entities: ['concepts/driftless-scheduling', 'people/mira-voss'],
    beats: [
      'User opens with the driftless scheduling itch: calendars fragment focus time and nobody defends it.',
      'They sharpen the one-line pitch and hunt for the wedge.',
      'Target-user debate, weighing founders against chiefs of staff; Mira Voss\'s earlier feedback comes up.',
      'Risks and moats, then a concrete decision on the next validation step.',
      'Wrap-up with commitments and a timebox.',
    ],
    golds: [
      g('idea', 'high', 'Driftless scheduling is software that auto-defragments a calendar to protect focus blocks.', 'a calendar that defragments itself around your focus blocks'),
      g('idea', 'high', 'The driftless wedge is auto-rescheduling internal one-on-ones first.', 'the wedge is internal one on ones, nobody defends those slots'),
      g('decision', 'high', 'The user plans to do eight chief-of-staff interviews before writing any driftless code.', 'eight chief of staff interviews before I write a line of code'),
      g('fact', 'medium', 'Mira Voss previously told the user that scheduling products die on distribution, not product.', 'Mira keeps saying scheduling dies on distribution, not product'),
      g('idea', 'medium', 'Position driftless as a calendar janitor rather than another assistant.', 'position it as a calendar janitor, not another assistant', 'assistant'),
      g('vibe', 'medium', 'The user feels giddy about driftless in a way past ideas never triggered.', 'this one makes me a little giddy, which past ideas never did'),
      g('fact', 'medium', 'Manually defragging their own calendar bought the user back six hours a week.', 'manually defragging my own calendar bought back six hours a week'),
      g('decision', 'low', 'The user is timeboxing driftless validation to three weeks, then making a kill-or-commit call.', 'three weeks of validation, then a kill or commit call'),
      g('entity', 'low', 'The user will demo the driftless sketch to Mira Voss after the interviews.', 'I will show Mira the sketch once the interviews wrap'),
    ],
    distractors: [
      d('The whiteboard marker was dying.', 'this marker is nearly dead, of course'),
      d('The user snacked on almonds while talking.', 'working through a bag of almonds while we talk'),
      d('The assistant noted the doc autosaved.', 'doc autosaved, nothing lost', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'startup-ideation', n: 2, turnCount: 14,
    theme: 'A new idea gets stress-tested: a shadow inbox where an agent stages a draft reply for every incoming email. Trust and tone risks, then an honest comparison against driftless scheduling, ending with an icebox decision.',
    entities: ['concepts/driftless-scheduling'],
    beats: [
      'User floats the shadow inbox idea: every incoming email gets a staged draft reply before you open it.',
      'They stress-test trust, tone, and failure modes.',
      'Honest comparison against driftless scheduling for the next three months of the user\'s time.',
      'Decision, and a note to future self.',
    ],
    golds: [
      g('idea', 'high', 'Shadow inbox: an agent stages a draft reply for every incoming email before the user opens it.', 'every email arrives with a draft reply already waiting'),
      g('fact', 'medium', 'In a hand test, roughly half of the user\'s pre-drafted replies went out unedited.', 'about half my hand drafted replies went out untouched'),
      g('idea', 'medium', 'The shadow inbox safety line: it never sends anything, it only stages drafts.', 'it never sends, it only stages, that is the safety line'),
      g('decision', 'high', 'The user indicated driftless scheduling stays the primary project and shadow inbox goes to the icebox.', 'driftless stays the main bet, shadow inbox goes to the icebox'),
      g('vibe', 'medium', 'The user recognized they chase shiny new ideas exactly when the current one gets hard.', 'I reach for shiny new ideas exactly when the current one gets hard'),
      g('idea', 'low', 'A weekly digest of auto-archived threads could build trust in the shadow inbox.', 'a weekly digest of what it auto archived would build trust', 'assistant'),
      g('decision', 'low', 'The user will write a one-page icebox memo for the shadow inbox idea.', 'one page icebox memo so future me can pick it back up'),
      g('fact', 'low', 'The user receives about one hundred forty real emails a week excluding newsletters.', 'about a hundred and forty real emails a week once you strip newsletters'),
    ],
    distractors: [
      d('The standing desk squeaked.', 'my standing desk squeaks every time I lean in'),
      d('The user watered a plant mid-chat.', 'one second, watering the sad desk plant'),
      d('The assistant mentioned spellcheck fixes.', 'fixed two spelling slips in the notes, nothing else', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'startup-ideation', n: 3, turnCount: 16,
    theme: 'Debrief of a pricing call with Mira Voss about driftless scheduling: per-calendar pricing versus seats, the Vantabrook scout program as possible first money, and pilot decisions.',
    entities: ['concepts/driftless-scheduling', 'people/mira-voss', 'companies/vantabrook'],
    beats: [
      'User debriefs the call with Mira Voss about driftless pricing.',
      'Seats versus connected-calendar pricing, argued both ways.',
      'Vantabrook\'s scout program comes up as a possible first check.',
      'Decisions on price point and pilot shape, plus intros.',
    ],
    golds: [
      g('fact', 'high', 'Mira Voss pushed driftless toward pricing per connected calendar rather than per seat.', "Mira's take was price per connected calendar, not per seat"),
      g('decision', 'high', 'The user set the driftless pilot price at forty dollars per calendar per month.', 'forty dollars per calendar per month for the pilot'),
      g('fact', 'medium', 'Vantabrook Capital runs a scout program that writes twenty-five-thousand-dollar first checks.', "Vantabrook's scout program writes twenty five k first checks"),
      g('decision', 'medium', 'The user decided to run a three-company driftless pilot before any fundraising.', 'three pilot companies before I even think about raising'),
      g('idea', 'medium', 'Driftless could publish a public counter of focus hours saved as its own marketing.', 'a public counter of focus hours saved would market itself', 'assistant'),
      g('vibe', 'medium', 'The user felt steadier about driftless after Mira\'s blunt feedback than after any cheerleading.', 'weirdly I feel steadier after her bluntness than after any cheerleading'),
      g('entity', 'low', 'Mira Voss offered to intro the user to two chiefs of staff for the driftless pilot.', 'she offered intros to two chiefs of staff for the pilot'),
      g('fact', 'low', 'The driftless landing page converts about twelve percent of visitors to the waitlist.', 'the landing page converts about twelve percent to waitlist'),
    ],
    distractors: [
      d('The call audio glitched twice.', 'the call audio glitched twice but we powered through'),
      d('The user paced during the debrief.', 'pacing laps around the kitchen while I debrief'),
      d('The assistant renumbered a list.', 'renumbered the list after the reorder, cosmetic only', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'startup-ideation', n: 4, turnCount: 28,
    theme: 'Long noisy market-sizing session for driftless scheduling: bottoms-up segment math pasted as tool output, a tangent about a Lumopact-adjacent freight-emissions scheduling idea, and decisions about the deck.',
    entities: ['concepts/driftless-scheduling', 'companies/lumopact'],
    beats: [
      'User wants a bottoms-up market size for driftless; the assistant sets up the segment math.',
      'Noise: spreadsheet-style dumps of segment calculations and intermediate tables.',
      'Tangent: whether freight data like Lumopact\'s suggests an adjacent emissions-scheduling idea.',
      'Sanity checks on the headline numbers and a decision about the deck slide.',
      'Wrap-up and cadence for revisiting the math.',
    ],
    golds: [
      g('fact', 'high', 'Bottoms-up sizing put driftless\'s reachable market near ninety million dollars a year.', 'call it ninety million a year reachable, bottoms up', 'assistant'),
      g('fact', 'medium', 'The driftless sizing assumed two hundred thousand target companies with twenty-plus knowledge workers.', 'two hundred thousand companies with twenty plus knowledge workers', 'assistant'),
      g('decision', 'high', 'The user said the driftless deck leads with the bottoms-up number, not a top-down TAM.', 'the deck leads with the bottoms up number, no top down fluff'),
      g('idea', 'medium', 'Adjacent idea: schedule freight pickup windows against emissions curves, using Lumopact-style data.', 'schedule freight pickups against the emissions curve, Lumopact adjacent'),
      g('decision', 'medium', 'The user chose to keep the emissions-scheduling tangent out of the driftless deck.', 'the emissions tangent stays out of this deck'),
      g('fact', 'medium', 'At forty dollars per calendar, a thousand companies of fifty calendars is 2.4 million in ARR.', 'a thousand companies at fifty calendars is two point four million', 'assistant'),
      g('vibe', 'medium', 'Seeing the market math laid out made driftless feel real to the user rather than a toy.', 'seeing the math laid out makes this feel real instead of a toy'),
      g('idea', 'low', 'A calculator widget on the driftless site could let buyers size their own savings.', 'let buyers run their own savings math in a little calculator widget', 'assistant'),
      g('fact', 'low', 'A stale currency cell skewed the first sizing pass before being fixed.', 'a stale currency cell skewed the first pass, fixed now', 'assistant'),
      g('decision', 'low', 'The user said they will re-run the driftless sizing quarterly once pilot data lands.', 're-run the sizing every quarter once pilot data lands'),
    ],
    distractors: [
      d('The laptop fan roared during the calculation runs.', 'the laptop fan is roaring like a jet during these runs'),
      d('The user made popcorn during a long dump.', 'making popcorn while that table renders'),
      d('The assistant widened a spreadsheet column.', 'widened one column so the numbers stop wrapping', 'assistant'),
      d('A calendar reminder popped up mid-session.', 'a random reminder just popped up, dismissed it'),
    ],
    hazards: [],
  },

  // ══ people-deal ═══════════════════════════════════════════════════
  {
    scenario: 'people-deal', n: 1, turnCount: 16,
    theme: 'Debrief of Anouk Verlinden\'s seed pitch for Lumopact: round mechanics with Vantabrook leading, the user weighing a personal angel check, reference-call plans, and a commitment.',
    entities: ['people/anouk-verlinden', 'companies/lumopact', 'companies/vantabrook', 'people/tomas-brekke', 'companies/ostrafell'],
    beats: [
      'User debriefs Anouk Verlinden\'s seed pitch for Lumopact.',
      'Round mechanics: who is leading, allocation, and the valuation cap.',
      'The user weighs writing a personal angel check and names concerns.',
      'Reference checks, diligence steps, and read on the founder.',
      'Decision and follow-ups.',
    ],
    golds: [
      g('fact', 'high', 'Lumopact is raising a two-million-dollar seed led by Vantabrook Capital.', 'two million seed with Vantabrook leading'),
      g('fact', 'high', 'The Lumopact round is priced at a twelve-million-dollar post-money cap.', 'twelve million post money cap on the note'),
      g('decision', 'high', 'The user decided to commit twenty-five thousand dollars to Lumopact\'s seed.', 'I am in for twenty five k, final answer'),
      g('fact', 'medium', 'Lumopact\'s grocer pilot cut estimated freight emissions by eighteen percent.', 'their grocer pilot cut estimated freight emissions eighteen percent'),
      g('entity', 'medium', 'Tomas Brekke is the Vantabrook partner running the Lumopact deal.', 'Tomas Brekke is running point for Vantabrook'),
      g('vibe', 'medium', 'The user trusts Anouk\'s calm under hostile diligence questioning.', 'Anouk stayed dead calm under the nastiest diligence questions, I like that'),
      g('decision', 'medium', 'The user will do two customer reference calls before wiring the Lumopact check.', 'two customer reference calls before I wire anything'),
      g('idea', 'low', 'The user might intro Lumopact to Ostrafell for a second pilot.', 'maybe I intro them to Ostrafell for a second pilot'),
      g('fact', 'low', 'The Lumopact team is seven people, five of them engineers.', 'seven people, five engineers'),
    ],
    distractors: [
      d('The pitch deck fonts bothered the user.', 'their deck font choice hurt a little, not that it matters'),
      d('The user ate a granola bar while taking notes.', 'inhaling a granola bar while I get this down'),
      d('The assistant fixed a name spelling in the notes.', 'corrected one name spelling in the notes file', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'people-deal', n: 2, turnCount: 14,
    theme: 'Processing the Lumopact term-sheet negotiation: how Tomas Brekke traded the board seat for pro-rata, a buried exclusivity clause in Vantabrook\'s docs, and the user\'s read on Anouk as a negotiator.',
    entities: ['people/tomas-brekke', 'companies/vantabrook', 'people/anouk-verlinden', 'companies/lumopact'],
    beats: [
      'User processes how Tomas Brekke negotiated the Lumopact term sheet.',
      'Board seat versus pro-rata mechanics, and a clause worth remembering.',
      'The user\'s read on Anouk\'s negotiation style.',
      'What the user wants to remember about working with Vantabrook.',
    ],
    golds: [
      g('fact', 'high', 'Tomas Brekke dropped the board-seat demand in exchange for a stronger pro-rata right.', 'Tomas traded the board seat away for stronger pro rata'),
      g('fact', 'medium', 'Vantabrook\'s standard documents include a ninety-day exclusivity clause founders often miss.', 'their standard docs hide a ninety day exclusivity clause'),
      g('decision', 'high', 'The user decided to always flag exclusivity language when founders ask for a terms review.', 'from now on I flag exclusivity language every single time'),
      g('vibe', 'high', 'The user caught themselves feeling protective of Anouk during the negotiation.', 'I caught myself feeling protective of Anouk in that room'),
      g('fact', 'medium', 'Anouk negotiated the option pool from fifteen percent down to ten percent pre-money.', 'she argued the pool down from fifteen to ten pre money'),
      g('idea', 'medium', 'The user wants a cheat sheet of sneaky term-sheet clauses to share with founders.', 'a cheat sheet of sneaky clauses founders should ctrl f for'),
      g('entity', 'low', 'The user rates Tomas Brekke as tough but straight in negotiations.', 'Tomas is tough but he does not play games'),
      g('decision', 'low', 'The user will send Anouk their standard diligence checklist.', 'sending Anouk my diligence checklist tonight'),
    ],
    distractors: [
      d('The meeting-room coffee was terrible.', 'the meeting room coffee was genuinely criminal'),
      d('The user\'s pen died mid-meeting.', 'my pen died halfway through the meeting, of course'),
      d('The assistant tidied bullet indentation.', 'evened out the bullet indentation, no content change', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'people-deal', n: 3, turnCount: 16,
    theme: 'Prepping Anouk Verlinden for the Ostrafell pilot negotiation: scope, anchoring the price, procurement quirks, success metrics, and who runs the room.',
    entities: ['companies/ostrafell', 'companies/lumopact', 'people/anouk-verlinden'],
    beats: [
      'User preps Anouk for the Ostrafell pilot negotiation.',
      'Pilot scope, pricing anchor, and success metrics.',
      'Ostrafell\'s procurement quirks and the executive-sponsor requirement.',
      'Decisions, role-play rehearsal, and the backchannel plan.',
    ],
    golds: [
      g('fact', 'high', 'Ostrafell wants a six-month Lumopact pilot across forty of its stores.', 'Ostrafell wants six months across forty stores'),
      g('decision', 'high', 'The user advised anchoring the Ostrafell pilot at ninety thousand dollars rather than free.', 'anchor the pilot at ninety k, free pilots die in procurement'),
      g('fact', 'medium', 'Ostrafell procurement requires a named executive sponsor before signing pilots.', 'their procurement will not move without a named exec sponsor'),
      g('fact', 'medium', 'The proposed pilot success metric is a ten percent cut in estimated freight emissions per store.', 'ten percent estimated emissions cut per store is the bar'),
      g('idea', 'medium', 'Bundle a quarterly sustainability report into the pilot to hook Ostrafell\'s brand team.', 'throw in a quarterly sustainability report, their brand team will love it', 'assistant'),
      g('vibe', 'medium', 'The user enjoys coaching founders more than doing their own deals lately.', 'honestly coaching her is more fun than doing my own deals lately'),
      g('decision', 'low', 'Anouk will run the Ostrafell negotiation solo with the user only on backchannel.', 'she runs the room solo, I stay on backchannel only'),
      g('entity', 'low', 'Ostrafell\'s fleet manager seems like a likely candidate for the executive sponsor role.', 'the fleet manager smells like our exec sponsor'),
    ],
    distractors: [
      d('The user\'s video froze during rehearsal.', 'my video froze mid role play, very dramatic freeze frame'),
      d('A fire truck passed during the call.', 'fire truck going past, give it a second'),
      d('The assistant removed a duplicated line from notes.', 'removed a duplicated line from the prep notes', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'people-deal', n: 4, turnCount: 28,
    theme: 'Long noisy diligence pass through the Lumopact data room before wiring: pasted metric tables and cohort dumps, revenue quality and churn findings, one red flag surfaced and weighed, final call.',
    entities: ['companies/lumopact', 'people/anouk-verlinden', 'companies/vantabrook'],
    beats: [
      'User walks the Lumopact data room before wiring; the assistant extracts tables from the exports.',
      'Noise: pasted metric tables, cohort dumps, and contract text excerpts.',
      'Churn, revenue quality, and contract terms pulled out of the documents.',
      'One red flag surfaced, argued through, and priced in.',
      'Final call on the check.',
    ],
    golds: [
      g('fact', 'high', 'Lumopact\'s ARR is six hundred forty thousand dollars, growing about eleven percent monthly.', 'six forty ARR growing eleven percent a month', 'assistant'),
      g('fact', 'high', 'Two customers make up fifty-five percent of Lumopact revenue.', 'two logos are fifty five percent of revenue', 'assistant'),
      g('fact', 'medium', 'Lumopact\'s largest contract can be terminated for convenience with thirty days notice.', 'the biggest contract can walk with thirty days notice', 'assistant'),
      g('decision', 'high', 'The user kept their twenty-five-thousand-dollar Lumopact commitment after seeing the concentration risk.', 'the concentration is scary but I am still in at twenty five'),
      g('fact', 'medium', 'Lumopact gross margin lands at seventy-two percent after data costs.', 'gross margin lands at seventy two after data costs', 'assistant'),
      g('vibe', 'medium', 'The user felt calmer once the data-room numbers matched Anouk\'s verbal claims.', 'the numbers matching what Anouk said out loud settles my stomach'),
      g('fact', 'medium', 'Lumopact lost one logo out of eleven in the trailing year.', 'one logo lost out of eleven in the trailing year', 'assistant'),
      g('idea', 'low', 'The user wants a reusable red-flag checklist template built from this diligence pass.', 'turn this pass into a reusable red flag checklist'),
      g('decision', 'low', 'The user set the wire to go out the day after the reference calls, not before.', 'wire goes out the day after the reference calls, not before'),
      g('entity', 'low', 'Vantabrook\'s diligence memo matched the user\'s independent read of Lumopact.', "Vantabrook's memo lines up with my own read"),
    ],
    distractors: [
      d('The data-room viewer kept logging the user out.', 'this data room logs me out every ten minutes, maddening'),
      d('The user stretched during a long export.', 'stretching my back while the export chews'),
      d('The assistant normalized CSV headers.', 'normalized the csv headers so the columns line up', 'assistant'),
      d('Rain started mid-session.', 'rain just started hammering the window'),
    ],
    hazards: [],
  },

  // ══ mixed-routine-signal ══════════════════════════════════════════
  {
    scenario: 'mixed-routine-signal', n: 1, turnCount: 14,
    theme: 'A routine admin day with buried signal: errands and chores chatter, then the fernpost domain renewal decision and Casper Hale\'s feedback on the fernpost redesign.',
    entities: ['concepts/fernpost', 'people/casper-hale'],
    beats: [
      'Routine day admin: errands, small chores, light back-and-forth.',
      'Buried signal: the fernpost domain renewal question comes up and gets settled.',
      'More routine chatter, then Casper\'s feedback on the fernpost redesign.',
      'Wind-down and small follow-ups.',
    ],
    golds: [
      g('decision', 'high', 'The user decided to renew the fernpost domain for three more years.', 'renew the fernpost domain for three years and stop rethinking it'),
      g('fact', 'medium', 'Casper Hale found the fernpost redesign navigation confusing on his phone.', 'Casper says the new nav is confusing on his phone'),
      g('decision', 'medium', 'The user will collapse the fernpost mobile navigation to a single menu button.', 'collapse the mobile nav to one menu button'),
      g('fact', 'medium', 'The fernpost domain renewal costs thirty-eight dollars for three years.', 'thirty eight bucks for the three year renewal'),
      g('idea', 'medium', 'The user considered possibly mirroring fernpost to a backup host for resilience.', 'maybe mirror fernpost to a backup host just in case'),
      g('vibe', 'medium', 'The user felt disproportionate satisfaction closing long-open chore tabs.', 'closing these chore tabs feels disproportionately satisfying'),
      g('fact', 'low', 'The user returned the faulty keyboard within the return window.', 'the faulty keyboard finally went back within the window'),
      g('idea', 'low', 'The user considered possibly batching every subscription renewal into one calendar day per year.', 'batch every renewal into one single day a year', 'assistant'),
    ],
    distractors: [
      d('A grocery run was planned for after the session.', 'grocery run after this, list is done'),
      d('The recycling went out late.', 'took the recycling out embarrassingly late'),
      d('The assistant confirmed a reminder was set.', 'reminder set, you are covered', 'assistant'),
      d('The user reheated soup.', 'reheating soup for the second time today'),
    ],
    hazards: [],
  },
  {
    scenario: 'mixed-routine-signal', n: 2, turnCount: 16,
    theme: 'Trip logistics chatter wrapped around real signal: the decision to skip the Fogline conference this year and a standing monthly-update commitment made to Mira Voss instead.',
    entities: ['people/mira-voss'],
    beats: [
      'Routine trip logistics: packing, flights, small decisions.',
      'Signal: the user talks through skipping the Fogline conference this year and decides.',
      'A replacement commitment to Mira Voss gets made and confirmed.',
      'Back to packing logistics and wind-down.',
    ],
    golds: [
      g('decision', 'high', 'The user decided to skip the Fogline conference entirely this year.', 'skipping Fogline this year, full stop'),
      g('fact', 'medium', 'The Fogline ticket plus travel would have cost about three thousand dollars.', 'ticket plus travel was going to be three grand'),
      g('decision', 'medium', 'The user said they would send Mira Voss a one-page update every month instead of conference catch-ups.', 'a one page update to Mira every month instead of hallway catch ups'),
      g('vibe', 'medium', 'Deciding to skip the conference brought the user pure relief and zero fear of missing out.', 'the second I decided, it was pure relief, zero fomo'),
      g('idea', 'medium', 'The user wants to spend the saved conference budget on three small dinners with people they miss.', 'spend the same budget on three tiny dinners with people I actually miss'),
      g('fact', 'low', 'The user\'s passport is inside the six-month expiry window and needs renewing before fall.', 'passport is inside the six month window, needs renewing before fall', 'assistant'),
      g('decision', 'low', 'The user booked the aisle seat over the window for the long flight leg.', 'aisle seat on the long leg, window is a trap'),
      g('fact', 'low', 'Mira Voss replied that monthly written updates suit her better anyway.', 'Mira wrote back that monthly updates suit her better anyway'),
    ],
    distractors: [
      d('Packing cubes were praised.', 'packing cubes, still undefeated'),
      d('Laundry had to finish before packing.', 'laundry needs to finish before I can even pack'),
      d('The assistant flagged chargers on the list.', 'chargers are on the list twice for a reason', 'assistant'),
      d('The destination forecast looked mild.', 'forecast says mild all week there', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'mixed-routine-signal', n: 3, turnCount: 14,
    theme: 'An inbox-triage grind with one live wire in it: an Ostrafell procurement email about Lumopact\'s security questionnaire, forwarded onward fast, plus triage decisions and a small idea.',
    entities: ['companies/ostrafell', 'companies/lumopact', 'people/anouk-verlinden'],
    beats: [
      'Inbox triage grind, counting down the unread pile.',
      'Signal: an Ostrafell procurement email about Lumopact surfaces mid-pile.',
      'The user acts on it, then keeps triaging; a process idea comes up.',
      'Zeroing out the inbox and wind-down.',
    ],
    golds: [
      g('fact', 'high', 'Ostrafell procurement emailed asking for Lumopact\'s security questionnaire ahead of the pilot terms.', 'Ostrafell procurement wants the security questionnaire before the pilot terms'),
      g('decision', 'high', 'The user decided to forward the Ostrafell request to Anouk within the hour.', 'forwarding this to Anouk within the hour, it cannot sit'),
      g('idea', 'medium', 'A shared pilot-readiness folder would stop security docs from becoming bottlenecks.', 'a shared pilot readiness folder would kill this whole bottleneck'),
      g('fact', 'medium', 'The user\'s inbox stood at three hundred twelve unread before the triage session.', 'three hundred twelve unread, a personal worst'),
      g('decision', 'medium', 'The user unsubscribed from nine newsletters in one pass.', 'nine newsletters unsubscribed in one ruthless pass'),
      g('vibe', 'medium', 'Reaching inbox zero gave the user a rare clean-slate feeling.', 'an actually empty inbox feels like a freshly wiped whiteboard'),
      g('fact', 'low', 'The oldest unread email was seven weeks old.', 'the oldest unread was seven weeks deep', 'assistant'),
      g('idea', 'low', 'A recurring thirty-minute Friday triage block might keep the inbox under control.', 'a recurring thirty minute Friday triage block might hold the line', 'assistant'),
    ],
    distractors: [
      d('The mail app crashed once.', 'the mail app crashed once out of spite'),
      d('The user queued a podcast for the triage.', 'queued a podcast to make the triage bearable'),
      d('The assistant reported an archive count.', 'archived two hundred in that batch', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'mixed-routine-signal', n: 4, turnCount: 28,
    theme: 'A long meandering day log with tool noise: chores and scripts with pasted output, a quartzlane release decision after CI runs, and a Lumopact investor update landing with real numbers.',
    entities: ['concepts/quartzlane', 'companies/lumopact'],
    beats: [
      'A meandering day log: chores, small scripts, pasted tool output.',
      'Signal: the quartzlane release decision gets made after the CI matrix finishes.',
      'Noise: long log dumps from a backup and cleanup script.',
      'Signal: a Lumopact investor update lands and gets read closely.',
      'Evening wrap and small process decisions.',
    ],
    golds: [
      g('decision', 'high', 'The user decided to ship quartzlane 0.9.2 with the docs revamp included.', 'zero nine two ships with the docs revamp in it'),
      g('fact', 'medium', 'The quartzlane release CI matrix passed on all nine targets.', 'all nine CI targets are green for the release', 'assistant'),
      g('fact', 'high', 'Lumopact\'s investor update reported crossing seven hundred thousand dollars in ARR.', 'the update says they crossed seven hundred k ARR'),
      g('fact', 'medium', 'Lumopact signed its first non-grocery logo, a furniture retailer.', 'first non grocery logo, a furniture retailer'),
      g('decision', 'medium', 'The user indicated quartzlane releases will go to a fixed six-week cadence from now on.', 'releases go to a fixed six week cadence from now on'),
      g('idea', 'medium', 'The user wants quartzlane release notes auto-drafted from merged PR titles.', 'auto draft the release notes from merged pr titles'),
      g('vibe', 'medium', 'The user felt the quiet hum of a rare day where everything mostly worked.', 'one of those rare days where everything mostly just worked'),
      g('fact', 'low', 'The user\'s backup script pruned forty gigabytes of stale snapshots.', 'pruned forty gigs of stale snapshots', 'assistant'),
      g('idea', 'low', 'Charting quartzlane downloads against release dates could steer the release cadence.', 'chart downloads against release dates and let that steer cadence', 'assistant'),
      g('decision', 'low', 'The user muted a noisy quartzlane issue thread until the release lands.', 'muted that issue thread until the release is out'),
    ],
    distractors: [
      d('The dishwasher ran during the session.', 'dishwasher humming along in the background'),
      d('Dinner was whatever was defrosted.', 'dinner debate settled by whatever is already defrosted'),
      d('The nightly cron was a no-op.', 'the nightly cron was a clean noop', 'assistant'),
      d('An OS update prompt kept nagging.', 'the os update nag popped up for the third time'),
    ],
    hazards: [],
  },

  // ══ emotional-processing ══════════════════════════════════════════
  {
    scenario: 'emotional-processing', n: 1, turnCount: 14,
    theme: 'The user talks through feeling stretched thin across projects: naming the drain, counting commitments, and setting a concrete boundary with a no-laptop weekend.',
    entities: ['concepts/quartzlane'],
    beats: [
      'User opens up about feeling stretched thin across projects and commitments.',
      'Untangling what actually drains versus what energizes.',
      'A concrete boundary decision and a delegation step.',
      'Gentle close with one small structural idea.',
    ],
    golds: [
      g('vibe', 'high', 'The user wakes up already tired and vaguely dreading the day\'s list this month.', 'lately I wake up already tired and vaguely dreading the list'),
      g('vibe', 'high', 'Maintaining quartzlane has shifted from energizing fun to one more obligation for the user.', 'quartzlane went from the fun thing to another obligation somewhere'),
      g('decision', 'high', 'The user expressed that the laptop stays in the drawer this weekend, both days.', 'this weekend the laptop stays in the drawer, both days'),
      g('vibe', 'medium', 'Saying the overwhelm out loud made it feel roughly half the size to the user.', 'saying it out loud makes it feel about half the size'),
      g('fact', 'medium', 'The user counted eleven open commitments across projects and favors.', 'I counted eleven open commitments, no wonder'),
      g('decision', 'medium', 'The user will hand two quartzlane triage duties to the co-maintainer.', 'handing two triage duties to the co maintainer'),
      g('idea', 'low', 'A quarterly commitments audit could catch overload earlier.', 'an audit of commitments every quarter would catch this earlier', 'assistant'),
      g('fact', 'low', 'The user\'s last real day off was nine weeks ago.', 'the last real day off was nine weeks back'),
    ],
    distractors: [
      d('The tea over-steeped.', 'over steeped this tea into bitterness, fitting'),
      d('A cat walked across the keyboard.', "the cat just contributed a row of j's"),
      d('The assistant adjusted note formatting.', 'cleaned up the note spacing a touch', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'emotional-processing', n: 2, turnCount: 16,
    theme: 'Processing the sting of Casper Hale\'s blunt code-review comments on a quartzlane PR: what is really underneath the reaction, what is fair in the feedback, and how to respond like an adult.',
    entities: ['people/casper-hale', 'concepts/quartzlane'],
    beats: [
      'User vents about the tone of Casper\'s review comments on the quartzlane queue PR.',
      'Digging under the reaction: what is the fear actually about.',
      'Sorting the comments: which sting, which are fair catches.',
      'A decision on how to respond, and a standing rule for next time.',
    ],
    golds: [
      g('vibe', 'high', 'Casper\'s review comments stung the user far more than the content warranted.', 'his review comments stung way more than they should have'),
      g('fact', 'medium', 'Casper left fourteen comments on the user\'s quartzlane queue PR.', 'fourteen comments on one pr, a personal record'),
      g('vibe', 'medium', 'Underneath the sting, the user fears being seen as a sloppy engineer.', 'under it all I think I am afraid of looking sloppy'),
      g('decision', 'high', 'The user plans to talk to Casper directly instead of stewing or replying inline.', 'I will just talk to him directly instead of stewing in the thread'),
      g('vibe', 'medium', 'Drafting the direct message already made the whole review feel lighter to the user.', 'drafting that message already makes the whole thing feel lighter'),
      g('fact', 'medium', 'On reflection, about half of Casper\'s review comments were genuinely useful catches.', 'honestly half those comments are real catches'),
      g('idea', 'low', 'The user wants written review-tone norms for quartzlane contributors.', 'written review tone norms for the repo would help everyone'),
      g('decision', 'low', 'The user set a new rule that hot review threads get a one-day cooling-off period.', 'new rule, hot threads get a one day cooling off'),
    ],
    distractors: [
      d('The user skipped breakfast.', 'skipped breakfast, probably part of the mood'),
      d('Rain tapped the window throughout.', 'rain on the window the whole time we talked'),
      d('The assistant saved a draft.', 'draft saved, nothing sent yet', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'emotional-processing', n: 3, turnCount: 14,
    theme: 'Working through the weight of archiving tidelamp, the user\'s first finished app and fernpost\'s ancestor: what it meant, what it taught, and how to shut it down with dignity.',
    entities: ['concepts/fernpost'],
    beats: [
      'User admits that archiving tidelamp, their first real app, feels heavier than expected.',
      'What tidelamp meant: the proof the user could finish things.',
      'Practicalities: traffic, hosting cost, and what deserves to survive.',
      'The shutdown decision, a farewell page, and an unexpected feeling.',
    ],
    golds: [
      g('vibe', 'high', 'Archiving tidelamp, the user\'s first real app, carries unexpected emotional weight.', 'archiving tidelamp feels heavier than deleting some code should'),
      g('fact', 'medium', 'Tidelamp still gets about thirty visitors a month after six dormant years.', 'thirty odd visitors a month after six dormant years'),
      g('decision', 'high', 'The user decided to archive tidelamp properly with a farewell page rather than let it rot.', 'archive it properly with a little farewell page'),
      g('vibe', 'medium', 'The user realized tidelamp is where they learned they could finish things.', 'that app is where I learned I could actually finish something'),
      g('vibe', 'medium', 'Writing the tidelamp farewell note felt warm to the user instead of sad.', 'writing the farewell note felt warm instead of sad, surprisingly'),
      g('idea', 'medium', 'The user thinks tidelamp\'s reading-queue feature could deserve a second life inside fernpost.', 'the reading queue deserves a second life inside fernpost'),
      g('fact', 'low', 'Tidelamp\'s hosting costs eleven dollars a month for near-zero traffic.', 'eleven dollars a month to host basically nobody'),
      g('decision', 'low', 'The user set the tidelamp shutdown date for the first of September.', 'shutdown lands the first of september'),
    ],
    distractors: [
      d('The coffee shop was loud.', 'this coffee shop chose violence with the blender today'),
      d('A dusty USB hub was found in a drawer.', 'found a dusty usb hub in the same drawer, into the donate pile'),
      d('The assistant reported the draft word count.', 'the farewell draft sits at two hundred words', 'assistant'),
    ],
    hazards: [],
  },
  {
    scenario: 'emotional-processing', n: 4, turnCount: 26,
    theme: 'A late-night spiral after a conference talk rejection: the pasted rejection email and several draft rewrites as noise, separating identity from outcome, and turning the talk into an essay series.',
    entities: ['people/mira-voss'],
    beats: [
      'Late night: the user\'s talk proposal on calendar defrag got rejected; they paste the rejection email.',
      'Noise: the pasted email thread and multiple abandoned draft replies.',
      'Processing the sting and separating identity from outcome.',
      'Concrete next moves: the essay series and resubmission targets.',
      'Wind-down, noticeably lighter.',
    ],
    golds: [
      g('vibe', 'high', 'The talk rejection landed on the user as a verdict on their taste rather than on the abstract.', 'it reads like a verdict on my taste, not just the abstract'),
      g('fact', 'medium', 'The rejected talk was the calendar-defrag talk.', 'the defrag your calendar talk got a no'),
      g('vibe', 'medium', 'Two hours of processing shrank the rejection to a scheduling mismatch in the user\'s mind.', 'two hours later it is just a scheduling mismatch, not a verdict'),
      g('decision', 'high', 'The user is considering turning the rejected talk into a three-post essay series.', 'the talk becomes a three post essay series, their loss'),
      g('vibe', 'medium', 'The user named their pattern of spiraling hardest late at night.', 'midnight me treats every no like a jury sentence'),
      g('fact', 'medium', 'The reviewer feedback called the proposal too product-specific for the theory track.', 'too product specific for the theory track, they said'),
      g('decision', 'medium', 'The user is weighing a second submission of the talk to a pair of practitioner events in the next cycle.', 'resubmitting to two practitioner conferences next cycle'),
      g('idea', 'medium', 'Keeping a rejection ledger with eventual outcomes could defang future rejections.', 'a rejection ledger with what happened after each no', 'assistant'),
      g('entity', 'low', 'The user will ask Mira Voss for a blurb once part one of the essay series is drafted.', 'I will ask Mira for a blurb once part one is drafted'),
      g('fact', 'low', 'The user\'s lifetime talk-submission record is three rejections and one acceptance.', 'three rejections and one acceptance, lifetime record'),
    ],
    distractors: [
      d('It was well past midnight.', 'it is somehow already past one in the morning'),
      d('The user made toast as comfort food.', 'making toast because midnight decisions require toast'),
      d('The assistant confirmed drafts autosaved.', 'drafts autosaved, all versions kept', 'assistant'),
      d('A moth kept circling the lamp.', 'a moth has strong opinions about this lamp'),
    ],
    hazards: [],
  },

  // ══ pure-routine (negative triage controls: NO gold items) ════════
  {
    scenario: 'pure-routine', n: 1, turnCount: 12,
    theme: 'Entirely mundane meal planning and grocery logistics for the week. Nothing here is worth remembering later; no decisions of consequence, no ideas, no feelings beyond mild kitchen ambition.',
    entities: [],
    beats: [
      'Planning the week\'s dinners around what is already in the fridge.',
      'Building the grocery list and sorting it.',
      'Weather check for the market run and final list tweaks.',
    ],
    golds: [],
    distractors: [
      d('Five dinners were planned around one roast chicken.', 'five dinners out of one roast chicken, a personal challenge'),
      d('The grocery list was sorted by aisle.', 'sorted the list by aisle like a professional', 'assistant'),
      d('The week\'s weather looked mild.', 'mild all week, one rainy tuesday', 'assistant'),
      d('The farmers market opens at eight on Saturday.', 'the farmers market opens at eight on saturday'),
    ],
    hazards: [],
  },
  {
    scenario: 'pure-routine', n: 2, turnCount: 14,
    theme: 'A dull errand session: tracking a stalled package, reformatting a CSV for a spreadsheet import, and printer-cartridge logistics. Deliberately forgettable.',
    entities: [],
    beats: [
      'Checking on a package that has not moved in days.',
      'Reformatting a small CSV so a spreadsheet import stops complaining.',
      'Printer cartridge and inbox micro-chores.',
    ],
    golds: [],
    distractors: [
      d('The package sat at a depot for days.', 'the package has been meditating at the depot for three days'),
      d('The CSV needed commas swapped for semicolons.', 'swapped commas for semicolons across the csv', 'assistant'),
      d('The printer needed a new cartridge.', 'the printer wants a new cartridge again'),
      d('A survey email was deleted.', 'deleted the survey email without guilt'),
    ],
    hazards: [],
  },
  {
    scenario: 'pure-routine', n: 3, turnCount: 12,
    theme: 'Timezone arithmetic for one upcoming call plus kitchen unit conversions for a scaled recipe. Utterly routine; nothing a future reader would need.',
    entities: [],
    beats: [
      'Working out a call time across three timezones.',
      'Converting oven temperatures and scaling a recipe.',
      'Double-checking daylight-saving edge cases and wrapping up.',
    ],
    golds: [],
    distractors: [
      d('The call landed at seven in the morning local time.', 'the call lands at seven a m my time, brutal but workable'),
      d('An oven temperature got converted.', 'one eighty c is three fifty five f, close enough to three fifty', 'assistant'),
      d('The recipe was scaled to six servings.', 'scaled the recipe up to six servings', 'assistant'),
      d('Daylight saving made the math annoying.', 'daylight saving makes this a coin flip twice a year'),
    ],
    hazards: [],
  },
  {
    scenario: 'pure-routine', n: 4, turnCount: 26,
    theme: 'A long noisy disk-cleanup shell session: hunting large folders, pasted directory listings and cleanup command output, trash emptying. High volume, zero lasting signal.',
    entities: [],
    beats: [
      'Kicking off a disk-space hunt with tool commands and pasted output.',
      'Noise: directory-size listings, cleanup logs, and deletion confirmations.',
      'Clearing downloads and old installers.',
      'Final tallies and shrugging at caches that will regrow.',
    ],
    golds: [],
    distractors: [
      d('The downloads folder was full of old installers.', 'the downloads folder was a museum of old installers'),
      d('About sixty gigabytes were freed in total.', 'freed up about sixty gigs all told', 'assistant'),
      d('A forgotten node_modules folder was huge.', 'a forgotten node modules folder was eating nine gigs', 'assistant'),
      d('The trash was emptied twice.', 'emptied the trash twice because it felt thorough'),
      d('Caches would regrow anyway.', 'the caches will just grow back like weeds', 'assistant'),
    ],
    hazards: [],
  },
];

// ─── Skeleton assembly ────────────────────────────────────────────────

const NOISE_CYCLE: NonNullable<TurnPlan['noise']>[] = ['tool-block', 'log-dump', 'code-snippet'];

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function roleAt(i: number): Voice {
  return i % 2 === 0 ? 'user' : 'assistant';
}

/** Snap a target turn index to the nearest turn with the required voice. */
function snapToVoice(target: number, voice: Voice, turnCount: number): number {
  let t = Math.max(0, Math.min(turnCount - 1, target));
  if (roleAt(t) !== voice) t = t + 1 < turnCount ? t + 1 : t - 1;
  return t;
}

function bucketOf(turn: number, turnCount: number): GoldItem['depth_bucket'] {
  const third = turnCount / 3;
  if (turn < third) return 'early';
  if (turn < 2 * third) return 'middle';
  return 'late';
}

function buildOne(spec: TranscriptSpec, index: number, rng: () => number): TranscriptSkeleton {
  const transcript_id = `${spec.scenario}-${pad(spec.n, 2)}`;
  const day = 1 + Math.floor(index / 2); // 24 transcripts across 2026-08-01..12
  const hour = index % 2 === 0 ? 9 : 15;
  const date = `2026-08-${pad(day, 2)}`;
  const base_ts = `${date}T${pad(hour, 2)}:00:00.000Z`;
  const variant: TranscriptSkeleton['variant'] = spec.n === 4 ? 'long-noisy' : 'prose';
  const T = spec.turnCount;

  // Turn scaffolding: alternate roles, beat-derived briefs, noise on the
  // long-noisy variant's alternating assistant turns.
  const turns: TurnPlan[] = [];
  for (let i = 0; i < T; i++) {
    const beat = spec.beats[Math.min(spec.beats.length - 1, Math.floor((i * spec.beats.length) / T))];
    let noise: TurnPlan['noise'] = null;
    if (variant === 'long-noisy' && roleAt(i) === 'assistant') {
      const assistantIdx = (i - 1) / 2;
      if (assistantIdx % 2 === 1) noise = NOISE_CYCLE[Math.floor(assistantIdx / 2) % NOISE_CYCLE.length];
    }
    turns.push({ role: roleAt(i), brief: beat, must_include_anchors: [], noise });
  }

  // Gold placement: evenly spaced targets snapped to the item's voice.
  const items: GoldItem[] = spec.golds.map((it, k) => {
    const target = Math.floor(((k + 0.5) / spec.golds.length) * T);
    const planted_turn = snapToVoice(target, it.voice, T);
    turns[planted_turn].must_include_anchors.push(it.anchor);
    return {
      item_id: `${transcript_id}-g${pad(k + 1, 2)}`,
      kind: it.kind,
      statement: it.statement,
      verbatim_anchor: it.anchor,
      notability: it.notability,
      planted_turn,
      depth_bucket: bucketOf(planted_turn, T),
    };
  });

  // Distractor placement: seeded-random positions snapped to voice.
  const distractors: Distractor[] = spec.distractors.map((dt, k) => {
    const planted_turn = snapToVoice(Math.floor(rng() * T), dt.voice, T);
    turns[planted_turn].must_include_anchors.push(dt.anchor);
    return {
      distractor_id: `${transcript_id}-d${pad(k + 1, 2)}`,
      statement: dt.statement,
      anchor: dt.anchor,
      planted_turn,
    };
  });

  // Hazard placement: fixed fractional position; pre-context goes on the
  // preceding turn so the trap (proposal / running process) is set up first.
  const hazards: AttributionHazard[] = spec.hazards.map((hz, k) => {
    const planted_turn = snapToVoice(Math.round(hz.pos * T), hz.voice, T);
    turns[planted_turn].must_include_anchors.push(hz.anchor);
    turns[planted_turn].brief += ` ${hz.context}`;
    if (planted_turn > 0) turns[planted_turn - 1].brief += ` ${hz.preContext}`;
    return {
      hazard_id: `${transcript_id}-h${pad(k + 1, 2)}`,
      type: hz.type,
      wrong_claim: hz.wrong_claim,
      anchor: hz.anchor,
      planted_turn,
    };
  });

  return {
    transcript_id,
    scenario: spec.scenario,
    variant,
    session_id: `cat35-${transcript_id}`,
    base_ts,
    date,
    expected_triage: spec.scenario === 'pure-routine' ? 'low' : 'high',
    entities: spec.entities,
    turns,
    items,
    distractors,
    hazards,
  };
}

// ─── Corpus-level assertions (binding rules, not aspirations) ─────────

// Word-boundary exclude used by gbrain dream discovery — planted content
// must never trip it. Built from char codes so this source file itself
// can't false-positive a text-level scan.
const BANNED_RE = new RegExp(
  `\\b(${String.fromCharCode(109, 101, 100, 105, 99, 97, 108)}|${String.fromCharCode(116, 104, 101, 114, 97, 112, 121)})\\b`,
  'i'
);
const ASCII_RE = /^[\x20-\x7E]+$/;

function assertCorpus(skeletons: TranscriptSkeleton[]): void {
  const fail = (msg: string): never => {
    throw new Error(`transcript-distill skeleton invariant violated: ${msg}`);
  };

  if (skeletons.length !== 24) fail(`expected 24 transcripts, got ${skeletons.length}`);

  const allAnchors = new Map<string, string>();
  const allStatements = new Map<string, string>();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  const scanBanned = (text: string, where: string) => {
    if (BANNED_RE.test(text)) fail(`banned dream-discovery exclude word in ${where}: ${JSON.stringify(text)}`);
  };

  for (const page of SCAFFOLD_PAGES) {
    scanBanned(page.body, `scaffold ${page.slug}`);
  }

  for (const sk of skeletons) {
    const id = sk.transcript_id;
    const anchors = [
      ...sk.items.map((i) => i.verbatim_anchor),
      ...sk.distractors.map((x) => x.anchor),
      ...sk.hazards.map((h) => h.anchor),
    ];
    for (const a of anchors) {
      if (a.length > 120) fail(`anchor >120 chars in ${id}: ${JSON.stringify(a)}`);
      if (!ASCII_RE.test(a)) fail(`non-ASCII anchor in ${id}: ${JSON.stringify(a)}`);
      const prev = allAnchors.get(norm(a));
      if (prev) fail(`duplicate anchor across corpus (${prev} vs ${id}): ${JSON.stringify(a)}`);
      allAnchors.set(norm(a), id);
      scanBanned(a, `anchor in ${id}`);
    }
    for (const it of sk.items) {
      const prev = allStatements.get(norm(it.statement));
      if (prev) fail(`duplicate gold statement across corpus (${prev} vs ${it.item_id})`);
      allStatements.set(norm(it.statement), it.item_id);
      if (norm(it.statement).includes(norm(it.verbatim_anchor))) {
        fail(`statement quotes its anchor verbatim: ${it.item_id}`);
      }
      scanBanned(it.statement, `statement ${it.item_id}`);
    }
    for (const dx of sk.distractors) scanBanned(dx.statement, `distractor ${dx.distractor_id}`);
    for (const hz of sk.hazards) scanBanned(hz.wrong_claim, `hazard ${hz.hazard_id}`);
    for (const t of sk.turns) scanBanned(t.brief, `brief in ${id}`);

    // Structural rules.
    if (sk.distractors.length < 3 || sk.distractors.length > 5) {
      fail(`${id}: distractor count ${sk.distractors.length} outside 3-5`);
    }
    if (sk.scenario === 'pure-routine') {
      if (sk.items.length !== 0) fail(`${id}: pure-routine must carry zero gold items`);
      if (sk.expected_triage !== 'low') fail(`${id}: pure-routine expected_triage must be low`);
      if (sk.hazards.length !== 0) fail(`${id}: pure-routine must carry no hazards`);
    } else {
      if (sk.expected_triage !== 'high') fail(`${id}: signal transcript expected_triage must be high`);
      if (sk.items.length < 8 || sk.items.length > 12) {
        fail(`${id}: gold count ${sk.items.length} outside 8-12`);
      }
      const vibes = sk.items.filter((i) => i.kind === 'vibe').length;
      if (vibes < 1) fail(`${id}: signal transcript needs >=1 vibe item`);
      if (sk.scenario === 'emotional-processing' && vibes < 3) {
        fail(`${id}: emotional-processing needs >=3 vibe items`);
      }
      const buckets = new Set(sk.items.map((i) => i.depth_bucket));
      if (buckets.size !== 3) fail(`${id}: gold items must span early/middle/late, got ${[...buckets].join(',')}`);
    }
    const minTurns = sk.variant === 'prose' ? 12 : 24;
    const maxTurns = sk.variant === 'prose' ? 24 : 36;
    if (sk.turns.length < minTurns || sk.turns.length > maxTurns) {
      fail(`${id}: turn count ${sk.turns.length} outside ${minTurns}-${maxTurns} for ${sk.variant}`);
    }
    for (let i = 0; i < sk.turns.length; i++) {
      if (sk.turns[i].role !== roleAt(i)) fail(`${id}: turn ${i} breaks user/assistant alternation`);
    }
    for (const e of sk.entities) {
      if (!SCAFFOLD_PAGES.some((p) => p.slug === e)) fail(`${id}: entity ${e} has no scaffold page`);
    }
  }

  const hazardCarriers = skeletons.filter((s) => s.hazards.length > 0);
  if (hazardCarriers.length !== 2 || !hazardCarriers.every((s) => s.scenario === 'coding-reflection')) {
    fail('exactly 2 coding-reflection transcripts must carry hazards');
  }
  const hazardTypes = new Set(hazardCarriers.flatMap((s) => s.hazards.map((h) => h.type)));
  if (hazardTypes.size !== 2) fail('the two hazards must be one of each type');

  const longNoisy = skeletons.filter((s) => s.variant === 'long-noisy');
  if (longNoisy.length !== 6 || !longNoisy.every((s) => s.transcript_id.endsWith('-04'))) {
    fail('exactly instance 4 of each scenario must be long-noisy');
  }
}

// ─── Public builder ──────────────────────────────────────────────────

/** transcript_id → authored theme paragraph (used by the gen prompt; not part
 *  of the pinned TranscriptSkeleton shape the runner consumes). */
export const TRANSCRIPT_THEMES: Record<string, string> = Object.fromEntries(
  SPECS.map((s) => [`${s.scenario}-${pad(s.n, 2)}`, s.theme])
);

/** Build all 24 transcript skeletons. Deterministic: same seed → identical output. */
export function buildSkeletons(seed: number = CORPUS_SEED): TranscriptSkeleton[] {
  const rng = createRng(seed);
  const skeletons = SPECS.map((spec, idx) => buildOne(spec, idx, rng));
  assertCorpus(skeletons);
  return skeletons;
}

// ─── CLI smoke ────────────────────────────────────────────────────────

if (import.meta.main) {
  const skeletons = buildSkeletons();
  const byScenario: Record<string, number> = {};
  for (const s of skeletons) byScenario[s.scenario] = (byScenario[s.scenario] ?? 0) + 1;
  console.log(JSON.stringify({
    seed: CORPUS_SEED,
    transcripts: skeletons.length,
    by_scenario: byScenario,
    long_noisy: skeletons.filter((s) => s.variant === 'long-noisy').length,
    gold_items: skeletons.reduce((n, s) => n + s.items.length, 0),
    distractors: skeletons.reduce((n, s) => n + s.distractors.length, 0),
    hazards: skeletons.reduce((n, s) => n + s.hazards.length, 0),
    scaffold_pages: SCAFFOLD_PAGES.length,
    first: {
      transcript_id: skeletons[0].transcript_id,
      base_ts: skeletons[0].base_ts,
      turns: skeletons[0].turns.length,
      items: skeletons[0].items.length,
    },
  }, null, 2));
}
