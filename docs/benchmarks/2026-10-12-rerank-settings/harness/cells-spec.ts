export const CELLS_SPEC = [
  { id: 'ref.50x1400.r25', n: 50, t: 1400, model: 'rerank-2.5' },
  ...['rerank-2.5', 'rerank-2.5-lite'].flatMap(model => [25, 15, 10].flatMap(n => [1400, 768, 512].map(t => ({ id: `${n}x${t}.${model === 'rerank-2.5' ? 'r25' : 'r25lite'}`, n, t, model })))),
];
