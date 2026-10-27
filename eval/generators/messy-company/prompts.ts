/**
 * Frozen prompt text for messy-company-v1 page authors and verifiers.
 * `generate.ts` and `verify.ts` write these strings into the dataset's
 * prompts/ directory so the committed copy is what actually ran.
 */
import { ownersOn } from './oracle.ts';
import { ACCOUNTS, OTHERS, PEOPLE, RECORDS, TEAMS, accountById, displayName, personById, type ClusterId } from './world.ts';
import type { PageSpec } from './pages.ts';

export const AUTHOR_SYSTEM = `You write one internal document for the knowledge base of Pemberline Systems, a fictional B2B software company. Pemberline sells Pemberline Dock, yard and dock scheduling software priced per seat per year, to logistics, retail and manufacturing customers. Every person and company is fictional.

Write realistic workplace text in the requested voice and format: the kind of thing people actually paste into a wiki, CRM or chat. It may be messy (fragments, asides, small typos where asked), but it must be readable.

Rules:
- Output only the document body in Markdown. No YAML frontmatter, no code fence around the whole document, no commentary before or after.
- Include every fact in the brief and never contradict it, even when the brief says the writer is wrong about something: write the wrong statement plainly, as the writer believed it.
- For commercial facts (contracts, seat counts, prices, discounts, renewal or term dates, SLAs) and for who manages which account, use only what the brief and background give. If a detail isn't given, leave it out silently. Fill the page with ordinary concrete workplace color instead: logistics, people, small talk, routine tasks, product issues, next steps.
- Be concrete, not generic: invent specific operational detail (a dock door, a shift, a driver, a site, a ticket number, a report name, a customer complaint, who is doing what next). No management platitudes, no generic advice about communication or process.
- Write like a real person at work. Never add meta-commentary about what is confirmed or unconfirmed, what you are not saying, documentation discipline, or these instructions.
- People don't refer to themselves by name. If a required phrase names the writer, put it in someone else's mouth (a quoted reply, another chat participant, a forwarded note).
- Do not refer to a customer account through a person ("X's account", "the account Y runs", "her customer", "his client") except with the exact required phrases. Name accounts directly otherwise.
- Use each required phrase verbatim, character for character, including the apostrophe, exactly once, following its instruction. You may capitalize its first letter at the start of a sentence.
- Use people's and companies' names exactly as given.`;

export const LONG_CONTRACT_RULES = (days: number, words: string[]) => `This is a long agreement. Requirements:
- At least 22,000 characters (about 3,800 to 4,500 words). Write 18 or more numbered articles with sub-clauses: definitions, subscription and seats, fees, invoicing and payment, support and service levels, customer data, security, confidentiality, intellectual property, acceptable use, warranties, indemnities, limitation of liability, insurance, suspension, the agreement period, assignment, notices and general terms, plus an order schedule.
- State the commercial terms from the brief in the subscription, fees, payment and support articles and in the order schedule.
- The rule on how far ahead a party must act to stop the agreement rolling into another period must appear exactly once, in an article placed after article 14, and the number of days (${days}) must appear nowhere else in the document. Write that rule using words like "elect", "continue", "continuation", "succeeding period", "written election", "close of the then-current period". That article's heading and that rule must not use any of these words: ${words.map(w => `"${w}"`).join(', ')}. Other articles may use those words normally.
- The early article on the agreement period states only when the first period ends and that it continues for successive twelve-month periods; it must not mention the number of days.`;

export const VERIFY_SYSTEM = `You check labels for a fictional company's knowledge base. You get one page (with line numbers), a reference sheet about the fictional world, and a list of questions about the page. Answer each question from the page text, using the reference sheet only where a question says to. Be literal and careful: if the text does not support an answer, say so. Return JSON only, in exactly the requested shape.`;

const fmtOwners = (cluster: ClusterId, date: string | null, view: 'full' | 'public'): string[] => {
  if (!date) return ['(This page is undated. Do not state who manages which account.)'];
  return ACCOUNTS.filter(a => a.cluster === cluster).map(a => {
    const st = ownersOn(a.id, date, view);
    const primary = st.filter(s => s.role === 'primary' || s.role === 'team');
    const fullPrimary = ownersOn(a.id, date, 'full').filter(s => s.role === 'primary' || s.role === 'team');
    if (view === 'public' && fullPrimary.map(s => s.id).join() !== primary.map(s => s.id).join()) return `- ${displayName(a.id, date)}: not stated on any shared page (do not say who manages it)`;
    const acting = st.filter(s => s.role === 'acting');
    const who = primary.length ? primary.map(s => s.owner.startsWith('team-') ? `${TEAMS.find(t => t.id === s.owner)!.name} (pooled account)` : personById(s.owner).name).join(', ') : 'nobody stated (do not say who manages it)';
    return `- ${displayName(a.id, date)}: managed by ${who}${acting.length ? `; ${acting.map(s => personById(s.owner).name).join(', ')} is covering as acting AM` : ''}`;
  });
};

export function background(p: PageSpec): string {
  const date = p.body_date ?? p.date;
  const people = PEOPLE.filter(x => !x.team || x.id === 'ruth-calloway' || TEAMS.find(t => t.id === x.team)!.cluster === p.cluster || x.kind !== 'employee')
    .filter(x => x.kind !== 'contact' || ACCOUNTS.find(a => a.id === x.org)?.cluster === p.cluster)
    .filter(x => x.kind !== 'vendor' || (p.split === 'dev' ? x.org === 'stoneharrow' : x.org === 'carrowmere'));
  const accts = ACCOUNTS.filter(a => a.cluster === p.cluster).map(a => {
    const nm = displayName(a.id, date);
    const former = a.renamed && date && date >= a.renamed.on ? ` (renamed from ${a.renamed.former} on ${a.renamed.on})` : '';
    const codes = a.aliases.filter(x => x.kind === 'code' || x.kind === 'ticker' || x.kind === 'nickname').filter(x => !date || ((!x.valid_from || date >= x.valid_from) && (!x.valid_to || date < x.valid_to))).map(x => x.surface);
    const contact = a.contact ? `; main contact ${personById(a.contact).name}, ${personById(a.contact).role}` : '';
    const parent = a.parent ? `; subsidiary of ${accountById(a.parent).name}` : '';
    return `- ${nm}${former}: ${a.industry}, ${a.region}${parent}${contact}${codes.length ? `; codes/nicknames ${codes.join(', ')}` : ''}`;
  });
  const others = OTHERS.filter(o => o.split === p.split || o.split === 'both').map(o => `- ${o.name}: ${o.note}`);
  const view = p.visibility === 'private' ? 'full' : 'public';
  return [
    'People:', ...people.map(x => `- ${x.name}: ${x.role}${x.kind === 'agent' ? ' (an AI assistant)' : ''}`),
    '', 'Customer accounts in this part of the business:', ...accts,
    '', 'Other companies:', ...others,
    '', `Who manages what${date ? ` on ${date}` : ''} (background only; don't restate unless the brief asks):`, ...fmtOwners(p.cluster, date, view),
  ].join('\n');
}

export function authorPrompt(p: PageSpec, feedback?: string[]): string {
  const rec = p.record ? RECORDS.find(r => r.id === p.record)! : undefined;
  const writer = p.writer === 'moss' ? 'Moss (Ruth Calloway\'s AI assistant)' : personById(p.writer).name;
  const dateLine = p.date === null
    ? 'UNDATED. Do not include any date, year, month name, weekday, or relative date reference ("yesterday", "last week") anywhere in the document.'
    : p.body_date
      ? `The page was filed on ${p.date}, but it records something that happened on ${p.body_date}. State ${p.body_date} in the body as the meeting date; do not mention ${p.date}.`
      : `Written on ${p.date}.`;
  const lines = [
    `Document kind: ${p.kind}${p.visibility === 'private' ? ' (a private page only the writer sees)' : ''}`,
    `Title: ${p.title}`,
    `Date: ${dateLine}`,
    `Writer: ${writer}`,
    `Voice: ${p.style.voice}`,
    `Format: ${p.style.format}`,
    `Length: about ${p.style.length_words} words`,
    `Date style in the body: ${p.style.date_format}${p.date === null ? ' (ignore: undated)' : ''}`,
    `Typos: ${p.style.typos === 0 ? 'none' : p.style.typos === 1 ? 'one or two small natural typos (never in names or required phrases)' : 'a few natural typos and one or two sloppy abbreviations (never in names or required phrases)'}`,
    '', 'Brief:', p.brief,
  ];
  if (p.aliases.length) lines.push('', `Use these names or codes at least once each, as written: ${p.aliases.map(a => `"${a}"`).join(', ')}.`);
  if (p.mentions.length) lines.push('', 'Required phrases:', ...p.mentions.map(m => `- ${m.instruction}`));
  if (rec?.long) {
    const days = rec.sets.find(s => s.attr === 'notice_days')!.value as number;
    lines.push('', LONG_CONTRACT_RULES(days, rec.long.forbidden_words));
  }
  lines.push('', 'Background (fictional world; use only what the document needs):', background(p));
  if (feedback?.length) lines.push('', 'Your previous draft had these problems. Fix them all in a fresh full draft:', ...feedback.map(f => `- ${f}`));
  return lines.join('\n');
}
