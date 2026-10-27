/**
 * Cat 40 next-wave development rounds: the preregistered arm table (plan
 * docs/plans/2026-10-11-cat40-next-wave/PLAN.md, "Development and confirmation").
 *
 * Every arm runs the gbrain arm only, on World M, on the one wave build. Each
 * arm sets every wave key explicitly (the control at its baseline value, the
 * arm's own item at its wave value), so config readback after restore checks
 * the whole recipe. F5 (`mentions.owner_phrases`) acts only when the mention
 * pass runs, so it selects the slot family (`--gbrain-build-config`) instead of
 * a restore-time key. Prices are per gbrain arm on M at the 1.108 ledger rate;
 * each arm's `--budget-usd` cap is 1.15 times its price, rounded down to the cent.
 *
 *   bun eval/runner/cat40/dev-arms.ts --round 1|2|3 [--json]
 *
 * Round 3 is one diagnostic arm added after the d1b gate failed (owner decision 2026-10-13): the confirmation's wave
 * config, all-on with F5 off, on F5-off slots of the Part 1 head with F5's commits removed.
 */

export const CAP_FACTOR = 1.15;
/** Per gbrain arm on World M, all-in (agent, gbrain service, judge) at the 1.108 ledger rate. */
export const DEV_PRICES_USD = { full: 198.43, 'H2-H4': 107.89 } as const;
export type DevScope = keyof typeof DEV_PRICES_USD;
export type SlotFamily = 'f5-off' | 'f5-on';

/**
 * `entity.record_types` for World M: the page types of executed contracts and their amendments
 * (`type: contract`, `type: amendment` in each rendered page's frontmatter; every `contracts/` page is one of them).
 */
export const M_RECORD_TYPES = 'contract,amendment';

/**
 * Every restore-time wave key at its baseline value: names rows off, no records, no `page_status` on rows, chunk
 * delivery, the earlier instruction sentence. F3 (`entity.row_page_status`) has no paid arm (config-only worlds carry
 * no `status`), so it is on only in all-on. The confirmation baseline arm (the merge base) has none of these keys and
 * receives none.
 */
export const CONTROL_CONFIG: Readonly<Record<string, string>> = Object.freeze({
  'entity.names_references': 'false',
  'entity.record_types': '',
  'entity.row_page_status': 'false',
  'search.long_page_unit': 'off',
  'search.long_page_min_chars': '20000',
  'mcp.instructions_governing_rule': 'newest',
});

const F1 = { 'entity.names_references': 'true', 'entity.record_types': M_RECORD_TYPES };
const F2 = { 'search.long_page_unit': 'section' };
const F3 = { 'entity.row_page_status': 'true' };
const F4 = { 'mcp.instructions_governing_rule': 'in_effect' };

export interface DevArm { id: string; item: string; scope: DevScope; slots: SlotFamily; config: Record<string, string> }

const arm = (id: string, item: string, scope: DevScope, slots: SlotFamily, on: Record<string, string> = {}): DevArm =>
  ({ id, item, scope, slots, config: { ...CONTROL_CONFIG, ...on } });

const ALL_ON = { ...F1, ...F2, ...F3, ...F4 };

const FULL_FAMILY_ARMS = [
  arm('control', 'all-off control', 'full', 'f5-off'),
  arm('all-on', 'all-on (preregistered wave config)', 'full', 'f5-on', ALL_ON),
  arm('f5', 'F5 owner-phrase only', 'full', 'f5-on'),
];

export type DevRound = 1 | 2 | 3;

export const DEV_ROUNDS: Record<DevRound, DevArm[]> = {
  1: [
    ...FULL_FAMILY_ARMS,
    arm('f1', 'F1 only (enrollment, names-row key on)', 'H2-H4', 'f5-off', F1),
    arm('f1-no-names-row', 'F1 with the names-row key off', 'H2-H4', 'f5-off', { ...F1, 'entity.names_references': 'false' }),
    arm('f2', 'F2 only (section)', 'H2-H4', 'f5-off', F2),
    arm('f4', 'F4 only', 'H2-H4', 'f5-off', F4),
  ],
  2: FULL_FAMILY_ARMS,
  3: [arm('all-on-no-f5', 'all-on with F5 off (the confirmation wave config)', 'full', 'f5-off', ALL_ON)],
};

/** The slot family's build-time config. */
export const SLOT_BUILD_CONFIG: Record<SlotFamily, Record<string, string>> = { 'f5-off': {}, 'f5-on': { 'mentions.owner_phrases': 'true' } };

export const priceUsd = (a: DevArm) => DEV_PRICES_USD[a.scope];
export const capUsd = (a: DevArm) => Math.floor(priceUsd(a) * CAP_FACTOR * 100 + 1e-6) / 100;

const pairs = (c: Record<string, string>) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(',');

/** The arm's flags for cat40-model-ladder.ts (the world, models, build, ledger and --out come from the step). */
export function devArmFlags(round: DevRound, a: DevArm): string[] {
  const build = SLOT_BUILD_CONFIG[a.slots];
  return [
    '--gbrain-label', `gbrain-dev-r${round}-${a.id}`,
    '--gbrain-config', pairs(a.config),
    ...(Object.keys(build).length ? ['--gbrain-build-config', pairs(build)] : []),
    ...(a.scope === 'H2-H4' ? ['--families', 'H2,H3,H4'] : []),
    '--budget-usd', capUsd(a).toFixed(2),
  ];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const round = Number(argv[argv.indexOf('--round') + 1]);
  if (round !== 1 && round !== 2 && round !== 3) { console.error('usage: bun eval/runner/cat40/dev-arms.ts --round 1|2|3 [--json]'); process.exit(2); }
  const arms = DEV_ROUNDS[round as DevRound];
  const rows = arms.map(a => ({ arm: a.id, item: a.item, scope: a.scope, slots: a.slots, price_usd: priceUsd(a), cap_usd: capUsd(a), flags: devArmFlags(round as DevRound, a) }));
  if (argv.includes('--json')) { console.log(JSON.stringify({ round, cap_factor: CAP_FACTOR, total_price_usd: Math.round(rows.reduce((n, r) => n + r.price_usd, 0) * 100) / 100, arms: rows }, null, 2)); process.exit(0); }
  for (const r of rows) console.log(`${r.arm.padEnd(16)} ${r.scope.padEnd(6)} ${r.slots.padEnd(7)} $${r.price_usd.toFixed(2).padStart(7)} cap $${r.cap_usd.toFixed(2).padStart(7)}  ${r.flags.join(' ')}`);
  console.log(`total $${rows.reduce((n, r) => n + r.price_usd, 0).toFixed(2)}`);
}
