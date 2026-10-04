// The wave 8 check C (`2026-10-03-wave8-f1-repin/checks/embed-budget-stop.ts`) with `--yes` on every embed call.
// gbrain #5991 makes an explicit embedding backfill without a terminal stop with exit 3 and a consent payload unless
// --yes, --max-usd or a preapproval covers it (CHANGELOG v0.60.46.0, behavior changes table), so the original check now
// stops at the consent step. This variant shows the time-budget stop itself still works once the run is approved.
// Added after the regression run found the change; not preregistered. Exit 0 when every expectation of check C holds.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider } from '../../2026-10-03-wave8-f1-repin/checks/fake-provider.ts';
import { finish, gbrain, keylessHome } from '../../2026-10-03-wave8-f1-repin/checks/lib.ts';

const fake = startFakeProvider({ dims: 8 });
const h = keylessHome({ LITELLM_BASE_URL: fake.url, LITELLM_API_KEY: 'fake-local-key' });
const init = await gbrain(['init', '--pglite', '--non-interactive', '--embedding-model', 'litellm:fake-embed', '--embedding-dimensions', '8', '--skip-embed-check'], h.env);
const dir = mkdtempSync(join(tmpdir(), 'w8f1-embed-'));
for (let i = 1; i <= 20; i++) writeFileSync(join(dir, `embed-note-${i}.md`), `---\ntitle: Embed note ${i}\n---\nExample note ${i} about the example river and the example bridge.\n`);
const imported = await gbrain(['import', dir, '--no-embed'], h.env);

const callsBefore = fake.embedCalls;
const stopped = await gbrain(['embed', '--stale', '--yes'], { ...h.env, GBRAIN_EMBED_TIME_BUDGET_MS: '1' });
const stoppedCalls = fake.embedCalls - callsBefore;
const remaining = Number(/with (\d+) stale chunk\(s\) left/.exec(stopped.stdout)?.[1] ?? NaN);
const resumed = await gbrain(['embed', '--stale', '--catch-up', '--yes'], h.env);
const again = await gbrain(['embed', '--stale', '--yes'], { ...h.env, GBRAIN_EMBED_TIME_BUDGET_MS: '1' });
fake.stop();

finish('embed-budget-stop-consented', {
  setup_ok: init.code === 0 && imported.code === 0,
  C1_budget_stop_exits_11: stopped.code === 11,
  C2_stdout_names_reason_remaining_and_resume: stopped.stdout.includes('stopped (reason: time_budget)') && remaining > 0
    && stopped.stdout.includes('gbrain embed --stale --catch-up'),
  C3_resume_command_finishes: resumed.code === 0 && fake.embedCalls > callsBefore + stoppedCalls,
  C4_drained_brain_with_same_budget_exits_0: again.code === 0 && !again.stdout.includes('reason: time_budget'),
}, {
  stopped: { code: stopped.code, stdout: stopped.stdout.slice(-1500), stderr: stopped.stderr.slice(-800), embed_calls: stoppedCalls, remaining },
  resumed: { code: resumed.code, stdout: resumed.stdout.slice(-600) },
  again: { code: again.code, stdout: again.stdout.slice(-600) },
  embed_calls_total: fake.embedCalls,
});
