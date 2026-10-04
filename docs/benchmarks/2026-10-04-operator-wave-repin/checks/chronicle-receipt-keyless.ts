// gbrain #5993 (v0.60.45.0): what `auto_chronicle` does on a brain with no chat provider. A meeting write's receipt says
// it is pending for the next cycle; an ordinary note carries no chronicle field; a meeting dated more than 30 days ago is
// skipped as history with a paid backfill fix; the `chronicle` phase refuses to judge without a chat provider instead of
// recording "no events"; with `auto_chronicle false` the write is skipped by choice. No model call is made.
// Exit 0 when every preregistered expectation holds (item E4).
import { finish, gbrain, keylessHome } from '../../2026-10-03-wave8-f1-repin/checks/lib.ts';

const h = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
const settle = await gbrain(['config', 'set', 'chronicle.auto_settle_seconds', '0'], h.env);
const today = new Date();
const day = (offset: number) => new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const meeting = (date: string) => `---\ntitle: Example orchard planning meeting\ntype: meeting\ndate: ${date}\nattendees: [people/alex-example, people/sam-example]\n---\nAlex Example and Sam Example met to plan the example orchard. They decided to plant twelve apple trees and Sam agreed to order the saplings.\n`;
const receipt = async (slug: string, content: string) => {
  const r = await gbrain(['put', slug], h.env, undefined, content);
  try { return { code: r.code, chronicle: JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).chronicle_backstop ?? null }; } catch { return { code: r.code, chronicle: null }; }
};
const recent = await receipt(`meetings/${day(-6)}-orchard`, meeting(day(-6)));
const note = await receipt('notes/orchard-note', '---\ntitle: Orchard note\ntype: note\n---\nThe example orchard opens in spring, and this note is long enough to pass every length check.\n');
const history = await receipt(`meetings/${day(-120)}-orchard`, meeting(day(-120)));
const phaseRun = await gbrain(['dream', '--phase', 'chronicle', '--json'], h.env);
let phase: any = null;
try { phase = JSON.parse(phaseRun.stdout).phases?.[0] ?? null; } catch { /* null */ }
const off = await gbrain(['config', 'set', 'auto_chronicle', 'false'], h.env);
const offWrite = await receipt(`meetings/${day(-5)}-orchard`, meeting(day(-5)));
h.cleanup();
finish('chronicle-receipt-keyless', {
  setup_ok: settle.code === 0 && off.code === 0 && recent.code === 0 && note.code === 0 && history.code === 0 && offWrite.code === 0,
  E4_recent_meeting_pending_next_cycle: recent.chronicle?.pending === 'next_cycle',
  E4_note_has_no_chronicle_field: note.chronicle === null,
  E4_old_meeting_skipped_history_with_paid_backfill_fix: history.chronicle?.skipped === 'history' && Array.isArray(history.chronicle?.fix?.consent) && history.chronicle.fix.consent.includes('paid'),
  E4_phase_without_chat_provider_judges_nothing: phase?.details?.reason === 'no_chat_provider' && phase?.details?.judged === 0 && phase?.details?.no_events === 0,
  E4_auto_chronicle_false_skips_by_choice: offWrite.chronicle?.skipped === 'auto_chronicle_off',
}, { recent, note, history, phase, off_write: offWrite });
