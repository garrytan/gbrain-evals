// Scores the brain's owner_phrase links with the dataset's owner-phrases scorer and gold (DECISION-RULE.md).
import { readFileSync, writeFileSync } from 'node:fs';
const E = `${process.env.HOME}/.capy/work/f5-messy/evals/eval`;
const { scoreOwnerPhrases } = await import(`${E}/runner/messy-company/score-owner-phrases.ts`);
const { loadGold, normText, wilson, formatReport } = await import(`${E}/runner/messy-company/common.ts`);
const ex = JSON.parse(readFileSync(`${process.env.HOME}/.capy/work/f5-messy/brain-export.json`, 'utf8'));
const pages = JSON.parse(readFileSync(`${E}/data/messy-company-v1/plan/pages.json`, 'utf8')) as Array<{ slug: string; split: string; kind: string; accounts: string[] }>;
const acct = new Map(pages.filter(p => p.slug.startsWith('accounts/') && p.accounts?.length === 1).map(p => [p.slug, p.accounts[0]!]));
const splitOf = new Map(pages.map(p => [p.slug, p.split]));
const gold = { dev: loadGold('owner-phrases', 'dev'), heldout: loadGold('owner-phrases', 'heldout') } as Record<string, any[]>;
const allGold = [...gold.dev!.map(g => ({ ...g, split: 'dev' })), ...gold.heldout!.map(g => ({ ...g, split: 'heldout' }))];
const perLink = (ex.trusted as any[]).map(l => {
  const account = acct.get(l.account) ?? null;
  const rows = allGold.filter(g => g.slug === l.doc && normText(g.surface) === normText(l.context));
  const row = rows[0];
  let verdict: string;
  if (!row) verdict = 'wrong: no gold row for doc+phrase';
  else if (!row.should_link) verdict = `wrong: gold should_link=false (reason ${row.reason})`;
  else if (!account || !row.intended_accounts.includes(account)) verdict = `wrong: gold intends ${JSON.stringify(row.intended_accounts)}, link names ${account ?? l.account}`;
  else verdict = 'correct';
  const lineRows = row ? [] : allGold.filter(g => g.slug === l.doc).map(g => ({ id: g.id, surface: g.surface, lines: g.lines, should_link: g.should_link, intended: g.intended_accounts, reason: g.reason }));
  return { doc: l.doc, split: splitOf.get(l.doc), phrase: l.context, account_page: l.account, account, origin: l.origin, gold_id: row?.id ?? null, gold_reason: row?.reason ?? null,
    gold_window_relation: row?.window_relation ?? null, gold_should_link: row?.should_link ?? null, gold_should_link_public: row?.should_link_public ?? null, gold_intended: row?.intended_accounts ?? null,
    adjudication_note: row?.adjudication_note ?? null, verdict, same_doc_gold_rows: lineRows };
});
const correct = perLink.filter(r => r.verdict === 'correct').length, n = perLink.length;
const ci = wilson(correct, n);
const verdict = n >= 22 && ci[0] >= 0.85 ? 'PASS' : `FAIL${n < 22 ? ' (population below 22)' : ''}${ci[0] < 0.85 ? ` (Wilson lower ${ci[0].toFixed(3)} < 0.85)` : ''}`;
const sys = (rows: any[]) => {
  const m = new Map<string, { slug: string; surface: string; accounts: string[] }>();
  for (const l of rows) { const k = `${l.doc}\0${normText(l.context)}`; const e = m.get(k) ?? { slug: l.doc, surface: l.context, accounts: [] }; e.accounts.push(acct.get(l.account) ?? l.account); m.set(k, e); }
  return { links: [...m.values()] };
};
const sysTrusted = sys(ex.trusted), sysRemote = sys(ex.remote);
writeFileSync(`${process.env.HOME}/.capy/work/f5-messy/system-trusted.json`, JSON.stringify(sysTrusted, null, 1));
writeFileSync(`${process.env.HOME}/.capy/work/f5-messy/system-remote.json`, JSON.stringify(sysRemote, null, 1));
const reports: any[] = [];
for (const split of ['dev', 'heldout'] as const) {
  reports.push(scoreOwnerPhrases(split, sysTrusted, 'full'));
  reports.push(scoreOwnerPhrases(split, sysRemote, 'public'));
}
const remoteVisible = new Set((ex.remote as any[]).map(l => `${l.doc}\0${l.account}`));
const privateOnly = allGold.filter(g => g.should_link && !g.should_link_public);
const remoteLeaks = (ex.remote as any[]).filter(l => { const g = allGold.find(r => r.slug === l.doc && normText(r.surface) === normText(l.context)); return g && g.should_link && !g.should_link_public; });
const hiddenFromRemote = perLink.filter(r => !remoteVisible.has(`${r.doc}\0${r.account_page}`)).map(r => ({ doc: r.doc, phrase: r.phrase, gold_should_link_public: r.gold_should_link_public }));
const out = { rule_sha256: readFileSync(`${process.env.HOME}/.capy/work/f5-messy/DECISION-RULE.sha256`, 'utf8').split(' ')[0],
  population: n, sample: n, correct, precision: n ? correct / n : null, wilson95: ci, verdict, per_link: perLink,
  remote: { visible_links: ex.remote.length, private_only_gold_rows: privateOnly.length, remote_links_on_private_only_rows: remoteLeaks.length, hidden_from_remote: hiddenFromRemote },
  scorer_reports: reports };
writeFileSync(`${process.env.HOME}/.capy/work/f5-messy/score.json`, JSON.stringify(out, null, 1));
writeFileSync(`${process.env.HOME}/.capy/work/f5-messy/scorer-reports.txt`, reports.map(formatReport).join('\n\n') + '\n');
console.log(JSON.stringify({ population: n, correct, precision: out.precision, wilson95: ci, verdict, remote: { ...out.remote, hidden_from_remote: hiddenFromRemote.length } }));
for (const r of perLink) console.log(r.verdict, '|', r.doc, '|', r.phrase, '->', r.account_page, '| gold', r.gold_id, r.gold_reason, r.gold_window_relation);
