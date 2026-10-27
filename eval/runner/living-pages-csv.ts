export function csv(text: string): { operation: string; ok: number }[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[-+|\s]+$/.test(l) && !/^\(\d+ rows?\)$/.test(l));
  const split = (l: string) => l.split(/[,|\t]/).map(c => c.trim()).filter((c, i, a) => !(c === '' && (i === 0 || i === a.length - 1)));
  const header = split(lines[0]).map(h => h.toLowerCase());
  const op = header.indexOf('operation');
  const ok = header.indexOf('ok');
  if (op < 0 || ok < 0) throw new Error('the header must name operation and ok');
  return lines.slice(1).map(split).map(cells => ({ operation: cells[op], ok: Number(cells[ok]) }));
}
