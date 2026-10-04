// gbrain #5992 (#5918): `gbrain extract-conversation-facts` splits a conversation page on its own
// `conversation_segment_gap_minutes` (an unquoted whole number from 1 to 10080) instead of the 30-minute default, and
// ignores any other value with a warning. Keyless: `--dry-run` reports segmentation without a model call.
// Six messages in three pairs 45 minutes apart: 3 segments on the default gap, 1 on a 60-minute gap.
// Exit 0 when every preregistered expectation holds (item E3).
import { finish, gbrain, keylessHome } from '../../2026-10-03-wave8-f1-repin/checks/lib.ts';

const h = keylessHome();
await gbrain(['init', '--pglite', '--non-interactive', '--no-embedding'], h.env);
const body = (gapLine: string) => `---\ntitle: Example orchard chat\ntype: conversation\ndate: 2026-09-20\n${gapLine}---\n` +
  ['9:00 AM', '9:10 AM', '9:55 AM', '10:05 AM', '10:50 AM', '11:00 AM']
    .map((t, i) => `**${i % 2 ? 'Sam Example' : 'Alex Example'}** (2026-09-20 ${t}): message number ${i + 1} about the example orchard plan`).join('\n') + '\n';
const cases = { default: '', gap60: 'conversation_segment_gap_minutes: 60\n', quoted: 'conversation_segment_gap_minutes: "60"\n', too_large: 'conversation_segment_gap_minutes: 20000\n' } as const;
const observed: Record<string, { put: number; exit: number; segments: number | null; warning: string }> = {};
for (const [name, gap] of Object.entries(cases)) {
  const slug = `example-chat-${name.replace('_', '-')}`;
  const put = await gbrain(['put', slug], h.env, undefined, body(gap));
  const r = await gbrain(['extract-conversation-facts', '--dry-run', '--json', '--slug', slug], h.env);
  let segments: number | null = null;
  try { segments = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))).segments_processed ?? null; } catch { /* null */ }
  observed[name] = { put: put.code, exit: r.code, segments, warning: r.stderr.split('\n').find(l => l.includes('conversation_segment_gap_minutes')) ?? '' };
}
h.cleanup();
const warns = (o: typeof observed[string]) => o.segments === 3 && o.warning.includes('1 to 10080') && o.warning.includes('--slug');
finish('segment-gap-5918', {
  setup_ok: Object.values(observed).every(o => o.put === 0 && o.exit === 0),
  E3_default_gap_three_segments: observed.default.segments === 3 && observed.default.warning === '',
  E3_page_gap_60_one_segment: observed.gap60.segments === 1 && observed.gap60.warning === '',
  E3_quoted_value_ignored_with_warning: warns(observed.quoted),
  E3_out_of_range_ignored_with_warning: warns(observed.too_large),
}, observed);
