/**
 * B2 corrections: 100 seeded corrections over world-v1 entities.
 *
 * Each correction lives in its own isolation unit. The unit's base records
 * are four conversations in which the user shares notes on a world-v1
 * entity (the target and three entities of the same kind). Every one of the
 * four mentions, in passing, the same kind of detail with its own value
 * ("the Forge offsite is booked in Asheville", "the Keel offsite is booked
 * in Galena"). The correction changes the target's value. Then come five
 * unrelated writes (news about the same entity, news about another entity,
 * small talk) and the question is asked after the first and after the fifth.
 * A probe before the correction checks that the original value was
 * answerable at all.
 *
 * Correction arms are data (arms.json) and run through one adapter
 * interface, so each system uses its own documented correction path on the
 * same raw records:
 *   gbrain-edit-sync            edit the conversation page, then sync;
 *   gbrain-forget-remember      forget facts holding the old value, then
 *                               remember the corrected statement;
 *   gbrain-remember-replaces    remember with `replaces` (named arm, only when
 *                               that parameter exists at the measured build);
 *   comparator-edit-invalidate  the comparator's edit or invalidate operation
 *                               on memories holding the old value;
 *   comparator-reretain         re-retain the edited document under its id;
 *   gbrain-append, comparator-append  append a correction message, identical
 *                               bytes for both systems.
 *
 * Metrics per arm: corrected-value accuracy and stale-answer rate after 1
 * and after 5 unrelated writes. Inspectability (can an operator see the old
 * value and when it changed) is reported separately by `inspect`.
 */
import { Rng, addDays } from '../generators/seeded.ts';
import type { RichPage } from '../runner/queries/relational.ts';
import { STUB_ABSTAIN, capitalize, contextBlocks, countValue, fill, isoAt, makeDocument, norm, opaqueId, renderContext, scoreGold, statementRegex } from './common.ts';
import { fillerSession } from './filler.ts';
import { worldPageConversation, worldPages, worldTextLower } from './world-conversations.ts';
import type { HarnessDocument, HarnessQuery, ScoreResult, ScorerLabel, SuiteBundle, SuiteDefinition } from './types.ts';

export const CORRECTIONS_VERSION = 'corrections-v1';
export const CORRECTIONS_SEED = 20261006;
export const CORRECTIONS_SIZES = { full: { items: 100 }, smoke: { items: 6 } } as const;
export const CHECKPOINTS = [0, 1, 5] as const;
export type Checkpoint = typeof CHECKPOINTS[number];

type EntityKind = 'company' | 'person';

interface AttributeFamily {
  id: string;
  kind: EntityKind;
  noun: string;
  statement: string;
  question: string;
  pool: readonly string[];
}

export const ATTRIBUTE_FAMILIES: readonly AttributeFamily[] = [
  {
    id: 'offsite-city', kind: 'company', noun: 'offsite location',
    statement: 'the {E} offsite is booked in {V}.', question: 'Where is the {E} offsite booked?',
    pool: ['Asheville', 'Boise', 'Duluth', 'Savannah', 'Missoula', 'Santa Fe', 'Burlington', 'Taos', 'Ithaca', 'Marfa', 'Sedona', 'Galena', 'Bozeman', 'Flagstaff', 'Chattanooga', 'Port Townsend', 'Stowe', 'Moab'],
  },
  {
    id: 'bank', kind: 'company', noun: 'bank',
    statement: '{E} banks with {V}.', question: 'Which bank does {E} use?',
    pool: ['Fernhill Savings', 'Northgate Trust', 'Cobalt Credit Union', 'Harborline Bank', 'Prairie Mutual', 'Kestrel Federal', 'Granite Peak Bank', 'Bluewater Trust', 'Old Mill Savings', 'Larchmont Bank', 'Summit Ridge Credit Union', 'Tidewell Bank'],
  },
  {
    id: 'counsel', kind: 'company', noun: 'law firm',
    statement: "{E}'s law firm is {V}.", question: "Which law firm does {E} use?",
    pool: ['Hale Marsh LLP', 'Okonjo Brandt LLP', 'Whitcombe Reyes LLP', 'Strand Albescu LLP', 'Penhallow Ito LLP', 'Carrow Lindgren LLP', 'Merriweather Osei LLP', 'Thorne Vasquez LLP', 'Ballantyne Koh LLP', 'Ashgrove Patel LLP', 'Dunmore Achebe LLP', 'Kinsale Moretti LLP'],
  },
  {
    id: 'release-codename', kind: 'company', noun: 'release code name',
    statement: "{E}'s next release is code-named {V}.", question: "What is the code name of {E}'s next release?",
    pool: ['Larkspur', 'Bluebell', 'Thistle', 'Foxglove', 'Yarrow', 'Snapdragon', 'Wintergreen', 'Columbine', 'Hollyhock', 'Primrose', 'Bittersweet', 'Meadowsweet', 'Trillium', 'Lupine'],
  },
  {
    id: 'assistant', kind: 'person', noun: 'assistant',
    statement: "{E}'s assistant is {V}.", question: "Who is {E}'s assistant?",
    pool: ['Odessa Pryce', 'Fennimore Vale', 'Ingrid Solberg', 'Thaddeus Moore-Quinn', 'Ximena Rocha', 'Barnaby Ellison', 'Calla Whitlow', 'Ignatius Rowe', 'Marisol Ventura', 'Percival Ames', 'Junie Calloway', 'Leopold Strand'],
  },
  {
    id: 'gym', kind: 'person', noun: 'gym',
    statement: '{E} trains at {V}.', question: 'Which gym does {E} train at?',
    pool: ['Ironwood Athletic Club', 'Riverside Climbing Gym', 'Northside Boxing Club', 'Peak Form Studio', 'Granite Strength Lab', 'Harbor Rowing Club', 'Cedar Lane Fitness', 'Summit Pilates Studio', 'Foundry Barbell', 'Lakeshore Swim Club', 'Copperline Cycling Studio', 'Willow Yoga Loft'],
  },
  {
    id: 'lunch-spot', kind: 'person', noun: 'favorite lunch spot',
    statement: "{E}'s favorite lunch spot is {V}.", question: "What is {E}'s favorite lunch spot?",
    pool: ['Sorrel Kitchen', 'The Brass Ladle', 'Maple and Rye', 'Kombu Ramen Bar', 'The Green Fork', 'Tamarind Cafe', 'Bodega Luz', 'The Pickled Pear', 'Olive Branch Deli', 'Saltgrass Tacos', 'The Rusty Spoon', 'Peppercorn Diner'],
  },
  {
    id: 'dog-name', kind: 'person', noun: 'dog',
    statement: "{E}'s dog is named {V}.", question: "What is {E}'s dog named?",
    pool: ['Barnaby', 'Clover', 'Dumpling', 'Fennel', 'Gnocchi', 'Huckleberry', 'Indigo', 'Jellybean', 'Kipper', 'Lentil', 'Marzipan', 'Nutmeg', 'Oolong', 'Porridge'],
  },
];

const CORRECTION_FRAMES = [
  "I need to correct something I told you about {E}'s {N}: it is not {OLD} after all. {NEW}",
  "Quick correction on {E}: I had the {N} wrong, it isn't {OLD}. {NEW}",
  "Scratch what I said about {E}'s {N} being {OLD}, that was a mistake. {NEW}",
];

const NEWS_FRAMES = ['Some news about {E}: {S}', 'Heard this today about {E}. {S}', 'Small update on {E}: {S}'];

export type ArmId =
  | 'gbrain-edit-sync' | 'gbrain-forget-remember' | 'gbrain-remember-replaces' | 'gbrain-append'
  | 'comparator-edit-invalidate' | 'comparator-reretain' | 'comparator-append';

export type CorrectionStep =
  | { op: 'edit_document'; document: 'edited_document' }
  | { op: 'sync' }
  | { op: 'locate'; match: 'old_value' }
  | { op: 'forget_located' }
  | { op: 'remember'; text: 'corrected_statement'; replaces?: 'located' }
  | { op: 'edit_or_invalidate_located'; text: 'corrected_statement' }
  | { op: 'retain_document'; document: 'edited_document' }
  | { op: 'append_document'; document: 'correction_document' };

export interface CorrectionArm {
  id: ArmId;
  system: 'gbrain' | 'comparator';
  path: 'native' | 'append';
  /** Optional arms run only when `requires` holds at the measured build. */
  optional: boolean;
  requires: string | null;
  steps: CorrectionStep[];
  description: string;
}

export const CORRECTION_ARMS: readonly CorrectionArm[] = [
  {
    id: 'gbrain-edit-sync', system: 'gbrain', path: 'native', optional: false, requires: null,
    steps: [{ op: 'edit_document', document: 'edited_document' }, { op: 'sync' }],
    description: 'Rewrite the target conversation page with the corrected value (same slug), then run sync so derived rows follow the page.',
  },
  {
    id: 'gbrain-forget-remember', system: 'gbrain', path: 'native', optional: false, requires: null,
    steps: [{ op: 'locate', match: 'old_value' }, { op: 'forget_located' }, { op: 'remember', text: 'corrected_statement' }],
    description: 'Find facts about the entity whose text holds the old value (recall), forget each by fact id, then remember the corrected statement with entity and provenance. In the raw lane there may be no fact to forget; the receipt records how many were found.',
  },
  {
    id: 'gbrain-remember-replaces', system: 'gbrain', path: 'native', optional: true,
    requires: 'the remember operation accepts a `replaces` parameter at the measured gbrain SHA; otherwise the arm is reported as not run',
    steps: [{ op: 'locate', match: 'old_value' }, { op: 'remember', text: 'corrected_statement', replaces: 'located' }],
    description: 'Remember the corrected statement naming the located fact it replaces.',
  },
  {
    id: 'gbrain-append', system: 'gbrain', path: 'append', optional: false, requires: null,
    steps: [{ op: 'append_document', document: 'correction_document' }],
    description: 'Ingest the correction message as a new conversation, the same bytes the comparator receives.',
  },
  {
    id: 'comparator-edit-invalidate', system: 'comparator', path: 'native', optional: false, requires: null,
    steps: [{ op: 'locate', match: 'old_value' }, { op: 'edit_or_invalidate_located', text: 'corrected_statement' }],
    description: "Find the comparator's memories whose text holds the old value; edit each to the corrected statement where the server supports edits, otherwise invalidate it and retain the corrected statement. The receipt records which operation ran.",
  },
  {
    id: 'comparator-reretain', system: 'comparator', path: 'native', optional: false, requires: null,
    steps: [{ op: 'retain_document', document: 'edited_document' }],
    description: 'Re-retain the edited conversation under its original document id so the server replaces what it derived from the old version.',
  },
  {
    id: 'comparator-append', system: 'comparator', path: 'append', optional: false, requires: null,
    steps: [{ op: 'append_document', document: 'correction_document' }],
    description: 'Retain the correction message as a new document, the same bytes gbrain receives.',
  },
];

export interface CorrectionItem {
  item_id: string;
  unit: string;
  entity: string;
  entity_kind: EntityKind;
  attribute: string;
  old_value: string;
  new_value: string;
  target_doc_id: string;
  base_doc_ids: string[];
  /** The target conversation with the old value replaced by the new one; same id. */
  edited_document: HarnessDocument;
  /** The appended correction message. */
  correction_document: HarnessDocument;
  corrected_statement: string;
  stale_statement: string;
  /** Text a locate step searches for, plus the value a located record must contain. */
  locate: { query: string; entity: string; old_value: string };
  correction_timestamp: string;
}

export interface UnrelatedWrite { item_id: string; index: number; kind: 'same-entity-other-detail' | 'other-entity-news' | 'small-talk'; document: HarnessDocument }

export type ScheduleOp =
  | { unit: string; seq: number; op: 'ingest'; doc_ids: string[] }
  | { unit: string; seq: number; op: 'probe'; query_id: string; checkpoint: Checkpoint }
  | { unit: string; seq: number; op: 'correct'; item_id: string }
  | { unit: string; seq: number; op: 'write'; item_id: string; index: number; doc_id: string };

export interface CorrectionSpec { entity: string; attribute: string; checkpoint: Checkpoint }

function familyPools(): Map<string, string[]> {
  const world = worldTextLower();
  return new Map(ATTRIBUTE_FAMILIES.map(f => [f.id, f.pool.filter(v => !` ${norm(world)} `.includes(` ${norm(v)} `))]));
}

export function generateCorrections(opts: { seed?: number; smoke?: boolean; items?: number } = {}): SuiteBundle {
  const seed = opts.seed ?? CORRECTIONS_SEED;
  const smoke = opts.smoke ?? false;
  const nItems = opts.items ?? (smoke ? CORRECTIONS_SIZES.smoke.items : CORRECTIONS_SIZES.full.items);
  const rng = new Rng(seed);
  const pools = familyPools();
  const pages = worldPages();
  const byKind: Record<EntityKind, RichPage[]> = {
    company: pages.filter(p => p._facts.type === 'company' && (p._facts as { category?: string }).category === 'startup'),
    person: pages.filter(p => p._facts.type === 'person'),
  };
  const companyTargets = rng.shuffle(byKind.company).slice(0, Math.ceil(nItems / 2));
  const personTargets = rng.shuffle(byKind.person).slice(0, Math.floor(nItems / 2));
  const targets: Array<{ page: RichPage; kind: EntityKind }> = [];
  for (let i = 0; i < Math.max(companyTargets.length, personTargets.length); i++) {
    if (companyTargets[i]) targets.push({ page: companyTargets[i]!, kind: 'company' });
    if (personTargets[i]) targets.push({ page: personTargets[i]!, kind: 'person' });
  }
  if (targets.length < nItems) throw new Error(`corrections: only ${targets.length} distinct targets for ${nItems} items`);

  const documents: HarnessDocument[] = [];
  const queries: HarnessQuery[] = [];
  const labels: ScorerLabel[] = [];
  const items: CorrectionItem[] = [];
  const writes: UnrelatedWrite[] = [];
  const schedule: ScheduleOp[] = [];

  targets.slice(0, nItems).forEach(({ page: target, kind }, n) => {
    const unit = opaqueId('cru', seed, n);
    const itemId = opaqueId('cri', seed, n);
    const families = ATTRIBUTE_FAMILIES.filter(f => f.kind === kind);
    const family = rng.pick(families);
    const others = rng.shuffle(byKind[kind].filter(p => p.slug !== target.slug)).slice(0, 3);
    const unitPages = rng.shuffle([target, ...others]);
    const used = new Set<string>();
    const draw = (fam: AttributeFamily) => {
      const pool = pools.get(fam.id)!.filter(v => !used.has(v));
      if (!pool.length) throw new Error(`corrections seed ${seed}: pool ${fam.id} exhausted in unit ${n}`);
      const v = rng.pick(pool);
      used.add(v);
      return v;
    };
    const values = new Map(unitPages.map(p => [p.slug, draw(family)]));
    const newValue = draw(family);
    const oldValue = values.get(target.slug)!;
    let day = `2025-${String(rng.int(4, 8)).padStart(2, '0')}-${String(rng.int(1, 20)).padStart(2, '0')}`;
    const baseIds: string[] = [];
    let targetDoc: HarnessDocument | null = null;
    for (const p of unitPages) {
      const statement = fill(family.statement, { E: p.title, V: values.get(p.slug)! });
      const { messages } = worldPageConversation(p, rng, { asides: [`By the way, ${statement}`] });
      const doc = makeDocument(opaqueId('crd', seed, n, p.slug), unit, isoAt(day, rng.int(8 * 60, 20 * 60)), messages);
      documents.push(doc);
      baseIds.push(doc.id);
      if (p.slug === target.slug) targetDoc = doc;
      day = addDays(day, 1);
    }
    const tgt = targetDoc!;
    const staleStatement = fill(family.statement, { E: target.title, V: oldValue });
    const correctedStatement = capitalize(fill(family.statement, { E: target.title, V: newValue }));
    if (countValue(tgt.content, oldValue) !== 1) throw new Error(`corrections seed ${seed} unit ${n}: old value "${oldValue}" is not stated exactly once in the target conversation`);
    const editedMessages = tgt.messages.map(m => ({ role: m.role, content: m.content.split(staleStatement).join(fill(family.statement, { E: target.title, V: newValue })) }));
    const edited = makeDocument(tgt.id, unit, tgt.timestamp, editedMessages);
    if (edited.content === tgt.content) throw new Error(`corrections seed ${seed} unit ${n}: edit did not change the target conversation`);

    const correctionTs = isoAt(addDays(day, 1), rng.int(8 * 60, 20 * 60));
    const correctionText = fill(rng.pick(CORRECTION_FRAMES), { E: target.title, N: family.noun, OLD: oldValue, NEW: correctedStatement });
    const correctionDoc = makeDocument(opaqueId('crc', seed, n), unit, correctionTs, [
      { role: 'user', content: correctionText },
      { role: 'assistant', content: 'Thanks for the correction, I have updated that.' },
    ]);
    items.push({
      item_id: itemId, unit, entity: target.title, entity_kind: kind, attribute: family.id,
      old_value: oldValue, new_value: newValue, target_doc_id: tgt.id, base_doc_ids: baseIds,
      edited_document: edited, correction_document: correctionDoc,
      corrected_statement: correctedStatement, stale_statement: capitalize(staleStatement),
      locate: { query: `${target.title} ${family.noun}`, entity: target.title, old_value: oldValue },
      correction_timestamp: correctionTs,
    });

    // Five unrelated writes after the correction.
    const kinds = rng.shuffle(['same-entity-other-detail', 'same-entity-other-detail', 'other-entity-news', 'other-entity-news', 'small-talk'] as const);
    let wday = addDays(correctionTs.slice(0, 10), 1);
    const writeIds: string[] = [];
    const sameEntityFamilies = rng.shuffle(families.filter(f => f.id !== family.id));
    kinds.forEach((k, i) => {
      let messages;
      if (k === 'small-talk') messages = fillerSession(rng, rng.int(3, 5));
      else {
        const subject = k === 'same-entity-other-detail' ? target : rng.pick(others);
        const fam = k === 'same-entity-other-detail' ? sameEntityFamilies.shift()! : rng.pick(families.filter(f => f.id !== family.id));
        const s = capitalize(fill(fam.statement, { E: subject.title, V: draw(fam) }));
        messages = [
          { role: 'user' as const, content: fill(rng.pick(NEWS_FRAMES), { E: subject.title, S: s }) },
          { role: 'assistant' as const, content: 'Good to know, noted.' },
        ];
      }
      const doc = makeDocument(opaqueId('crw', seed, n, i), unit, isoAt(wday, rng.int(8 * 60, 20 * 60)), messages);
      writes.push({ item_id: itemId, index: i + 1, kind: k, document: doc });
      writeIds.push(doc.id);
      wday = addDays(wday, 1);
    });

    const qText = fill(family.question, { E: target.title });
    const probeTs = (afterIso: string) => isoAt(afterIso.slice(0, 10), 23 * 60);
    const probeTimes: Record<Checkpoint, string> = {
      0: probeTs(documents[documents.length - 1]!.timestamp),
      1: probeTs(writes[writes.length - 5]!.document.timestamp),
      5: probeTs(writes[writes.length - 1]!.document.timestamp),
    };
    const qids = {} as Record<Checkpoint, string>;
    for (const cp of CHECKPOINTS) {
      const qid = opaqueId('crq', seed, n, cp);
      qids[cp] = qid;
      const gold = cp === 0 ? { kind: 'value' as const, value: oldValue } : { kind: 'value' as const, value: newValue, stale: [oldValue] };
      queries.push({
        id: qid, query: qText, gold_ids: cp === 0 ? [tgt.id] : [tgt.id, correctionDoc.id], gold_answers: [gold.value], user_id: unit,
        meta: { query_timestamp: probeTimes[cp], category: family.id, checkpoint: cp },
      });
      labels.push({
        query_id: qid, suite: 'corrections', category: family.id,
        spec: { entity: target.title, attribute: family.id, checkpoint: cp } satisfies CorrectionSpec,
        gold,
        oracle_doc_ids: cp === 0 ? [tgt.id] : [tgt.id, correctionDoc.id],
        needles: cp === 0
          ? [{ doc_id: tgt.id, text: staleStatement, value: oldValue }]
          : [{ doc_id: correctionDoc.id, text: correctedStatement, value: newValue }],
        distractors: others.map(o => ({ doc_id: baseIds[unitPages.indexOf(o)]!, value: values.get(o.slug)!, kind: 'other-entity-same-detail' })),
        negative: false,
      });
    }
    let seq = 0;
    schedule.push({ unit, seq: seq++, op: 'ingest', doc_ids: baseIds });
    schedule.push({ unit, seq: seq++, op: 'probe', query_id: qids[0], checkpoint: 0 });
    schedule.push({ unit, seq: seq++, op: 'correct', item_id: itemId });
    writeIds.forEach((id, i) => {
      schedule.push({ unit, seq: seq++, op: 'write', item_id: itemId, index: i + 1, doc_id: id });
      if (i === 0) schedule.push({ unit, seq: seq++, op: 'probe', query_id: qids[1], checkpoint: 1 });
    });
    schedule.push({ unit, seq: seq++, op: 'probe', query_id: qids[5], checkpoint: 5 });
  });

  return {
    suite: 'corrections', version: CORRECTIONS_VERSION, seed, smoke,
    documents, queries, labels,
    extra: { corrections: items, writes, schedule, arms: { arms: CORRECTION_ARMS, checkpoints: CHECKPOINTS } },
    timestamp_provenance: 'observed_session_time: base conversations, the correction and each unrelated write carry the time they were sent; probes carry query_timestamp after the write they follow.',
  };
}

/** Offline reader: the latest dated statement of the asked detail wins. */
export function correctionStubAnswer(label: ScorerLabel, context: string): string {
  const spec = label.spec as unknown as CorrectionSpec;
  const family = ATTRIBUTE_FAMILIES.find(f => f.id === spec.attribute)!;
  let last: string | null = null;
  for (const block of contextBlocks(context).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) {
    for (const m of block.text.matchAll(statementRegex(family.statement, { E: spec.entity }))) last = m[1]!.trim();
  }
  return last ?? STUB_ABSTAIN;
}

export function scoreCorrection(label: ScorerLabel, answer: string): ScoreResult {
  return scoreGold(label.gold, answer, label.distractors.map(d => d.value));
}

export const corrections: SuiteDefinition = {
  id: 'corrections',
  version: CORRECTIONS_VERSION,
  defaultSeed: CORRECTIONS_SEED,
  describe: 'B2: seeded corrections over world-v1 entities, probed after 1 and 5 unrelated writes.',
  generate: ({ seed, smoke }) => generateCorrections({ seed, smoke }),
  stubAnswer: correctionStubAnswer,
  score: scoreCorrection,
};

// ─── Adapter interface and schedule driver ────────────────────────────────

export interface StepReceipt { item_id: string; arm: ArmId; op: CorrectionStep['op']; ok: boolean; located?: number; detail?: string }

export interface ProbeReceipt {
  item_id: string;
  query_id: string;
  checkpoint: Checkpoint;
  context: string;
  answer: string;
  outcome: ScoreResult['outcome'];
}

export interface InspectReceipt { item_id: string; history_visible: boolean; detail: string }

/**
 * One system's side of B2. The harness lane implements it for gbrain (MCP:
 * put_pages, sync, recall/forget/remember, query) and for the comparator
 * (its retain, recall, edit/invalidate operations). `step` executes one arm
 * step for one item; `retrieve` returns the exact context the reader sees.
 */
export interface CorrectionAdapter {
  readonly system: 'gbrain' | 'comparator' | string;
  supports(arm: CorrectionArm): { ok: true } | { ok: false; reason: string };
  ingest(unit: string, docs: readonly HarnessDocument[]): Promise<void>;
  write(unit: string, doc: HarnessDocument): Promise<void>;
  step(unit: string, arm: CorrectionArm, step: CorrectionStep, item: CorrectionItem): Promise<StepReceipt>;
  retrieve(unit: string, query: HarnessQuery): Promise<{ context: string }>;
  inspect?(unit: string, item: CorrectionItem): Promise<InspectReceipt>;
}

export type Reader = (label: ScorerLabel, query: HarnessQuery, context: string) => Promise<string>;

export interface ArmResult {
  arm: ArmId;
  system: string;
  status: 'ran' | 'not_run';
  reason?: string;
  steps: StepReceipt[];
  probes: ProbeReceipt[];
  inspect: InspectReceipt[];
  metrics: CorrectionMetrics | null;
}

export interface CheckpointMetrics { n: number; correct: number; stale: number; ambiguous: number; other: number; rate_correct: number; rate_stale: number }
export interface CorrectionMetrics {
  pre_correction_recall: CheckpointMetrics;
  after_1_write: CheckpointMetrics;
  after_5_writes: CheckpointMetrics;
}

function checkpointMetrics(probes: readonly ProbeReceipt[]): CheckpointMetrics {
  const n = probes.length;
  const count = (o: string) => probes.filter(p => p.outcome === o).length;
  const correct = count('correct');
  const stale = count('stale');
  const ambiguous = count('ambiguous');
  return { n, correct, stale, ambiguous, other: n - correct - stale - ambiguous, rate_correct: n ? correct / n : 0, rate_stale: n ? stale / n : 0 };
}

export function correctionMetrics(probes: readonly ProbeReceipt[]): CorrectionMetrics {
  return {
    pre_correction_recall: checkpointMetrics(probes.filter(p => p.checkpoint === 0)),
    after_1_write: checkpointMetrics(probes.filter(p => p.checkpoint === 1)),
    after_5_writes: checkpointMetrics(probes.filter(p => p.checkpoint === 5)),
  };
}

/** Run one arm over the whole schedule, unit by unit, in schedule order. */
export async function runCorrectionArm(adapter: CorrectionAdapter, arm: CorrectionArm, bundle: SuiteBundle, reader: Reader): Promise<ArmResult> {
  const support = adapter.supports(arm);
  if (!support.ok) return { arm: arm.id, system: adapter.system, status: 'not_run', reason: support.reason, steps: [], probes: [], inspect: [], metrics: null };
  const docs = new Map(bundle.documents.map(d => [d.id, d]));
  const items = new Map((bundle.extra.corrections as CorrectionItem[]).map(i => [i.item_id, i]));
  const writeDocs = new Map((bundle.extra.writes as UnrelatedWrite[]).map(w => [w.document.id, w.document]));
  const queries = new Map(bundle.queries.map(q => [q.id, q]));
  const labels = new Map(bundle.labels.map(l => [l.query_id, l]));
  const steps: StepReceipt[] = [];
  const probes: ProbeReceipt[] = [];
  const inspect: InspectReceipt[] = [];
  const itemOfUnit = new Map([...items.values()].map(i => [i.unit, i]));
  for (const op of bundle.extra.schedule as ScheduleOp[]) {
    const item = itemOfUnit.get(op.unit)!;
    if (op.op === 'ingest') await adapter.ingest(op.unit, op.doc_ids.map(id => docs.get(id)!));
    else if (op.op === 'write') await adapter.write(op.unit, writeDocs.get(op.doc_id)!);
    else if (op.op === 'correct') {
      for (const s of arm.steps) steps.push(await adapter.step(op.unit, arm, s, item));
      if (adapter.inspect) inspect.push(await adapter.inspect(op.unit, item));
    } else {
      const query = queries.get(op.query_id)!;
      const label = labels.get(op.query_id)!;
      const { context } = await adapter.retrieve(op.unit, query);
      const answer = await reader(label, query, context);
      probes.push({ item_id: item.item_id, query_id: op.query_id, checkpoint: op.checkpoint, context, answer, outcome: scoreCorrection(label, answer).outcome });
    }
  }
  return { arm: arm.id, system: adapter.system, status: 'ran', steps, probes, inspect, metrics: correctionMetrics(probes) };
}

/**
 * Reference memory for the offline checks: keeps every document and
 * remembered statement per unit and returns all of them as context. It
 * implements every step literally (edit replaces the document, append adds
 * one, locate finds stored statements holding the old value). `mode`
 * produces the negative controls: `no-memory` returns an empty context,
 * `ignore-corrections` skips every correction step.
 */
export class ReferenceCorrectionMemory implements CorrectionAdapter {
  readonly system: string;
  #docs = new Map<string, Map<string, HarnessDocument>>();
  #facts = new Map<string, Array<{ id: string; text: string; timestamp: string; expired: boolean }>>();
  #located = new Map<string, string[]>();
  constructor(readonly mode: 'faithful' | 'no-memory' | 'ignore-corrections' = 'faithful', system = 'reference') { this.system = system; }
  supports(): { ok: true } { return { ok: true }; }
  async ingest(unit: string, docs: readonly HarnessDocument[]) { for (const d of docs) await this.write(unit, d); }
  async write(unit: string, doc: HarnessDocument) {
    if (!this.#docs.has(unit)) this.#docs.set(unit, new Map());
    this.#docs.get(unit)!.set(doc.id, doc);
  }
  async step(unit: string, arm: CorrectionArm, step: CorrectionStep, item: CorrectionItem): Promise<StepReceipt> {
    const base = { item_id: item.item_id, arm: arm.id, op: step.op };
    if (this.mode === 'ignore-corrections') return { ...base, ok: true, detail: 'ignored (negative control)' };
    const facts = this.#facts.get(unit) ?? [];
    this.#facts.set(unit, facts);
    switch (step.op) {
      case 'edit_document':
      case 'retain_document':
        await this.write(unit, item.edited_document);
        return { ...base, ok: true };
      case 'append_document':
        await this.write(unit, item.correction_document);
        return { ...base, ok: true };
      case 'sync':
        return { ...base, ok: true };
      case 'locate': {
        const hits = facts.filter(f => !f.expired && countValue(f.text, item.locate.old_value) > 0).map(f => f.id);
        this.#located.set(item.item_id, hits);
        return { ...base, ok: true, located: hits.length };
      }
      case 'forget_located':
        for (const f of facts) if ((this.#located.get(item.item_id) ?? []).includes(f.id)) f.expired = true;
        return { ...base, ok: true };
      case 'remember':
      case 'edit_or_invalidate_located':
        for (const f of facts) if ((this.#located.get(item.item_id) ?? []).includes(f.id)) f.expired = true;
        facts.push({ id: `${item.item_id}#${facts.length}`, text: item.corrected_statement, timestamp: item.correction_timestamp, expired: false });
        return { ...base, ok: true };
    }
  }
  async retrieve(unit: string): Promise<{ context: string }> {
    if (this.mode === 'no-memory') return { context: '' };
    const docs = [...(this.#docs.get(unit)?.values() ?? [])];
    const facts = (this.#facts.get(unit) ?? []).filter(f => !f.expired)
      .map(f => makeDocument(f.id, unit, f.timestamp, [{ role: 'user', content: f.text }], 'remembered statement'));
    return { context: renderContext([...docs, ...facts]) };
  }
}
