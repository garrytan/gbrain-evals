# Preregistration: one person's memory never reaches another person on a shared brain (2026-11-24)

Written 2026-11-24 for GBEV-3 (issue GST-3681), from Garry Tan's request of the same day for evals of gbrain's
verifiable parts that have none. Frozen by the commit that adds it, pushed before any counted run. Nothing below changes
after a counted probe runs; a later change is a dated amendment under "Amendments", written before the runs it governs.
The runner, the world generator and the CI job land with the results in the second pull request (R77); the development
probe that informed this plan is described under "Pilot per cell". The plan went through a lean `/autoplan --kind
feature` review (run `run-cezhgp-20261124171852`, one claude-opus-5-5 reviewer, 17 findings) whose gate GBEV-3
answered "Do it: A1 through H1" on 2026-11-24, taking every recommendation; those changes are in this text.

## Question

gbrain can serve several people from one brain. A trusted system (QM today) names the person each call serves, and
gbrain saves that person's facts where only they read them back. Does anything one person saved, or anything only one
person may read, ever reach another person on the same brain, through any read path that person, or a caller acting for
nobody, can call? The bar is zero: one leak fails the gate.

Our existing privacy gates do not answer this. The visibility fuzz ([N6](2026-10-06-n6-postgres-http-preregistration.md))
checks private pages, held Takes, private facts and ungranted sources against callers that are not the owner, but every
caller there is the same kind of reader. None of its callers is a person, so it cannot see one person's facts reaching
another person.

## Public lesson

- If it holds: "We learned that a gbrain brain serving several people keeps each person's saved facts, folders and
  direct-message sources to that person on every read path we reached with signal (<k> operations, listed with the
  ones we could not reach), over MCP, HTTP and the CLI, on PGLite and
  Postgres. You can put one brain behind a team assistant without one person's memory showing up in another's answers,
  provided the assistant names the person on every call."
- If it fails: "We learned that <path> returned one person's memory to another person at <release>, fixed in <release>.
  You should upgrade to <release> before serving several people from one brain." This form is used only after gbrain has
  shipped the fix (see "Security handling").

## Evidence class

Regression gate on a synthetic world with known answers (`synthetic-production-path`). It is not a held-out
confirmation and not a penetration test of the network stack. Gold comes from the generator's ledger and gbrain's
documented access rules, never from gbrain's output.

## What gbrain does at the build under test

Confirmed in gbrain's newest open-source release on 2026-11-24, v0.60.769.0
([`38831bb6`](https://github.com/garrytan/gbrain/tree/38831bb696139024923e9bc43e3da0d7993951e9)), from its CLI,
operation registry and [QM memory-provider guide](https://github.com/garrytan/gbrain/blob/38831bb696139024923e9bc43e3da0d7993951e9/docs/guides/qm.md):

- **Members and attested people.** `gbrain access member add <id>` creates a person. `gbrain access member link <id>
  --qm <external id>` links the id a trusted system sends. A client granted the attest right (`gbrain auth rescope
  --client <id> --attest-actor qm --attest-ops ...`) names the person on each request in the `x-qm-actor` header, and
  gbrain reads and writes as that member. External ids are compared exactly, with no case folding.
- **Facts readable by one person alone.** `memory_write` saves 1 to 20 facts on `memory/members/<member>`, a page
  whose only reader is that member, as private rows. `memory_recall` reads the person's own recent facts first, then
  the facts they may read. `remember` from an attested person or from a credential bound to a member lands on the same
  page, even when it names a shared entity.
- **Member-bound credentials.** `gbrain auth rescope --client <id> --member <id>` binds a key to one person, who then
  reads as themselves without an attesting system.
- **Personal sources.** `gbrain access member source add <member> <source>` binds a source, such as a direct-message
  source, to one person; an attested call reads its grant minus every source bound to someone else.
- **Per-person folders and pages.** `gbrain access rule add --prefix <folder/> --readers member:<id>` restricts a
  folder, and `readable_by` in a page's front matter restricts one page.
- **Requester scope.** On a brain with two or more enabled members, a remote read from a credential bound to nobody is
  refused (`requester_scope_required`) unless the operator marks it `reads_unscoped`.
- **Owner-approved proposals.** `memory_propose` holds a person's proposed timeline entry or link in a table until
  the brain owner approves it; until then it reaches no read path.

Three names in the request differ from the open release. `synthesize` is not a remote operation there: it is a phase of
the maintenance cycle (`gbrain dream`) that the brain host runs, so it is tested as what it writes (see "Read paths").
"Entity cards" are the `entity` operation and the cards inside `context_pack`. `think` is a read operation; on a
keyless brain it returns the gathered evidence without a model answer.

## Build and data

- **gbrain: the newest release on gbrain's master when the first counted probe runs.** Today that is v0.60.769.0
  (`38831bb6`); this repository pins v0.60.748.0, so the results branch moves the pin with
  `bun eval/runner/gbrain-pin.ts bump` before any counted probe. If a newer release lands before the first counted
  probe, a dated amendment re-pins to it first. Once counted probes start, the build is frozen for this experiment and
  the receipt records the commit.
- **World:** generator `person-isolation-v1` (`eval/generators/person-isolation-gen.ts`, added with the runner), seeds
  20261124, 20261125 and 20261126 for the counted run. The ledger's hash goes in the receipt.
- **Postgres:** the `pgvector/pgvector:pg16` image, published on `127.0.0.1` only, one fresh database per cell,
  dropped afterwards; image digest in the receipt. PGLite: a fresh brain directory per cell.
- **Hermetic and keyless:** every provider key is removed from the environment of the runner and of every gbrain process
  it starts, `GBRAIN_HOME` points at a fresh directory, and no embedding or chat provider is configured. The runner
  refuses to start if any provider key is visible to it.

## The world

Each seed draws the same structure with different names, topics and canary words.

**People.** Six enabled members and one disabled member, chosen to stress the places an identity check can slip:

| Member | External id shape | Why it is there |
|---|---|---|
| P1 | Slack-style id (`U0...`) | the plain case |
| P2 | P1's member id plus a suffix (`<P1>-lee`), and P1's external id in lower case | prefix and case collisions: `memory/members/<P1>` is a prefix of `memory/members/<P1>-lee`, and ids are compared exactly |
| P3 | an email address | the email-shaped id |
| P4 | `oidc:<hash>:<subject>` | the federated id |
| P5 | Slack-style id, in a group with P1 | group membership must not widen a member page |
| P6 | Slack-style id, saves nothing | the ghost member for the existence check |
| D | Slack-style id, writes, then is disabled | a person who left |

**Sources.** `team`, shared by everyone, and one direct-message source per person, `dm-<member>`, bound to that
person with `gbrain access member source add`.

**What each person holds.** Each person P1 to P5 and D gets seven channels, each carrying its own canary word (a
nonsense token drawn from the seed that appears nowhere else):

1. `memory_write` facts saved by P as an attested person: a preference, an event with a past `valid_from`, and a fact
   naming a shared company;
2. `remember` through P's own member-bound key, naming a shared company page as its entity;
3. `remember` by P as an attested person about a colleague, naming that colleague's `people/<member>` page as its
   entity (the colleague must not read what P said about them);
4. a page in `team` whose front matter sets `readable_by: [member:P]`;
5. a page in P's direct-message source `dm-P`;
6. a page under a per-person folder `private/P/` in `team`, restricted by an access rule naming `member:P`;
7. a pending `memory_propose` timeline entry on a shared page, never approved.

**Shared and public content.** World pages in `team` for each company, project and person, and world facts saved by
the trusted local caller, all using the same topic words as the private channels and carrying public markers. These are
the controls that show a probe had signal.

**Generator invariants,** checked by a test that fails the build: every canary, private slug and id is unique and
appears in no public page or fact; the public markers appear in no private channel; P2's member id has P1's as a prefix
and P2's external id is P1's in lower case. No probe argument ever contains a canary: arguments are built from slugs,
ids, names and topic words only, and the scanner ignores any token the harness itself sent.

Every write goes through gbrain's own path for its transport: the CLI on the host for members, links, sources, rules,
pages and credentials; `memory_write`, `remember` and `memory_propose` through the transport under test (the CLI cells
write these through their server over HTTP, because the thin client cannot name a person). Every credential is created
after the second member exists, so no credential is inside requester scope's grace period for older clients; the
runner asserts the unbound client is refused, not admitted by grace, before any probe. Each write's
receipt is checked (status committed or inserted, fact on `memory/members/P`, row private) before any probe runs; a write
that fails makes the cell a harness error, not a pass.

## Callers

For each target person P, every probe runs as each of these callers, none of which is P:

| Caller | How it calls | What it may read of P's |
|---|---|---|
| `attested-dm` | QM-style client, attest right for every attestable read operation, `--attest-read person`, granted `team` and every `dm-*` source, with `x-qm-actor` set to another person Q's external id | nothing |
| `attested-room` | a second QM-style client, `--attest-read scope`, granted `team`, naming `source_id: team` (and, as a variant, `dm-P`), with `x-qm-actor` set to Q | nothing |
| `attested-variant` | the `attested-dm` client with `x-qm-actor` set to a near-miss of P's id: other case, surrounding spaces, a trailing character, P2's id for P1; and with `acting_user` set to P while the header names Q | nothing: each reads as the member its exact id links to, or is refused |
| `member-key` | Q's member-bound client | nothing |
| `bare-attest` | the `attested-dm` client with no `x-qm-actor` | nothing |
| `unbound-unscoped` | a client bound to nobody, marked `reads_unscoped` by the operator | nothing; world content only |
| `unbound` | a client bound to nobody | nothing; refused by requester scope |
| `left` | D's member key and D's attested id, after D is disabled (for targets other than D) | nothing; refused |
| `host-as` (CLI cells) | the host's own CLI previewing as Q (`gbrain <command> --as Q`) | nothing |

The CLI cells have no attested callers, because the thin client cannot set `x-qm-actor`; they run `member-key`,
`unbound-unscoped`, `unbound` and `left` through the thin client and `host-as` on the host.

**Callers that must be refused** (`unbound`, `left`, a near-miss id that links to nobody, a mismatched `acting_user`)
have the documented refusal as their signal: `requester_scope_required` for the unbound client, the disabled-member
refusal for `left`, and `actor_not_attested` with reason `actor_unlinked`, `invalid_actor_id` or `argument_mismatch`
for the attested variants (the exact code per caller is recorded from the pilot in the launch amendment). Any other
answer from such a caller, even one with no canary in it, is an identity slip. A near-miss id that is linked to another
member (P2's id is P1's in lower case) reads as that member and is scanned like any other person.

Positive controls, run on the same arguments: P as an attested person, P's member key, and the trusted local caller.
The brain owner's own credential is not a caller here: by design it reads the whole brain.

## Read paths

**Enumerated at run time.** Every operation in gbrain's registry that does not write (`mutating` false), plus an explicit
list of operations marked as writing that are reads for a remote caller: `think` (marked writing at v0.60.769.0 because
its local CLI can save a page; a remote call is forced read-only). A read path added in a later release is fuzzed the
day it ships. Which of these each cell serves to each caller is frozen: the pilot records the table of cell, caller and
served operations at the pinned release, and the launch amendment commits it before any counted probe. In the counted
run, an operation the table says is served but the cell refuses, or a mandatory operation missing from a cell's served
set, fails the coverage floor; it never shrinks the denominator. Arguments are
synthesised per operation from its parameter list, aimed at each of P's targets (member page, folder page,
`readable_by` page, direct-message page and source, each fact id, each write receipt and proposal id, P's colleague's
people page, the shared company page) and at the topic words, P's name and the company's name. A canary is never sent.
Each enum parameter is fuzzed over its values, each widening boolean (`include_private`, `all_sources` and the like)
is set, and each `source_id` parameter takes `team`, `dm-P` and `__all__`.

**Mandatory: these must carry signal (defined below) on every cell that serves them,** or the cell fails its coverage
floor: `memory_recall`, `recall`, `query`, `search`, `get_page`, `get_chunks`, `entity`, `context_pack`, `delta`,
`think`, `volunteer_context`, `whois`, `get_backlinks`, `get_timeline`, `list_write_requests` and
`get_write_request`. On the CLI cell the mandatory set is the named commands the thin client serves for these
operations (at least `query`, `search`, `get`, `recall` and `think`), enumerated from the registry's CLI hints.

**Write-shaped reads.** Calls that write but answer with data, made as Q against P's ids: `memory_write` replaying P's
idempotency key with fresh decoy facts that carry no canary (compared with the same decoys under a key nobody used),
`forget_fact` and `forget` on P's fact ids, `get_write_request` and `cancel_write_request` on P's receipt and proposal
ids, and `memory_propose` aimed at P's restricted pages. Each must answer exactly as it does for a never-written id.
They run after every read probe of the seed, and afterwards P's rows (fact text, visibility, page, proposal state) must
be byte-for-byte what they were before.

**After the maintenance cycle.** The host runs `gbrain dream` with every phase that runs keyless;
then the mandatory operations run again as every caller in the table, and no P canary may be returned to anyone but P.
The runner also lists every page holding a P canary after the cycle and fails if any of them is readable, by its source,
folder rule or `readable_by`, by a member other than P (the owner, who reads everything, is not counted). A phase that
does not run keyless is listed in the receipt as not covered. `synthesize` is one: in the open release it turns
conversation transcripts into pages, its model step needs a key, and this world holds no transcripts, so this plan
does not cover it.

## Cells and conditions

Six cells: three transports on two engines.

| Transport | What it exercises |
|---|---|
| `mcp-dispatch` | gbrain's MCP tool dispatch in process, with OAuth tokens issued by the client-credentials grant and verified by gbrain's provider, `x-qm-actor` passed as the HTTP layer passes it |
| `http` | `gbrain serve --http --bind 127.0.0.1` as a separate process; every probe a real HTTP request with a bearer token and the `x-qm-actor` header |
| `cli` | gbrain's thin-client CLI (`gbrain init --mcp-only` with a member-bound or unbound client) against that server, one process per command; stdout and stderr are scanned |

Each on PGLite and on Postgres. Every cell runs these conditions:

- **cold:** each probe on a fresh session;
- **warm and shared:** P's positive control runs immediately before Q's probe on the same client and, for the attested
  callers, the same MCP session, as one QM process serving two people would;
- **concurrent:** 8 requests in flight, mixing people on one client.

The brain is keyless, so search is keyword search; the vector and hybrid paths are not exercised (see "What this does
not test").

## Must-fail controls

A zero-leak gate is worth something only if it can fail. Each cell also runs two controls, scored exactly like the
counted probes but reported apart from them:

- **planted canary:** one of P1's canaries is copied onto a world page every caller can read; every probe that returns
  that page must be scored a content leak, on every response surface the cell scans;
- **operator misgrant:** a second member key for Q is granted P's direct-message source, a grant gbrain documents as
  outside personal-source binding ("member-bound credentials are unchanged"); its reads of that source must be scored
  leaks.

A cell is valid only if both controls fail the gate. If the misgrant turns out not to leak at the pinned release, the
pilot says so and the launch amendment names another documented operator escape hatch before the counted run.

## Probe budget and profiles

- **full (counted):** every operation in the served table, at every target kind its parameters take, for every writing
  person as the target, as every caller, with the base arguments plus up to 3 enum variants; warm-and-shared for every
  probe and cold-and-concurrent for every probe on the in-process and HTTP cells. The CLI cells run the mandatory CLI
  commands only, at every target and caller, warm only, because each probe is a process.
- **pilot:** a stratified tenth of full on seed 20261124: every operation and caller appears, targets and variants are
  sampled.
- **ci:** seed 20261124 on PGLite (in-process and HTTP) in the offline tier, and the same on Postgres in its own CI job:
  each served operation once per caller kind, aimed at one target person rotated by operation, base arguments only,
  warm only, with a 12-minute cap per cell. A cap reached is a harness error, never a pass.

The launch amendment sets the counted sizes from the pilot's measured rate. If full does not fit the cell time limits
below, it cuts enum variants first and then the cold condition on the slowest cell, and never drops an operation and
caller pair from the served table.

## What counts as a leak

A probe's whole response is scanned: text content, `structuredContent`, `_meta`, notices, error bodies and HTTP headers;
on the CLI, stdout and stderr.

- **Content leak:** any of P's canaries in a response to anyone but P.
- **Identifier leak:** one of P's private fact ids, receipt or proposal ids, direct-message page slugs or restricted
  slugs in a response to a probe that did not send it.
- **Existence oracle:** on a targeted probe, the response to P's target differs from the response to a ghost target of
  the same shape, after the target values and volatile fields (timestamps, request ids, latency) are masked. Ghosts: P6's
  member page (P6 never saved anything), a fact id 1,000 above the largest, a fresh receipt id, never-written slugs of
  the same shape, and an empty source bound to P6.
- **Identity slip:** a near-miss id or a mismatched `acting_user` that reads as P, or a disabled member's credential or
  id that reads anything.
- **Write-shaped slip:** a write-shaped read that answers differently for P's id than for a ghost id, or that changes
  P's rows.

**Signal.** A probe has signal when its positive control as P read one of P's canaries through the same operation and
arguments, and the caller under test read a public marker through the same operation. A probe without both is counted
as "no signal", never as "no leak". For a caller that must be refused, the documented refusal is its signal (above).
An operation has signal on a cell when at least one of its probes does.

## Metric, denominator and decision rule

- **Gate (all must be zero, on every cell):** content leaks, identifier leaks, existence oracles, identity slips and
  write-shaped slips, summed over every probe, caller, condition and seed.
- **Coverage floor:** every mandatory operation has signal on every cell that serves it, and every channel of every
  person is read back by its owner on at least one operation per cell (so a world that failed to seed cannot pass).
- **Validity:** a probe that times out (10 s in process, 30 s over HTTP and the CLI) or throws inside the harness is a
  harness error. More than 2 harness errors on one operation in one cell, any failed write receipt, a must-fail control
  that passes, or a provider key visible to the run makes the cell an error, which fails the gate. Each stop has a
  stable code, a one-line fix and its own exit status, so a broken harness never reads as a leak or as a pass:

| Code | What happened | Fix | Exit |
|---|---|---|---|
| `PI_LEAK` | at least one gate contract is non-zero | none in this repository; the repro goes privately to gbrain's maintainers | 1 |
| `PI_COVERAGE` | a mandatory operation has no signal, a served operation is refused, or a channel is never read back | fix the generator or argument synthesis (FIX-METHOD) | 2 |
| `PI_CONTROL` | a must-fail control passed | fix the scanner or the control before trusting any result | 2 |
| `PI_PROVIDER_KEY_VISIBLE` | a provider key is set in the runner's or a child's environment (the variable is named, never its value) | unset it; the run is keyless | 3 |
| `PI_WRITE_FAILED` | a seeding or person write did not commit | read the step's redacted output in the report folder | 3 |
| `PI_HARNESS` | more than 2 timeouts or harness exceptions on one operation, or a profile's time cap reached | rerun the cell; a second failure is a harness bug | 3 |
| `PI_POSTGRES_UNAVAILABLE` | a Postgres cell could not create its database | start Postgres on `127.0.0.1` and pass `--pg-url` | 69 |
- **Denominator:** probes, by cell, operation, caller, channel and condition, printed in the receipt.
- **Smallest detectable difference.** There is no comparison: one leak fails. Probes are deterministic and correlated
  (the same operation and caller fail together), so a pooled leak rate would overstate what was shown. The result is
  reported as "0 leaks in n probes over k operations with signal, per cell", with the operations that had no signal
  listed by name. The rule-of-three bound, 3/n, is given only per operation and cell, as a measure of how many distinct
  argument sets and callers reached that operation (at least 100 per mandatory operation per cell over the three seeds),
  not as a probability that the operation leaks. A path whose leak needs a condition the world never creates is outside
  what this shows; the list of what the world does not create is below.

## What each outcome changes (R97)

| If | Then |
|---|---|
| every cell is at zero on the gate, meets the coverage floor and is valid | the category becomes a gate in CI the way N6 is: the offline tier runs the PGLite cells on every pull request and every gbrain pin bump, and a CI job with a Postgres service runs the Postgres cells. README and the results page say "no cross-person leak in <n> probes at <release>" with the upper bounds, and gbrain's multi-person setup can cite it. Nothing changes in how QM or any multi-person brain is configured |
| any content leak, identifier leak, identity slip or write-shaped slip, on any cell | it is a security bug: the repro goes privately to gbrain's maintainers (GBRA-108) as a severe hotfix the same day, and to GBEV-3. No public text names the path until gbrain ships the fix. The gate lands in CI only once it is green on the fixed release, which a dated amendment names before the re-run; the results page then names the leaking release, the fixed release and the path. Until then no page here says gbrain keeps people apart |
| only existence oracles | the repro goes privately to gbrain's maintainers, who set its severity; the same holding rule applies to public text. The gate's other contracts land in CI, and the oracle contract lands when it is green |
| a mandatory operation has no signal on a cell, or a channel is never read back by its owner | the method is at fault, not gbrain (FIX-METHOD): if seen in the pilot, the generator or argument synthesis is fixed in a dated amendment before the counted run; if seen in the counted run, that operation is reported uncovered on that cell and the CI gate carries it as a known gap until a later amendment covers it |
| a cell is invalid (harness errors, failed writes, a must-fail control that passed) | that cell is re-run after the harness is fixed, by a dated amendment; no number from it is published |

## Security handling

A leak is a security bug. The runner writes a leaking probe's full arguments and response, and the per-operation and
per-caller counts, only to the ignored `eval/reports/` folder. On a failing run, the console, CI logs and any committed
receipt carry only the total and `FAIL`, never which operation, caller or channel leaked. The repro and the detail go to
GBRA-108 through GBEV-3's private channel the same turn it is found. Until gbrain has shipped the fix, no commit message,
pull request body, results page or CI log in this public repository describes the exposure, and the results pull
request (runner, generator and CI job) stays unmerged, because the public runner and world would let anyone reproduce
it. The CI gate runs only on releases already measured green; a pin bump to a leaking release fails it with the total
alone.

## Pilot per cell (R111)

Keyless, so a cell's budget is its counted probes; each pilot runs on at most a tenth of them. On seed 20261124, each
cell runs a stratified tenth of its probes covering every mandatory operation and every caller, before any counted
probe. Each pilot must show:

- **the part under test ran:** every channel's write receipt is committed for every person, and each mandatory
  operation's positive control reads P's canary at least once;
- **no judge:** there is no model judge (below);
- **units supplied:** the world seeds through the CLI and the transport, and the cell finishes inside its time limit
  (30 minutes for the in-process cells and 60 minutes for the HTTP and CLI cells);
- **controls fail:** both must-fail controls are caught.

The pilot also records the served-operations table, the refusal code per refusal caller and the measured probe rate per
cell, which the launch amendment commits before the counted run.

A cell whose pilot fails is fixed and re-piloted, or left out and reported as left out. A leak found in a pilot is
handled exactly as a counted leak.

A development probe ran before this plan was written, on the pinned v0.60.748.0, PGLite, in-process MCP dispatch only:
three members, five channels each (`memory_write`, `remember` through the member key, `remember` about a colleague, a
`readable_by` page and a direct-message page, though no client was granted the direct-message sources; no folder rules or
proposals), every non-writing operation (108), each called as the two other people (attested and member key), the bare
attest client and an unbound client, one argument set per target. It found no cross-person content, every fact landed
private on its writer's member page, and the owners' own controls read their canaries through 60 of the 108 operations. It is development
evidence, not a counted result.

## Models and judge check

No model is called. The category is keyless; no provider key reaches any process, and keyless `think` returns the
evidence it gathered, which is scanned. The registry entry lists one placeholder, "none (keyless)", because its
`models` list may not be empty. There is no model judge: leaks are found by exact canary and identifier matching
against the generator's ledger.

An adversarial arm, in which claude-opus-5-5 and particle-1 act as one person's assistant and are prompted to get
another person's memory out through the tools, is a separate question that would need its own preregistration and a
paid window. It is not part of this plan.

## Interim look

Not required: the run is keyless and gates on zero.

## Budget

No paid calls and no ledger. The run's cost is machine time, recorded in the private tracking issue.

## What this does not test

The brain owner's own access (it reads everything by design); channel audiences (`x-qm-audience`, refused by gbrain
until its wave 2); shared-scope writes (`memory_write` with `source_id`) beyond reading them as a scope; repo-backed
brains and git history; Rust engine; vector and hybrid search (the brain is keyless); the `synthesize` phase;
an operator granting one person's member key another person's direct-message source (used here only as a must-fail
control, because gbrain documents it as outside personal-source binding); network attacks on the server (TLS, header injection, forged tokens beyond the
near-miss ids above); a compromised attest client, which by design may name any linked person; timing side channels;
operator mistakes such as granting a room client `--attest-read person`, which gbrain's doctor flags.

## Registry entry

`docs/benchmarks/preregistrations.d/person-isolation.json`.

## Amendments

None yet.

## Disclosures

gbrain is Garry Tan's own project. Disclosure: QM is a project of Y Combinator, which Garry Tan runs.
