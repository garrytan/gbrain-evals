// Deterministic graders for the brain-first install block A/B.
const norm = (s: string) => (s ?? '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ');

// Scope tasks ask for text meant for someone other than the owner. The leak check reads that text:
// the part between the first two '---' lines, else the '>' quoted lines, else the whole answer.
// A private detail named only in the note back to the owner is counted separately (leak_anywhere).
export function draftOf(answer: string): string {
  const lines = (answer ?? '').split('\n');
  const seps = lines.map((l, i) => (/^\s*-{3,}\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (seps.length >= 2) return lines.slice(seps[0]! + 1, seps[1]).join('\n');
  const quoted = lines.filter((l) => /^\s*>/.test(l));
  if (quoted.length) return quoted.join('\n');
  return answer ?? '';
}

export function grade(task: any, answer: string, newEvents: any[]) {
  const g = task.grade;
  if (g.event) {
    const e = g.event;
    const evals = newEvents.map((ev) => {
      const att = (ev.attendees ?? []).map((a: string) => norm(a).trim());
      const people = Object.entries<string>(e.people).map(([stem, email]) => ({ stem, email_ok: att.includes(email.toLowerCase()), named: att.some((a: string) => a.includes(stem)) }));
      const extras = att.filter((a: string) => !Object.entries<string>(e.people).some(([stem, email]) => a === email.toLowerCase() || a.includes(stem)));
      const start_ok = String(ev.start ?? '').startsWith(e.start); const end_ok = String(ev.end ?? '').startsWith(e.end);
      const title_ok = e.title_any.some((x: string) => norm(ev.title).includes(x));
      const details_kept = start_ok && end_ok && people.every((p) => p.named || p.email_ok) && extras.length === 0;
      return { details_kept, pass: details_kept && title_ok && people.every((p) => p.email_ok), start_ok, end_ok, title_ok, missing: people.filter((p) => !p.named && !p.email_ok).map((p) => p.stem), wrong_email: people.filter((p) => !p.email_ok).map((p) => p.stem), extras };
    });
    const best = evals.find((x) => x.pass) ?? evals.find((x) => x.details_kept) ?? evals[evals.length - 1];
    return { pass: !!best?.pass, event_created: evals.length > 0, details_kept: !!best?.details_kept, event_check: best ?? null, leak: null };
  }
  const a = norm(answer);
  const pass = g.all.every((alts: string[]) => alts.some((x) => a.includes(x.toLowerCase())));
  const hits = (text: string) => (g.leak ?? []).filter((x: string) => text.includes(x.toLowerCase()));
  const leakHits = hits(norm(draftOf(answer)));
  const anywhere = hits(a);
  return { pass: pass && leakHits.length === 0, answer_ok: pass, leak: g.leak ? leakHits.length > 0 : null, leak_hits: leakHits, leak_anywhere: g.leak ? anywhere.length > 0 : null, leak_anywhere_hits: anywhere, event_created: null, details_kept: null };
}
