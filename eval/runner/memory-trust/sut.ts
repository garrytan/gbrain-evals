/**
 * Shared hermetic brain for the memory trust categories (Cat 37 poisoning,
 * Cat 38 state resolution, Cat 39 deletion audit; gbrain #5575).
 *
 * One in-memory PGLite brain per call to openTrustSut, set up the way
 * gbrain's own trust tests set one up (test/trust-channel-writes.test.ts):
 * managed persistence on, the local CLI writer registered, and a legacy
 * read+write token for the remote agent caller. Every write goes through
 * gbrain's operation handlers (the code the MCP server dispatches to), so
 * tiers, the write gate and guarded supersession run exactly as they do for
 * a real agent:
 *
 *   remote  an agent over MCP (remote: true, HTTP transport, read+write
 *           token, no memory_confirm scope): writes land agent_written, or
 *           external_untrusted with content_origin "tool_output";
 *   local   the trusted local CLI (remote: false): owner-only operations
 *           such as purge_fact; its own put_page/remember are agent_written
 *           (a local agent with a shell is indistinguishable from the owner);
 *   owner   the owner's notes, imported with the tier the owner-source import
 *           declares (operator_curated, lowered by frontmatter markers);
 *   connector  connector-shaped import: content arrives with
 *           external_untrusted and a connector channel, the seam gbrain's
 *           connector sync passes to importFromContent.
 *
 * The owner and connector imports run with managed persistence paused for
 * the one import, as gbrain's own tests do; everything else is journaled.
 *
 * Capabilities are detected, not assumed: on a gbrain without trust tiers
 * (the pinned dependency before #5575 merges) the categories still run and
 * report what that build does, with every missing feature listed as a gap.
 */
import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importGbrain, type GbrainUnderTest } from '../gbrain-under-test.ts';

/** The protections one arm runs with. Keys are gbrain's local config keys (#5575 DX-13). */
export interface TrustMode {
  'write_gate.external_mode': 'quarantine' | 'flag' | 'reject' | 'off';
  'write_gate.agent_mode': 'flag' | 'off';
  'trust.agent_activation': 'suppress' | 'allow';
}

/** `gbrain trust disable --all`: every protection off (src/core/trust/owner-actions.ts TRUST_KILL_SWITCH_VALUES). */
export const MODE_OFF: TrustMode = { 'write_gate.external_mode': 'off', 'write_gate.agent_mode': 'off', 'trust.agent_activation': 'allow' };
/** gbrain's shipped defaults on the feature branch (plan B2, CEO-20). */
export const MODE_DEFAULT: TrustMode = { 'write_gate.external_mode': 'quarantine', 'write_gate.agent_mode': 'flag', 'trust.agent_activation': 'suppress' };
/** The external-flag candidate the preregistration compares with quarantine. */
export const MODE_EXTERNAL_FLAG: TrustMode = { ...MODE_DEFAULT, 'write_gate.external_mode': 'flag' };
/** Activation control off, gate on: isolates the cost and benefit of CEO-20 suppression. */
export const MODE_ACTIVATION_ALLOW: TrustMode = { ...MODE_DEFAULT, 'trust.agent_activation': 'allow' };

export const NAMED_MODES = { off: MODE_OFF, default: MODE_DEFAULT, 'external-flag': MODE_EXTERNAL_FLAG, 'activation-allow': MODE_ACTIVATION_ALLOW } as const;
export type ModeName = keyof typeof NAMED_MODES;

/** Which #5575 features the build under test has. A missing feature is a gap in the report, never an error. */
export interface TrustCapabilities {
  trust_tiers: boolean;
  write_gate: boolean;
  write_gate_holds: boolean;
  activation_control: boolean;
  content_origin: boolean;
  guarded_supersession: boolean;
  confirm_memory: boolean;
  purge_fact: boolean;
  page_purge_tombstones: boolean;
  deletion_inventory: boolean;
}

export const CAPABILITY_DESCRIPTIONS: Record<keyof TrustCapabilities, string> = {
  trust_tiers: 'trust_tier columns on facts, takes, pages and timeline entries (#5575 A1)',
  write_gate: 'write_gate_receipts and the deterministic instruction detector on writes (#5575 B1-B3)',
  write_gate_holds: 'write_gate_holds for held facts and takes (#5575 B4)',
  activation_control: 'proactive surfaces withhold unconfirmed agent-written instructions (src/core/eligibility/activation.ts, CEO-20)',
  content_origin: 'remember/put_page/capture accept content_origin (CEO-26, DX-8)',
  guarded_supersession: 'trust_proposals: lower-tier writes cannot supersede higher-tier facts (#5575 A5, ENG-4)',
  confirm_memory: 'confirm_memory owner promotion (#5575 A4, CEO-9)',
  purge_fact: 'purge_fact with a store-by-store receipt (#5575 Part C)',
  page_purge_tombstones: 'page_purges tombstones block stale re-import (CEO-8, ENG-19)',
  deletion_inventory: 'src/core/deletion-inventory.ts classifies every text-bearing column (CEO-22)',
};

export class HarnessError extends Error {}

/** A gbrain operation outcome: the value, or the typed refusal it threw. */
export type OpOutcome = { ok: true; value: any } | { ok: false; code: string; message: string };

export interface ImportOutcome { slug: string; status?: string; quarantined?: boolean; error?: string; chunks?: number }

export interface TurnContextOut { text: string; withheld: number; facts: number; pointers: number; volunteered: number }

export interface TrustSut {
  gut: GbrainUnderTest;
  engine: any;
  sourceId: string;
  capabilities: TrustCapabilities;
  /** Call an operation handler; throws gbrain's OperationError on refusal. */
  op(caller: 'remote' | 'local', name: string, params: Record<string, unknown>): Promise<any>;
  /** Call an operation handler and capture a refusal as data. */
  tryOp(caller: 'remote' | 'local', name: string, params: Record<string, unknown>): Promise<OpOutcome>;
  sql<T = Record<string, unknown>>(q: string, params?: unknown[]): Promise<T[]>;
  ownerImport(slug: string, content: string): Promise<ImportOutcome>;
  connectorImport(slug: string, content: string, origin: { channel: string; uri: string }): Promise<ImportOutcome>;
  setMode(mode: TrustMode): Promise<void>;
  /** The hook user-prompt block for one user turn (assembleTurnContext, turn mode). */
  turnContext(userText: string): Promise<TurnContextOut>;
  /** context_pack for standing entities, as the agent-facing op returns it. */
  contextPack(entities: string[]): Promise<{ text: string; withheld: number }>;
  close(): Promise<void>;
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function tableExists(engine: any, table: string): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table]);
  return rows.length > 0;
}

async function columnExists(engine: any, table: string, column: string): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column]);
  return rows.length > 0;
}

export async function detectCapabilities(gut: GbrainUnderTest, engine: any, ops: Record<string, any>): Promise<TrustCapabilities> {
  const has = (rel: string) => existsSync(join(gut.root, rel));
  const rememberParams = ops.remember?.params ?? {};
  return {
    trust_tiers: await columnExists(engine, 'facts', 'trust_tier') && await columnExists(engine, 'pages', 'trust_tier'),
    write_gate: await tableExists(engine, 'write_gate_receipts'),
    write_gate_holds: await tableExists(engine, 'write_gate_holds'),
    activation_control: has('src/core/eligibility/activation.ts'),
    content_origin: 'content_origin' in rememberParams,
    guarded_supersession: await tableExists(engine, 'trust_proposals'),
    confirm_memory: Boolean(ops.confirm_memory),
    purge_fact: Boolean(ops.purge_fact),
    page_purge_tombstones: await tableExists(engine, 'page_purges'),
    deletion_inventory: has('src/core/deletion-inventory.ts'),
  };
}

export function missingCapabilities(c: TrustCapabilities): Array<{ feature: keyof TrustCapabilities; description: string }> {
  return (Object.keys(c) as Array<keyof TrustCapabilities>).filter(k => !c[k]).map(k => ({ feature: k, description: CAPABILITY_DESCRIPTIONS[k] }));
}

/** Pull a typed code out of whatever gbrain threw. */
export function refusalCode(e: unknown): string {
  const err = e as { canonical?: string; code?: string; message?: string };
  if (typeof err?.message === 'string') {
    const typed = /^(write_held|write_gate_rejected|purged_content|confirmation_required|forget_requires_owner|trust_raise_refused|trusted_local_only|insufficient_scope)\b/.exec(err.message);
    if (typed) return typed[1]!;
  }
  return err?.canonical ?? err?.code ?? 'error';
}

const EMBEDDING = { embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536 } as const;
const templates = new Map<string, Promise<string | null>>();

/**
 * One migrated empty brain per process and gbrain build, dumped once and
 * loaded through gbrain's own GBRAIN_PGLITE_SNAPSHOT fast path (schema-hash
 * and embedding-shape guarded; see tryLoadSnapshot in pglite-engine.ts), so a
 * fresh brain costs a restore instead of replaying every migration. A build
 * without the fast path falls back to a cold init.
 */
async function brainTemplate(gut: GbrainUnderTest, mod: any): Promise<string | null> {
  if (typeof mod.computeSnapshotSchemaHash !== 'function') return null;
  let pending = templates.get(gut.root);
  if (!pending) {
    pending = (async () => {
      const hash = mod.computeSnapshotSchemaHash(crypto, fs);
      if (!hash) return null;
      const dir = fs.mkdtempSync(join(tmpdir(), 'memory-trust-template-'));
      const tar = join(dir, 'brain.tar');
      const saved = process.env.GBRAIN_PGLITE_SNAPSHOT;
      delete process.env.GBRAIN_PGLITE_SNAPSHOT;
      const engine = new mod.PGLiteEngine();
      try {
        await engine.connect({});
        await engine.initSchema();
        fs.writeFileSync(tar, new Uint8Array(await (await engine.db.dumpDataDir('none')).arrayBuffer()));
        fs.writeFileSync(join(dir, 'brain.version'), `${hash}\ndims=${EMBEDDING.embedding_dimensions}\nmodel=${EMBEDDING.embedding_model}\n`);
        process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
        return tar;
      } catch {
        return null;
      } finally {
        await engine.disconnect().catch(() => {});
        if (saved === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT; else process.env.GBRAIN_PGLITE_SNAPSHOT = saved;
      }
    })();
    templates.set(gut.root, pending);
  }
  return pending;
}

export async function openTrustSut(gut: GbrainUnderTest, opts: { sourceId?: string } = {}): Promise<TrustSut> {
  const sourceId = opts.sourceId ?? 'default';
  const engineModule = await importGbrain<any>(gut, 'src/core/pglite-engine.ts');
  const { PGLiteEngine } = engineModule;
  const { operationsByName } = await importGbrain<any>(gut, 'src/core/operations.ts');
  const { mintLegacyToken } = await importGbrain<any>(gut, 'src/core/token-mint.ts');
  const { registerLocalWriter, readLocalWriter } = await importGbrain<any>(gut, 'src/core/persistence/identity.ts');
  const { disposePersistenceConsumer } = await importGbrain<any>(gut, 'src/core/persistence/service.ts');
  const { configureGateway, resetGateway } = await importGbrain<any>(gut, 'src/core/ai/gateway.ts');
  const { importFromContent } = await importGbrain<any>(gut, 'src/core/import-file.ts');
  const { assembleTurnContext } = await importGbrain<any>(gut, 'src/core/context/turn-context.ts');
  const channel = existsSync(join(gut.root, 'src/core/trust/channel.ts')) ? await importGbrain<any>(gut, 'src/core/trust/channel.ts') : null;

  // Keyword search only: no embedding provider is configured and none is reachable.
  configureGateway({ ...EMBEDDING, env: {} });
  const template = await brainTemplate(gut, engineModule);
  const engine = new PGLiteEngine();
  const savedSnapshot = process.env.GBRAIN_PGLITE_SNAPSHOT;
  if (template) process.env.GBRAIN_PGLITE_SNAPSHOT = template;
  try {
    await engine.connect({});
  } finally {
    if (savedSnapshot === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT; else process.env.GBRAIN_PGLITE_SNAPSHOT = savedSnapshot;
  }
  await engine.initSchema();
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  if (sourceId !== 'default') await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: `agent-${randomUUID().slice(0, 8)}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await readLocalWriter(engine, 'cli');
  await engine.setConfig('search.mcp_keyword_only', 'true');

  const base = { engine, config: { engine: 'pglite', embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  const contexts = {
    remote: {
      ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id }, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] },
    },
    local: { ...base, remote: false },
  } as const;
  const capabilities = await detectCapabilities(gut, engine, operationsByName);

  const op = async (caller: 'remote' | 'local', name: string, params: Record<string, unknown>) => {
    const o = operationsByName[name];
    if (!o) throw new HarnessError(`gbrain has no operation ${name}`);
    return await o.handler(contexts[caller], { request_id: randomUUID(), ...params });
  };
  const pausedImport = async (slug: string, content: string, writeGate: unknown): Promise<ImportOutcome> => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      const r = await importFromContent(engine, slug, content, { sourceId, noEmbed: true, preserveGateMarkers: true, ...(writeGate ? { writeGate } : {}) });
      return { slug, status: r?.status, quarantined: Boolean(r?.quarantined), error: r?.error, chunks: r?.chunks };
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  };

  return {
    gut, engine, sourceId, capabilities,
    op,
    tryOp: async (caller, name, params) => {
      try { return { ok: true, value: await op(caller, name, params) }; }
      catch (e) {
        if (e instanceof HarnessError) throw e;
        return { ok: false, code: refusalCode(e), message: e instanceof Error ? e.message : String(e) };
      }
    },
    sql: async (q, params) => await engine.executeRaw(q, params),
    ownerImport: async (slug, content) => {
      const gate = channel?.ownerSourceGateInput ? await channel.ownerSourceGateInput(engine, sourceId, {}) : null;
      return pausedImport(slug, content, gate);
    },
    connectorImport: async (slug, content, origin) =>
      pausedImport(slug, content, capabilities.trust_tiers ? { tier: 'external_untrusted', origin: { channel: origin.channel, source_uri: origin.uri }, requestId: null } : null),
    setMode: async mode => {
      for (const [k, v] of Object.entries(mode)) await engine.setConfig(k, v);
    },
    turnContext: async userText => {
      const r = await assembleTurnContext(engine, { sourceId, window: [{ role: 'user', text: userText }], sessionId: randomUUID() });
      return { text: r.text ?? '', withheld: r.suppressed?.withheld ?? 0, facts: r.factsCount ?? 0, pointers: r.pointers?.length ?? 0, volunteered: r.volunteered?.length ?? 0 };
    },
    contextPack: async entities => {
      const r = await op('remote', 'context_pack', { entities });
      return { text: String(r?.text ?? ''), withheld: Number(r?.suppressed?.withheld ?? 0) };
    },
    close: async () => {
      await disposePersistenceConsumer(engine).catch(() => {});
      await engine.disconnect().catch(() => {});
      resetGateway?.();
    },
  };
}

// ─── Labels ──────────────────────────────────────────────────────────────

/** The compact label gbrain renders before an item (src/core/eligibility/labels.ts compactTrustLabel). */
export const TRUST_LABEL_RE = /\[(?:confirmed by you|your notes|tool data|written by an agent|unverified origin|external, untrusted|unconfirmed, agent-written) · [A-Za-z0-9:_./-]*\] ?/g;
const ENVELOPE_OPEN_RE = /<external-data trust="[a-z_]+" origin="[^"]*">\n?/g;
const ENVELOPE_CLOSE_RE = /\n?<\/external-data>/g;
const TRUST_KEYS = new Set(['trust_tier', 'origin', 'unconfirmed', 'contested']);

/**
 * What a pre-#5575 harness would show: the same results with every trust
 * field removed from structured output and every label or data envelope
 * removed from text. The labels-off arm of Cat 38 and the label-strip
 * mutation probe use it.
 */
export function stripTrustLabels<T>(value: T): T {
  if (typeof value === 'string') return value.replace(TRUST_LABEL_RE, '').replace(ENVELOPE_OPEN_RE, '').replace(ENVELOPE_CLOSE_RE, '') as T;
  if (Array.isArray(value)) return value.map(v => stripTrustLabels(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !TRUST_KEYS.has(k)).map(([k, v]) => [k, stripTrustLabels(v)])) as T;
  }
  return value;
}

/** True when `text` shows `needle` with a trust marking: inside an external-data envelope or on a line with an untrusted or unconfirmed label. */
export function labeledAsUntrusted(text: string, needle: string): boolean {
  const at = text.indexOf(needle);
  if (at < 0) return false;
  const open = text.lastIndexOf('<external-data', at);
  const close = text.lastIndexOf('</external-data>', at);
  if (open >= 0 && open > close) return true;
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const line = text.slice(lineStart, at);
  return /\[(?:external, untrusted|unconfirmed, agent-written) · /.test(line);
}

/** Tiers a payload may carry and still count as labeled: anything presented below the owner's own notes. */
export const BELOW_OWNER_TIERS = ['agent_written', 'unknown', 'external_untrusted'] as const;

/**
 * The trust marking text context shows for `needle`: 'external-data' inside
 * an envelope, the label words on its line (e.g. 'written by an agent',
 * 'unconfirmed, agent-written'), or null when it is shown bare.
 */
export function labelOnLine(text: string, needle: string): string | null {
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const open = text.lastIndexOf('<external-data', at);
  const close = text.lastIndexOf('</external-data>', at);
  if (open >= 0 && open > close) return 'external-data';
  const line = text.slice(text.lastIndexOf('\n', at) + 1, at);
  const m = /\[([a-z ,-]+) · [A-Za-z0-9:_./-]*\][^[]*$/.exec(line);
  return m ? m[1]! : null;
}

/** Label words that present an item below the owner's notes (src/core/trust/tier.ts TRUST_TIER_LABELS). */
export const BELOW_OWNER_LABELS = ['written by an agent', 'unverified origin', 'external, untrusted', 'unconfirmed, agent-written', 'external-data'] as const;
