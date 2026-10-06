<!-- Verbatim commit message of garrytan/gbrain daf7426b6dbfa0de25356fffc7cb526dbcb78fb0 (fix wave 9, #5190), an ancestor of PR #6111 head 1fbe8660cb0dc1737d7bd9323aa9c6410dc80ec8. The migration is numbered v211 function_search_path after integration. -->

```text
fix(schema): every gbrain plpgsql function pins search_path; fingerprint functions qualify built-ins (#5190)

19 gbrain functions in public had no pinned search_path (16 plpgsql, 3
SQL), so an unqualified reference in their bodies resolved through the
caller's search_path. Every plpgsql definition source (page-state,
persistence attribution/graduation/writer-guard, planner-stats,
shared-skills header lines, the withdrawal trigger, the v163 header and
the graduation target's auto_enable_rls) now carries
SET search_path = pg_catalog, public, and the generated schemas are
rebuilt. The fact fingerprint SQL functions back an index expression
and must stay inlinable, so they call pg_catalog-qualified built-ins
instead (TODOS #5190); their outputs are byte-identical.

Placeholder migration w9_f_function_search_path (v210, renumbered at
integration) re-creates the three fingerprint functions and ALTERs
every public gbrain_* (and auto_enable_rls) plpgsql function with no
setting by oid::regprocedure. Idempotent.

Measured cost (10k-row facts insert through the withdrawal trigger,
3 runs): PGLite 1.31-1.46 s -> 1.45-1.69 s, Postgres 16 531-536 ms ->
565-604 ms. Supabase's linter still lists the three SQL functions; the
RLS guide says why.

Regression: test/fact-fingerprint-search-path.test.ts (both engines;
Postgres via test/e2e/fact-fingerprint-search-path-postgres.test.ts):
~24-claim golden pinned from master passes on both sides; hostile
search_path, proconfig after fresh migrate, re-apply/re-pin and
withdrawal-survives cases fail on master (4/6) and pass here; the
fingerprint index plan passes on both.
```
