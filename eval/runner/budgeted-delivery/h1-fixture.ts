/**
 * An invented custody fixture for the budgeted delivery H1 keyless dry run: files shaped like sealed confirmation
 * v2's private files, with no sealed text. Twelve invented personas, each a history of twelve chats of about 3,000
 * tokens (sealed v2's chats are about 3,100) with LongMemEval timestamps, and five questions per persona in sealed
 * v2's mix (two multi-session, one temporal, one knowledge update, one abstention). It writes, into one directory:
 *
 *   questions.json    sealed-confirmation-questions-v1, opaque ids, allowlisted fields only
 *   labels.json       sealed-confirmation-labels-v1
 *   manifest.json     the two files' SHA-256 commitments
 *   access-log.jsonl  six invented lines in the shape the H1 decision file records for the real log
 *   decision.json     the committed H1 decision file with the fixture's set, manifest, commitments and counts
 *
 *   bun eval/runner/budgeted-delivery/h1-fixture.ts --out <dir inside the dry run's custody root> [--decision <committed decision.json>]
 *
 * Everything is deterministic (seeded), so the dry run's receipts can be reproduced.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seededRandom } from '../stats/paired.ts';
import { lmeDate } from '../../generators/sealed-confirmation-gen.ts';
import { LABELS_SCHEMA, QUESTIONS_SCHEMA, validateLabelsFile, validateQuestionsFile, type LabelsFile, type QuestionsFile, type SealedLabel } from '../sealed-confirmation-lib.ts';

const TEMPLATES = [
  { name: 'Ilse', city: 'Tarnow Bay', job: 'a ferry dispatcher', hobby: 'pottery', pet: 'a grey cat named Pebble', studios: ['Clayhouse North', 'the Kiln Loft', 'Wheel and Slip'], car: ['a blue hatchback', 'a rented van', 'an electric scooter'] },
  { name: 'Marek', city: 'Old Varn', job: 'a hospital pharmacist', hobby: 'trail running', pet: 'a beagle named Crumb', studios: ['the Ridge Loop', 'Cedar Hollow trail', 'the quarry path'], car: ['a green estate car', 'a bicycle', 'a car-share pass'] },
  { name: 'Odile', city: 'Penmarsh', job: 'a museum conservator', hobby: 'choral singing', pet: 'two finches', studios: ['the Harbour Choir', 'St Brann chamber group', 'the Thursday madrigal circle'], car: ['a silver sedan', 'a tram pass', 'a folding bike'] },
  { name: 'Tobiah', city: 'Lowfield', job: 'a bakery owner', hobby: 'birdwatching', pet: 'an old terrier named Biscuit', studios: ['the Fen Hide', 'Saltmarsh reserve', 'the reservoir blind'], car: ['a white delivery van', 'a red pickup', 'a motorbike'] },
];
const NAMES = ['Ilse', 'Marek', 'Odile', 'Tobiah', 'Ruta', 'Casimir', 'Linnea', 'Abram', 'Yvette', 'Dorian', 'Hesper', 'Quill'];
/** Twelve invented personas (sealed v2 has 40), enough clusters for the family's ten-cluster minimum. */
const PERSONAS = NAMES.map((name, i) => ({ ...TEMPLATES[i % TEMPLATES.length], name }));
const FILLER_TOPICS = ['meal planning for a busy week', 'how to fix a squeaky door hinge', 'comparing two budgeting methods', 'tips for sleeping better', 'writing a polite complaint letter', 'stretching routines for desk work'];
const WORDS = 'schedule morning budget recipe garden weekend method practice routine neighbour market evening letter project notebook kitchen window journey season balance option detail reminder pattern habit planner'.split(' ');

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function buildFixture(seed = 20261010): { questions: QuestionsFile; labels: LabelsFile } {
  const rng = seededRandom(seed);
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rng() * 16).toString(16)).join('');
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  /** About `chars` characters of invented prose around the given fact sentences. */
  const prose = (facts: string[], chars: number) => {
    const out: string[] = [...facts];
    while (out.join(' ').length < chars) out.splice(Math.floor(rng() * (out.length + 1)), 0, `The ${pick(WORDS)} and the ${pick(WORDS)} came up again, along with a ${pick(WORDS)} for the ${pick(WORDS)}.`);
    return out.join(' ');
  };
  const chat = (userFacts: string[], topic: string) => {
    const turns: QuestionsFile['haystacks'][number]['sessions'][number]['turns'] = [];
    for (let t = 0; t < 12; t++) {
      turns.push({ role: 'user', content: prose(t === 0 ? [`I want to talk about ${topic}.`, ...userFacts] : [], 520) });
      turns.push({ role: 'assistant', content: prose([`Here is some general guidance on ${topic}.`], 480) });
    }
    return turns;
  };
  const haystacks: QuestionsFile['haystacks'] = [];
  const questions: QuestionsFile['questions'] = [];
  const labels: SealedLabel[] = [];
  const start = Date.UTC(2025, 0, 6);
  PERSONAS.forEach(p => {
    const hay = `h-${hex(12)}`;
    const sessions: QuestionsFile['haystacks'][number]['sessions'] = [];
    const add = (offsetDays: number, facts: string[], topic: string) => {
      const id = `s-${hex(12)}`;
      sessions.push({ session_id: id, date: lmeDate(iso(start + offsetDays * DAY), 9 * 60 + Math.floor(rng() * 600)), turns: chat(facts, topic) });
      return id;
    };
    const st = p.studios.map((s, i) => add(20 + i * 70, [`Today I went to ${s} for the first time for ${p.hobby}.`], p.hobby));
    const cars = p.car.map((c, i) => add(35 + i * 60, [`These days I get to work in ${c}.`], 'my commute'));
    const move = add(150, [`I moved to ${p.city} last week and started as ${p.job}.`], 'settling in after a move');
    const petA = add(200, [`I adopted ${p.pet} on Saturday.`], 'looking after a new pet');
    const petB = add(260, [`The vet said ${p.pet.split(' named ')[0]} is healthy.`], 'pet health');
    const fillers = FILLER_TOPICS.slice(0, 3).map((t, i) => add(10 + i * 110, [], t));
    void fillers;
    sessions.sort(() => rng() - 0.5);
    haystacks.push({ haystack_id: hay, sessions });
    const qdate = lmeDate(iso(start + 330 * DAY), 18 * 60);
    const ask = (type: SealedLabel['question_type'], question: string, answer: string, gold: string[], related: string[] = []) => {
      const id = `q-${hex(12)}`;
      questions.push({ question_id: id, haystack_id: hay, question, question_date: qdate });
      labels.push({ question_id: id, question_type: type, abstention: type === 'abstention', answer, answer_session_ids: type === 'abstention' ? [] : gold, related_session_ids: related, audit_flags: [] });
    };
    ask('multi-session', `How many different places have I gone to for ${p.hobby}?`, '3', st);
    ask('multi-session', 'How many different ways of getting to work have I mentioned?', '3', cars);
    ask('temporal-reasoning', `How many days after moving to ${p.city} did I adopt my pet?`, 'about 50 days', [move, petA]);
    ask('knowledge-update', 'How do I get to work now?', p.car[2], cars);
    ask('abstention', `What is the name of my manager at my job as ${p.job}?`, 'The chats never say.', [], [move, petB]);
  });
  const q: QuestionsFile = { schema: QUESTIONS_SCHEMA, set_id: 'h1-dry-run-fixture', haystacks, questions };
  const l: LabelsFile = { schema: LABELS_SCHEMA, set_id: 'h1-dry-run-fixture', labels };
  const problems = [...validateQuestionsFile(q), ...validateLabelsFile(l, q)];
  if (problems.length) throw new Error(`fixture invalid:\n${problems.join('\n')}`);
  return { questions: q, labels: l };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const one = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const out = resolve(one('--out') ?? '');
  if (!one('--out')) { console.error('usage: bun eval/runner/budgeted-delivery/h1-fixture.ts --out <dir> [--decision <decision.json>]'); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const { questions, labels } = buildFixture();
  const qText = JSON.stringify(questions), lText = JSON.stringify(labels);
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  writeFileSync(join(out, 'questions.json'), qText);
  writeFileSync(join(out, 'labels.json'), lText);
  const manifest = { set: 'h1-dry-run-fixture', status: 'invented fixture for the H1 keyless dry run; no sealed text', commitments: {
    'questions.json': { sha256: sha(qText), bytes: Buffer.byteLength(qText) }, 'labels.json': { sha256: sha(lText), bytes: Buffer.byteLength(lText) } } };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const decisionPath = one('--decision') ?? join(import.meta.dir, '../../../docs/benchmarks/2026-10-10-gbrain-budgeted-delivery-h1/decision.json');
  const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
  const entries = decision.sealed.access_log_before.entries as Array<{ action: string; decision_id: string | null }>;
  writeFileSync(join(out, 'access-log.jsonl'), entries.map((e, i) => JSON.stringify({ at: `2026-10-0${1 + i}T12:00:00.000Z`, action: e.action, purpose: 'invented fixture line', decision_id: e.decision_id, labels_sha256: 'fixture', run_sha256: null, operator: 'fixture', host: 'fixture' })).join('\n') + '\n');
  const kinds: Record<string, number> = {};
  for (const l of labels.labels) kinds[l.question_type] = (kinds[l.question_type] ?? 0) + 1;
  decision.fixture = 'Keyless dry-run copy of the committed H1 decision file: only sealed.set, manifest, the two commitments and the counts differ.';
  decision.sealed = { ...decision.sealed, set: manifest.set, manifest: join(out, 'manifest.json'), questions_sha256: manifest.commitments['questions.json'].sha256, labels_sha256: manifest.commitments['labels.json'].sha256,
    questions: questions.questions.length, personas: questions.haystacks.length, kinds };
  writeFileSync(join(out, 'decision.json'), JSON.stringify(decision, null, 2) + '\n');
  console.log(JSON.stringify({ questions: questions.questions.length, haystacks: questions.haystacks.length, sessions: questions.haystacks.reduce((n, h) => n + h.sessions.length, 0),
    chars_per_session: Math.round(questions.haystacks.flatMap(h => h.sessions).reduce((n, s) => n + s.turns.reduce((m, t) => m + t.content.length, 0), 0) / questions.haystacks.reduce((n, h) => n + h.sessions.length, 0)), kinds,
    questions_sha256: manifest.commitments['questions.json'].sha256, labels_sha256: manifest.commitments['labels.json'].sha256 }, null, 2));
}
