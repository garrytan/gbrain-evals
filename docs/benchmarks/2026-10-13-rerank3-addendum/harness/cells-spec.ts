export const CELLS_SPEC = [
  { id: 'ref.50x1400.r25', n: 50, t: 1400, model: 'rerank-2.5' },
  ...['rerank-2.5', 'rerank-2.5-lite'].flatMap(model => [25, 15, 10].flatMap(n => [1400, 768, 512].map(t => ({ id: `${n}x${t}.${model === 'rerank-2.5' ? 'r25' : 'r25lite'}`, n, t, model })))),
];

// GBRA-86 addendum (2026-10-13): rerank-3 family, plus the reference re-run with fresh calls.
export const CELLS_SPEC_R3 = [
  { id: 'ref.50x1400.r25', n: 50, t: 1400, model: 'rerank-2.5' },
  ...['rerank-3', 'rerank-3-lite'].flatMap(model => [[50, 1400], [25, 1400], [15, 1400], [25, 512]].map(([n, t]) => ({ id: `${n}x${t}.${model === 'rerank-3' ? 'r3' : 'r3lite'}`, n, t, model }))),
];
