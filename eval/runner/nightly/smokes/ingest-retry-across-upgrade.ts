/**
 * ingest-retry-across-upgrade: a POST /ingest capture accepted before an upgrade and retried after it must not write the
 * old body over a newer edit of its page. Real processes throughout, on the seeded brain (PGLite): the previous release's
 * `gbrain serve --http` accepts a capture from an OAuth client_credentials client (read write, vault source), the previous
 * CLI's `gbrain jobs work` runs it, a `gbrain put` makes a newer edit to the page, tonight's CLI upgrades the brain in place,
 * tonight's server takes the identical POST again, tonight's `gbrain jobs work` runs whatever it queued, and the page must
 * still hold the newer edit. PGLite takes one process at a time, so each server is stopped before the CLI touches the brain;
 * that is also how a PGLite brain runs its captures, since PGLite has no background worker and `jobs work` drains and exits.
 *
 * v0.60.609.0 added the target slug to the capture's queue idempotency key, and nothing looked up the old key form, so the
 * retry of a capture accepted before the upgrade queued a second job, and that job put the old body back over the newer
 * edit. v0.60.610.0 looks up the legacy key and answers the retry with the original job.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SmokeFail, check, fail, gbrain, jsonOut, rootVersion, seedBrain, serveHttp, tail, upgradeBrain, type SeededBrain, type Server, type SmokeContext } from './harness.ts';

const SLUG = 'notes/ingest-retry-capture';
const CAPTURED = 'First body from the integration, captured before the upgrade.';
const EDITED = 'Newer edit made after the capture landed.';
const BODY = `---\ntype: note\ntitle: Ingest retry capture\n---\n\n# Ingest retry capture\n\n${CAPTURED}\n`;

interface Client { id: string; secret: string }

export async function ingestRetryAcrossUpgrade(ctx: SmokeContext): Promise<string> {
  const prev = ctx.previousRoot, root = ctx.tonightRoot;
  const b = await seedBrain(ctx, prev, { seed: 31 });
  // The client secret is printed once; the smoke log gets the output with it blanked.
  const reg = await gbrain(prev, ['auth', 'register-client', 'nightly-ingest-retry', '--grant-types', 'client_credentials', '--scopes', 'read write', '--source', b.source],
    { env: b.env, log: line => ctx.log(line.replace(/gbrain_cs_[0-9a-f]+/g, 'gbrain_cs_<redacted>')) });
  const client = { id: reg.stdout.match(/gbrain_cl_[0-9a-f]+/)?.[0] ?? '', secret: reg.stdout.match(/gbrain_cs_[0-9a-f]+/)?.[0] ?? '' };
  check(reg.code === 0 && client.id && client.secret, 'client_register_failed', () => `auth register-client exited ${reg.code} with no client id and secret: ${tail(reg.stderr, 4)}`);
  const cwd = join(ctx.work, 'serve-cwd');
  mkdirSync(cwd, { recursive: true });

  const first = await capture(ctx, b, prev, cwd, client);
  await drain(b, prev, first);
  const captured = await page(b, prev);
  check(captured.text.includes(CAPTURED), 'capture_not_written', `job ${first} completed but ${SLUG} does not hold the captured body: ${captured.text.slice(0, 200)}`);

  const put = await b.cli(prev, ['put', SLUG, '--source-id', b.source, '--expected-revision', captured.revision],
    { input: `---\ntype: note\ntitle: Ingest retry capture\n---\n\n# Ingest retry capture\n\n${EDITED}\n` });
  check(put.code === 0, 'edit_failed', () => `gbrain put ${SLUG} at revision ${captured.revision} exited ${put.code}: ${tail(put.stdout + put.stderr, 4)}`);
  check((await page(b, prev)).text.includes(EDITED), 'edit_not_readable', `gbrain put ${SLUG} succeeded but the page does not read back the newer edit`);

  await upgradeBrain(b, root);
  const retry = await capture(ctx, b, root, cwd, client);
  await drain(b, root, retry);
  const after = await page(b, root);
  const captures = await captureJobs(b, root);
  const verdict = `the retry of capture job ${first} got ${retry === first ? 'the same job back' : `a new job ${retry}`} (${captures} ingest_capture job(s) on record)`;
  check(after.text.includes(EDITED) && !after.text.includes(CAPTURED), 'retry_overwrote_newer_edit',
    `${verdict}, and once the queue drained ${SLUG} held ${after.text.includes(CAPTURED) ? 'the old captured body again' : 'neither body'} instead of the newer edit`);
  return `${rootVersion(prev)} to ${rootVersion(root)}: ${verdict}; ${SLUG} kept its newer edit`;
}

/** Starts `root`'s serve --http, takes a client_credentials token, POSTs the capture, stops the server; returns the job id. */
async function capture(ctx: SmokeContext, b: SeededBrain, root: string, cwd: string, client: Client): Promise<number> {
  // A server that never answers GET /health on a brain it wrote or just upgraded is gbrain failing, not the harness.
  const server = await serveHttp(root, { env: b.env, cwd, log: ctx.log })
    .catch(e => e instanceof SmokeFail && e.code === 'harness_serve_not_ready' ? fail('serve_not_ready', e.detail) : Promise.reject(e));
  try {
    const token = await accessToken(server, client);
    const res = await fetch(`${server.url}/ingest`, {
      method: 'POST', body: BODY, signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown', 'x-gbrain-slug': SLUG },
    });
    const text = await res.text();
    ctx.log(`POST /ingest on ${rootVersion(root)} -> ${res.status} ${text.slice(0, 300)}`);
    const job = (JSON.parse(text.startsWith('{') ? text : '{}') as { job_id?: unknown }).job_id;
    check(res.status === 202 && Number.isInteger(Number(job)), 'ingest_not_accepted', `POST /ingest on ${rootVersion(root)} answered ${res.status}: ${text.slice(0, 200)}`);
    return Number(job);
  } finally { await server.stop(); }
}

async function accessToken(server: Server, client: Client): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: client.id, client_secret: client.secret, scope: 'read write', resource: `http://localhost:${server.port}/mcp` });
  const res = await fetch(`${server.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  const token = (JSON.parse(text.startsWith('{') ? text : '{}') as { access_token?: unknown }).access_token;
  check(res.ok && typeof token === 'string', 'token_refused', `the token endpoint answered ${res.status} for the registered client: ${text.slice(0, 200)}`);
  return token as string;
}

/** Runs every queued job with `root`'s `gbrain jobs work` (on PGLite it drains the queue and exits) and requires `job` to complete. */
async function drain(b: SeededBrain, root: string, job: number): Promise<void> {
  const work = await b.cli(root, ['jobs', 'work'], { timeoutMs: 300_000 });
  check(work.code === 0, 'jobs_work_failed', () => `gbrain ${rootVersion(root)} jobs work exited ${work.code}: ${tail(work.stdout + work.stderr, 4)}`);
  const got = await b.cli(root, ['jobs', 'get', String(job), '--json']);
  const status = jsonOut<{ status?: string }>(got)?.status;
  check(status === 'completed', 'capture_job_failed', () => `capture job ${job} is ${status ?? 'unreadable'} after jobs work on ${rootVersion(root)}: ${tail(got.stdout + got.stderr, 4)}`);
}

async function page(b: SeededBrain, root: string): Promise<{ text: string; revision: string }> {
  const r = await b.cli(root, ['get', SLUG, '--source-id', b.source, '--json']);
  const p = jsonOut<{ compiled_truth?: string; revision?: string }>(r);
  check(r.code === 0 && p, 'page_unreadable', () => `gbrain ${rootVersion(root)} get ${SLUG} exited ${r.code}: ${tail(r.stdout + r.stderr, 4)}`);
  return { text: String(p!.compiled_truth ?? ''), revision: String(p!.revision ?? '') };
}

async function captureJobs(b: SeededBrain, root: string): Promise<number | string> {
  const r = await b.cli(root, ['jobs', 'list', '--limit', '100', '--json']);
  const rows = jsonOut<Array<{ name?: string }> | { jobs?: Array<{ name?: string }> }>(r);
  const list = Array.isArray(rows) ? rows : rows?.jobs;
  return Array.isArray(list) ? list.filter(j => j.name === 'ingest_capture').length : 'an unknown number of';
}
