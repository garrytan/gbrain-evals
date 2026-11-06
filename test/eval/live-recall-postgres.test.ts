/**
 * Opt-in: the live-recall barrier and guards against a real Postgres server.
 *
 *   docker run -d --name lr-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55440:5432 pgvector/pgvector:pg17
 *   LIVE_RECALL_PG_TEST_URL=postgresql://postgres:postgres@127.0.0.1:55440/postgres bun test test/eval/live-recall-postgres.test.ts
 *
 * The URL must name a superuser on a scratch server. The test builds the public
 * fixture brain in a database of its own, then runs the counted-run path
 * (openPostgresBrain, the guards, every arm) against it as a superuser (refused),
 * as roles holding one write path each (refused), as a SELECT-only role (barrier
 * no_write_privilege), on a marked copy (barrier copy) and on a copy whose marker
 * names another cluster (refused), and checks that no table changed. Keyless: hash embeddings and
 * the overlap reranker stand in for the providers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { importGbrain, resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { COPY_MARKER_TABLE, GuardRefusal, LiveRecallAbort, openPostgresBrain } from '../../eval/runner/live-recall/brain.ts';
import { FIXTURE_DIR, freezeSummary, ingestFixture, liveRecall, parseQuestions, useFixtureTransports } from '../../eval/runner/live-recall/run.ts';

const ADMIN_URL = process.env.LIVE_RECALL_PG_TEST_URL;
const ENV_KEYS = ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'GBRAIN_DATABASE_URL', 'DATABASE_URL', 'GBRAIN_DIRECT_DATABASE_URL', 'GBRAIN_DISABLE_DIRECT_POOL', 'LIVE_RECALL_DATABASE_URL', 'TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY', 'GBRAIN_DECIDE_SLOTS', 'GBRAIN_HOME'];

describe.skipIf(!ADMIN_URL)('live-recall on a real Postgres (opt-in)', () => {
  const gut = resolveGbrainUnderTest(null);
  const suffix = String(process.pid);
  const src = 'lr_src_' + suffix, copy = 'lr_copy_' + suffix, reader = 'lr_reader_' + suffix;
  const columnWriter = 'lr_colw_' + suffix, viewWriter = 'lr_vieww_' + suffix, view = 'lr_view_' + suffix;
  const seqWriter = 'lr_seqw_' + suffix, dbCreator = 'lr_dbc_' + suffix, definerCaller = 'lr_defc_' + suffix, definer = 'lr_definer_' + suffix;
  const selectOnly = 'lr_ctl_' + suffix;
  const roles = [reader, columnWriter, viewWriter, seqWriter, dbCreator, definerCaller, selectOnly];
  const dbUrl = (db: string, user = 'postgres', password?: string) => {
    const u = new URL(ADMIN_URL!);
    u.pathname = '/' + db;
    if (password) { u.username = user; u.password = password; }
    return u.toString();
  };
  const savedEnv: Record<string, string | undefined> = {};
  let admin: ReturnType<typeof postgres>;
  let dir: string;
  let questionsPath: string, freezePath: string;
  let resetTransports: () => void;

  /** Row count and an order-independent digest of every table in public. */
  async function fingerprint(db: string): Promise<Record<string, string>> {
    const sql = postgres(dbUrl(db), { max: 1, onnotice: () => {} });
    try {
      const tables = await sql<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
      const out: Record<string, string> = {};
      for (const { t } of tables) {
        const [row] = await sql.unsafe('SELECT count(*)::text AS n, coalesce(md5(string_agg(x::text, \'|\' ORDER BY x::text)), \'\') AS h FROM public."' + t + '" x');
        out[t] = row!.n + ':' + row!.h;
      }
      return out;
    } finally {
      await sql.end();
    }
  }

  const run = (url: string, out: string) => {
    process.env.LIVE_RECALL_DATABASE_URL = url;
    return liveRecall({ fixture: false, questionsPath, freezePath, databaseUrlEnv: 'LIVE_RECALL_DATABASE_URL', out: join(dir, out), gut }, () => {});
  };
  const abortCode = async (p: Promise<unknown>) => {
    try { await p; return 'no abort'; } catch (e) { return e instanceof LiveRecallAbort ? e.code : String(e); }
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = 'fixture';
    process.env.VOYAGE_API_KEY = 'fixture';
    dir = mkdtempSync(join(tmpdir(), 'live-recall-pg-'));
    process.env.GBRAIN_HOME = dir;
    mkdirSync(join(dir, '.gbrain'));
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 256 }));
    const text = readFileSync(join(FIXTURE_DIR, 'questions.jsonl'), 'utf8');
    questionsPath = join(dir, 'questions.jsonl');
    freezePath = join(dir, 'freeze.json');
    writeFileSync(questionsPath, text);
    writeFileSync(freezePath, JSON.stringify(freezeSummary(text, parseQuestions(text))));

    admin = postgres(ADMIN_URL!, { max: 1, onnotice: () => {} });
    await admin.unsafe('DROP DATABASE IF EXISTS ' + copy);
    await admin.unsafe('DROP DATABASE IF EXISTS ' + src);
    for (const role of roles) await admin.unsafe('DROP ROLE IF EXISTS ' + role);
    await admin.unsafe('CREATE DATABASE ' + src);

    resetTransports = await useFixtureTransports(gut);
    const { createEngine } = await importGbrain<any>(gut, 'src/core/engine-factory.ts');
    const engine = await createEngine({ engine: 'postgres', database_url: dbUrl(src) });
    await engine.connect({ engine: 'postgres', database_url: dbUrl(src) });
    await engine.initSchema();
    await ingestFixture(gut, engine);
    await engine.disconnect();

    await admin.unsafe('CREATE DATABASE ' + copy + ' TEMPLATE ' + src);
    const c = postgres(dbUrl(copy), { max: 1, onnotice: () => {} });
    await c.unsafe('CREATE TABLE public.' + COPY_MARKER_TABLE + ' (made_at timestamptz NOT NULL DEFAULT now(), copy_system_identifier text NOT NULL, source_server_version_num int, source_pgvector text, copy_server_version_num int, copy_pgvector text, restore_errors int)');
    await c.unsafe('INSERT INTO public.' + COPY_MARKER_TABLE + " (copy_system_identifier, source_server_version_num, source_pgvector, copy_server_version_num, copy_pgvector, restore_errors) SELECT system_identifier::text, 160004, '0.7.4', 170002, '0.8.0', 2 FROM pg_control_system()");
    await c.end();

    await admin.unsafe("CREATE ROLE " + reader + " LOGIN PASSWORD 'reader-pw' BYPASSRLS");
    await admin.unsafe('GRANT CONNECT ON DATABASE ' + src + ' TO ' + reader);
    const s = postgres(dbUrl(src), { max: 1, onnotice: () => {} });
    await s.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await s.unsafe('GRANT USAGE ON SCHEMA public TO ' + reader);
    await s.unsafe('GRANT SELECT ON ALL TABLES IN SCHEMA public TO ' + reader);
    await s.end();
  }, 300_000);

  afterAll(async () => {
    resetTransports?.();
    if (admin) {
      await admin.unsafe('DROP DATABASE IF EXISTS ' + copy + ' WITH (FORCE)');
      await admin.unsafe('DROP DATABASE IF EXISTS ' + src + ' WITH (FORCE)');
      for (const role of roles) await admin.unsafe('DROP ROLE IF EXISTS ' + role);
      await admin.end();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('refuses a writable database with no barrier, and writes nothing', async () => {
    const before = await fingerprint(src);
    expect(await abortCode(run(dbUrl(src), 'superuser'))).toBe('LR_NO_BARRIER');
    expect(await fingerprint(src)).toEqual(before);
  }, 120_000);

  /** A role that can read every table plus one extra write grant, which the barrier must count as writable. */
  async function writerRefused(role: string, grant: string): Promise<string> {
    const s = postgres(dbUrl(src), { max: 1, onnotice: () => {} });
    try {
      await s.unsafe('CREATE OR REPLACE VIEW public.' + view + ' AS SELECT slug, title FROM pages');
      await s.unsafe('CREATE OR REPLACE FUNCTION public.' + definer + "() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");
      await s.unsafe('REVOKE EXECUTE ON FUNCTION public.' + definer + '() FROM PUBLIC');
      await admin.unsafe('CREATE ROLE ' + role + " LOGIN PASSWORD 'writer-pw' BYPASSRLS");
      await admin.unsafe('GRANT CONNECT ON DATABASE ' + src + ' TO ' + role);
      await s.unsafe('GRANT USAGE ON SCHEMA public TO ' + role);
      await s.unsafe('GRANT SELECT ON ALL TABLES IN SCHEMA public TO ' + role);
      await s.unsafe(grant + ' TO ' + role);
      const before = await fingerprint(src);
      const code = await abortCode(run(dbUrl(src, role, 'writer-pw'), role));
      expect(await fingerprint(src)).toEqual(before);
      return code;
    } finally {
      await s.unsafe('DROP VIEW IF EXISTS public.' + view);
      await s.unsafe('DROP FUNCTION IF EXISTS public.' + definer + '()');
      await s.unsafe('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ' + role);
      await s.unsafe('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ' + role);
      await s.unsafe('REVOKE ALL ON SCHEMA public FROM ' + role);
      await s.unsafe('REVOKE ALL ON DATABASE ' + src + ' FROM ' + role);
      await s.end();
    }
  }

  test('the same setup with only a SELECT grant passes the barrier, so each refusal below is its one write path', async () => {
    expect(await writerRefused(selectOnly, 'GRANT SELECT ON public.' + view)).toBe('no abort');
  }, 300_000);

  test('refuses a role with a column-level UPDATE grant as no barrier', async () => {
    expect(await writerRefused(columnWriter, 'GRANT UPDATE (title) ON public.pages')).toBe('LR_NO_BARRIER');
  }, 120_000);

  test('refuses a role with INSERT on an updatable view as no barrier', async () => {
    expect(await writerRefused(viewWriter, 'GRANT INSERT ON public.' + view)).toBe('LR_NO_BARRIER');
  }, 120_000);

  test('refuses a role that can advance a sequence as no barrier', async () => {
    expect(await writerRefused(seqWriter, 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public')).toBe('LR_NO_BARRIER');
  }, 120_000);

  test('refuses a role with CREATE on the database as no barrier', async () => {
    expect(await writerRefused(dbCreator, 'GRANT CREATE ON DATABASE ' + src)).toBe('LR_NO_BARRIER');
  }, 120_000);

  test('refuses a role that can run a SECURITY DEFINER function in public as no barrier', async () => {
    expect(await writerRefused(definerCaller, 'GRANT EXECUTE ON FUNCTION public.' + definer + '()')).toBe('LR_NO_BARRIER');
  }, 120_000);

  test('refuses a copy marker stamped by another cluster as no barrier', async () => {
    const c = postgres(dbUrl(copy), { max: 1, onnotice: () => {} });
    const [{ id }] = await c.unsafe('SELECT copy_system_identifier AS id FROM public.' + COPY_MARKER_TABLE);
    await c.unsafe('UPDATE public.' + COPY_MARKER_TABLE + " SET copy_system_identifier = '1'");
    try {
      expect(await abortCode(run(dbUrl(copy), 'foreign-marker'))).toBe('LR_NO_BARRIER');
    } finally {
      await c.unsafe('UPDATE public.' + COPY_MARKER_TABLE + ' SET copy_system_identifier = $1', [id]);
      await c.end();
    }
  }, 120_000);

  test('refuses when GBRAIN_DIRECT_DATABASE_URL is set', async () => {
    process.env.GBRAIN_DIRECT_DATABASE_URL = dbUrl(copy);
    try {
      expect(await abortCode(run(dbUrl(copy), 'direct'))).toBe('LR_DIRECT_URL_OVERRIDE');
    } finally {
      delete process.env.GBRAIN_DIRECT_DATABASE_URL;
    }
  });

  test('a database URL in GBRAIN_HOME/.gbrain/.env never reaches gbrain', async () => {
    writeFileSync(join(dir, '.gbrain', '.env'), 'GBRAIN_DIRECT_DATABASE_URL=' + dbUrl(src) + '\nGBRAIN_DATABASE_URL=' + dbUrl(src) + '\n');
    try {
      process.env.LIVE_RECALL_DATABASE_URL = dbUrl(copy);
      const brain = await openPostgresBrain(gut, 'LIVE_RECALL_DATABASE_URL', { refusals: {} });
      try {
        expect([process.env.GBRAIN_DATABASE_URL, process.env.GBRAIN_DIRECT_DATABASE_URL]).toEqual(['', '']);
        expect(brain.barrier).toBe('copy');
        const [row] = await brain.engine.executeRaw('SELECT current_database() AS db');
        expect(row.db).toBe(copy);
      } finally {
        await brain.close();
      }
    } finally {
      rmSync(join(dir, '.gbrain', '.env'), { force: true });
    }
  }, 120_000);

  test('runs every arm as a SELECT-only role and changes no table', async () => {
    const before = await fingerprint(src);
    const paths = await run(dbUrl(src, reader, 'reader-pw'), 'reader');
    const card = JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    expect(card.run.barrier).toBe('no_write_privilege');
    expect(card.run.engine).toBe('postgres');
    expect(card.run.pgvector_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect([card.run.source_pgvector, card.run.source_server_version_num, card.run.copy_server_version_num, card.run.restore_errors]).toEqual([null, null, null, null]);
    expect(card.eligibility.exclusions).toEqual({});
    expect(card.custody.readonly_verified_end).toBe(true);
    expect(await fingerprint(src)).toEqual(before);
  }, 300_000);

  test('runs every arm on a marked copy and leaves the copy unchanged', async () => {
    const before = await fingerprint(copy);
    expect(before.search_telemetry).toMatch(/^0:/);
    const paths = await run(dbUrl(copy), 'copy');
    const card = JSON.parse(readFileSync(paths.scorecard, 'utf8'));
    expect(card.run.barrier).toBe('copy');
    expect(card.run.pgvector_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect([card.run.source_pgvector, card.run.source_server_version_num, card.run.copy_server_version_num, card.run.restore_errors]).toEqual(['0.7.4', 160004, 170002, 2]);
    expect(readFileSync(paths.markdown, 'utf8')).toContain('vector search on this copy may differ from the live brain');
    expect(card.eligibility.eligible_question_forms).toBe(40);
    expect(card.custody.guard_refusals.telemetry_write).toBeGreaterThan(0);
    expect(await fingerprint(copy)).toEqual(before);
  }, 300_000);

  test('on the copy, the guard refuses raw writes and session changes, and the server refuses writes in a forced read-only transaction', async () => {
    const before = await fingerprint(copy);
    process.env.LIVE_RECALL_DATABASE_URL = dbUrl(copy);
    const counters = { refusals: {} as Record<string, number> };
    const brain = await openPostgresBrain(gut, 'LIVE_RECALL_DATABASE_URL', counters);
    try {
      await expect(brain.engine.executeRaw("INSERT INTO search_telemetry (date) VALUES (now())")).rejects.toBeInstanceOf(GuardRefusal);
      await expect(brain.engine.executeRaw('SET default_transaction_read_only = off')).rejects.toBeInstanceOf(GuardRefusal);
      await expect(brain.engine.executeRaw("SELECT set_config('default_transaction_read_only', 'off', false)")).rejects.toBeInstanceOf(GuardRefusal);
      await expect(brain.engine.executeRaw("SELECT set_config('default_transaction_read_only', 'off', true)")).rejects.toBeInstanceOf(GuardRefusal);
      await expect(brain.engine.executeRaw("SELECT set_config('role', 'postgres', true)")).rejects.toBeInstanceOf(GuardRefusal);
      await expect(brain.engine.executeRaw('WITH x AS (DELETE FROM pages RETURNING 1) SELECT count(*) FROM x')).rejects.toBeInstanceOf(GuardRefusal);
      expect(await brain.engine.transaction(async (tx: any) => (await tx.executeRaw("SELECT current_setting('transaction_read_only') AS ro"))[0].ro)).toBe('on');
      await expect(brain.engine.setConfig('live_recall_probe', 'x')).rejects.toThrow(/read-only transaction/);
      const [row] = await brain.engine.executeRaw("SELECT current_setting('default_transaction_read_only') AS dro");
      expect(row.dro).toBe('on');
    } finally {
      await brain.close();
    }
    expect(await fingerprint(copy)).toEqual(before);
  }, 120_000);

  test('refuses a brain whose schema version differs from the loaded gbrain', async () => {
    const c = postgres(dbUrl(copy), { max: 1, onnotice: () => {} });
    const [{ value }] = await c<{ value: string }[]>`SELECT value FROM config WHERE key = 'version'`;
    await c`UPDATE config SET value = ${String(Number(value) - 1)} WHERE key = 'version'`;
    try {
      expect(await abortCode(run(dbUrl(copy), 'schema'))).toBe('LR_SCHEMA_MISMATCH');
    } finally {
      await c`UPDATE config SET value = ${value} WHERE key = 'version'`;
      await c.end();
    }
  }, 120_000);
});
