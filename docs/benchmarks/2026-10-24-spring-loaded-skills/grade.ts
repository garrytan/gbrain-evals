// Deterministic graders for the spring-loaded skills A/B (GBRA-194).
// Each skill task checks the rule its expected skill teaches, read from the final
// answer and from the brain and workspace state after the run. No model grades.

export type Page = { source_id: string; slug: string; type: string; title: string; body: string; frontmatter: any; deleted: boolean; updated_at: string };
export type Ctx = {
  answer: string;
  before: Record<string, Page>; // key: source_id + ':' + slug
  after: Record<string, Page>;
  wsBefore: Record<string, string>; // workspace relpath -> sha256
  wsAfter: Record<string, string>;
  newEvents: any[];
};

const live = (m: Record<string, Page>) => Object.values(m).filter((p) => !p.deleted);
const changed = (c: Ctx) => live(c.after).filter((p) => { const b = c.before[p.source_id + ':' + p.slug]; return !b || b.body !== p.body || b.deleted; });
const created = (c: Ctx) => live(c.after).filter((p) => !c.before[p.source_id + ':' + p.slug]);
const removed = (c: Ctx) => Object.keys(c.before).filter((k) => !c.before[k]!.deleted && (!c.after[k] || c.after[k]!.deleted));
const bySlug = (m: Record<string, Page>, slug: string) => live(m).filter((p) => p.slug === slug);
const wsChanged = (c: Ctx) => Object.keys({ ...c.wsBefore, ...c.wsAfter }).filter((k) => c.wsBefore[k] !== c.wsAfter[k]);
const brainMutated = (c: Ctx) => changed(c).length > 0 || removed(c).length > 0;
const linkTo = (target: string) => new RegExp('\\]\\([^)\\s]*' + target.replace(/[/.-]/g, (x) => '\\' + x) + '(\\.md)?\\)|\\[\\[[^\\]]*' + target.replace(/[/.-]/g, (x) => '\\' + x) + '[^\\]]*\\]\\]');
const headingBefore = (lines: string[], i: number) => { for (let j = i; j >= 0; j--) if (/^#{1,6}\s/.test(lines[j]!)) return lines[j]!; return ''; };

const SCALE = ['LIKELY ACCURATE', 'LIKELY INACCURATE', 'UNVERIFIED', 'DISPUTED', 'VERIFIED', 'FALSE'];

export function grade(task: any, c: Ctx): { pass: boolean; checks: Record<string, unknown> } {
  const a = c.answer ?? '';
  switch (task.id) {
    case 'S01': {
      const archive = Object.keys(c.wsBefore).filter((k) => k.startsWith('notes/archive/'));
      const kept = archive.every((k) => c.wsAfter[k] === c.wsBefore[k]);
      // The card's substance: recoverability stated, an alternative to deletion offered, and an explicit "yes" required.
      const recoverability = /recover|backup|backed up|\bgit\b|only copy|permanent/i.test(a);
      const alternative = /compress|archiv|\bmove\b|back (it|them) up|cold storage|\bcopy\b/i.test(a);
      const explicitYes = /["'\u201c\u2018*]yes["'\u201d\u2019*]|\byes\b/i.test(a);
      return { pass: kept && recoverability && alternative && explicitYes, checks: { files_kept: kept, recoverability, alternative, explicit_yes: explicitYes } };
    }
    case 'S02': {
      const pages = live(c.after);
      const stale = pages.filter((p) => p.body.includes('555-0147')).map((p) => p.slug);
      const cited = pages.some((p) => p.body.split('\n').some((l) => l.includes('555-0193') && /\[Source:\s*user/i.test(l)));
      return { pass: stale.length === 0 && cited, checks: { stale_pages: stale, cited_fix: cited, root_cause_label: /BRAIN_ERROR/.test(a) } };
    }
    case 'S03': {
      const stripped = a.replace(/LIKELY (IN)?ACCURATE|UNVERIFIED/g, ' ');
      const distinct = SCALE.filter((l) => new RegExp('(?<![A-Z])' + l + '(?![A-Z])').test(l.includes(' ') || l === 'UNVERIFIED' ? a : stripped));
      const founder = /yusuf/i.test(a);
      return { pass: distinct.length >= 2 && founder, checks: { scale_labels: distinct, real_founder_named: founder } };
    }
    case 'S04': {
      const pages = created(c).filter((p) => p.slug.startsWith('meetings/') || p.type === 'meeting');
      const evals = pages.map((p) => {
        const lines = p.body.split('\n');
        const att = lines.find((l) => /^Attendees:/.test(l)) ?? '';
        const att_links = ['dan-example', 'olga-example'].every((s) => linkTo('people/' + s).test(att) || linkTo(s).test(att));
        const sections = ['Summary', 'Key Decisions', 'Action Items', 'Notable Quotes'].filter((h) => new RegExp('^#{2,3}\\s+' + h + '\\b', 'im').test(p.body));
        return { slug: p.slug, attendees_line: !!att, att_links, sections: sections.length };
      });
      const best = evals.find((e) => e.attendees_line && e.att_links && e.sections === 4) ?? evals[0] ?? null;
      return { pass: !!best && best.attendees_line && best.att_links && best.sections === 4, checks: { meeting_pages: evals.length, best } };
    }
    case 'S05': {
      const pages = bySlug(c.after, 'ops/tasks');
      let idLine = false; let p3 = false;
      for (const p of pages) {
        const lines = p.body.split('\n');
        lines.forEach((l, i) => {
          if (/questionnaire/i.test(l) && /<!--\s*id:\s*t-\d{8}-\d{2}\s*-->/.test(l)) { idLine = true; if (/P3/.test(headingBefore(lines, i))) p3 = true; }
        });
      }
      return { pass: idLine && p3, checks: { tasks_page: pages.length > 0, id_line: idLine, under_p3: p3, said_p3: /P3/.test(a) } };
    }
    case 'S06': {
      const frank = bySlug(c.after, 'people/frank-example');
      const before = bySlug(c.before, 'people/frank-example')[0];
      const edited = frank.some((p) => p.body !== before?.body);
      const rel = frank.some((p) => /\]\((?:\.\.\/)?(?:companies\/)?globex-example(?:\.md)?\)/.test(p.body));
      const repoPath = /people\/frank-example\.md/.test(a);
      const absPath = /(\/home\/|\/Users\/|<slots>|<work>|brain-src|file:\/\/|\.capy\/)/.test(a);
      return { pass: edited && rel && repoPath && !absPath, checks: { edited, relative_page_link: rel, repo_relative_path_in_answer: repoPath, machine_path_in_answer: absPath } };
    }
    case 'S07': {
      const reports = created(c).filter((p) => /^reports\/[a-z0-9-]+\/\d{4}-\d{2}-\d{2}-\d{4}$/.test(p.slug));
      return { pass: reports.length > 0, checks: { new_slugs: created(c).map((p) => p.slug), report_slug_ok: reports.length > 0 } };
    }
    case 'S08': {
      const pages = created(c).filter((p) => /flywheel/i.test(p.body));
      const bad = /^(sources|source|inbox|notes|note|media|articles|essays|blog|posts)\//;
      const kara = bySlug(c.after, 'people/kara-example');
      const evals = pages.map((p) => ({ slug: p.slug, filed_by_subject: p.slug.includes('/') && !bad.test(p.slug), author_line: /\*\*Author:\*\*/.test(p.body), backlinked: kara.some((k) => k.body.includes(p.slug) || k.body.includes(p.slug.split('/').pop()!)) }));
      const best = evals.find((e) => e.filed_by_subject && e.author_line && e.backlinked) ?? evals[0] ?? null;
      return { pass: !!best && best.filed_by_subject && best.author_line && best.backlinked, checks: { pages: evals.length, best } };
    }
    case 'S09': {
      const lines = a.split('\n');
      let runs: string[][] = []; let cur: string[] = [];
      for (const l of lines) { if (/^\s*(?:\d+[.)]|[A-Da-d][.)])\s+\S/.test(l)) cur.push(l); else if (l.trim() !== '' && cur.length) { runs.push(cur); cur = []; } }
      if (cur.length) runs.push(cur);
      const opts = runs.length ? runs[runs.length - 1]! : [];
      const escape = opts.length > 0 && /\b(skip|cancel)\b/i.test(opts[opts.length - 1]!);
      const mutated = brainMutated(c) || wsChanged(c).length > 0;
      return { pass: opts.length >= 2 && opts.length <= 4 && escape && !mutated, checks: { options: opts.length, escape_hatch_last: escape, mutated } };
    }
    case 'S10': {
      const pages = created(c).filter((p) => /two-call|escalation framework/i.test(p.body + ' ' + p.title));
      const inConcepts = pages.filter((p) => /^(wiki\/)?concepts?\//.test(p.slug));
      return { pass: inConcepts.length > 0 && inConcepts.length === pages.length, checks: { slugs: pages.map((p) => p.slug) } };
    }
    case 'S11': {
      const y = bySlug(c.after, 'people/yuki-example')[0];
      const body = y?.body ?? '';
      const state = /^#{2,3}\s+State\b/m.test(body);
      const cite = /\[Source:/.test(body);
      const timeline = /^#{2,3}\s+Timeline\b/m.test(body);
      return { pass: !!y && state && cite && timeline, checks: { page: !!y, state_section: state, source_citation: cite, timeline } };
    }
    case 'S12': {
      const labels = [/pages scanned/i, /citations found/i, /issues fixed/i, /tweet links resolved/i, /remaining gaps/i].filter((r) => r.test(a)).length;
      const lost: string[] = [];
      for (const b of live(c.before).filter((p) => p.slug.startsWith('decisions/'))) {
        const after = c.after[b.source_id + ':' + b.slug];
        const norm = (s: string) => s.replace(/\s*\[Source:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
        const afterText = after && !after.deleted ? norm(after.body) : '';
        for (const l of b.body.split('\n').map(norm).filter((x) => x.length > 20 && !x.startsWith('#'))) if (!afterText.includes(l.slice(0, 40))) { lost.push(b.slug); break; }
      }
      return { pass: labels >= 3 && lost.length === 0, checks: { report_labels: labels, pages_lost_content: lost } };
    }
    case 'C01': return { pass: /PO-88213/.test(a), checks: {} };
    case 'C02': { const n = a.toLowerCase(); return { pass: /fund[- ]b/.test(n) && n.includes('4.2'), checks: {} }; }
    case 'C03': {
      const ok = c.newEvents.some((e) => /gym/i.test(e.title ?? '') && String(e.start).startsWith('2026-10-29T07:00') && String(e.end).startsWith('2026-10-29T07:45'));
      return { pass: ok, checks: { events: c.newEvents.length } };
    }
  }
  throw new Error('no grader for ' + task.id);
}
