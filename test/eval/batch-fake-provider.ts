/**
 * An in-process fake of the OpenAI Batch and Anthropic Message Batches APIs
 * (plus both free token-count endpoints) for batch-lane tests. No network.
 */
export type FakeOutcome =
  | { kind: 'ok'; text?: string; finish?: string; usage?: Record<string, unknown> | null; service_tier?: string }
  | { kind: 'error' }
  | { kind: 'expired' };

interface FakeBatch {
  id: string;
  provider: 'openai' | 'anthropic';
  created_at_ms: number;
  status: string;
  metadata: Record<string, string> | null;
  requests: { custom_id: string; body: Record<string, any> }[];
  lines: Record<string, unknown>[] | null;
  usage: Record<string, unknown> | null;
}

export class FakeProvider {
  posts: { url: string; body: unknown }[] = [];
  gets: string[] = [];
  batches: FakeBatch[] = [];
  files = new Map<string, string>();
  clock = Date.parse('2026-10-06T20:00:00Z');
  /** Tokens the count endpoints report per request body. */
  tokensPerBody = 1000;
  serviceTier = 'batch';
  private seq = 0;

  get submissions() { return this.posts.filter(p => /\/v1\/(batches|messages\/batches)$/.test(new URL(p.url).pathname)); }
  get uploads() { return this.posts.filter(p => new URL(p.url).pathname === '/v1/files'); }

  /** End a batch, producing one result line per request from `outcome` (default: ok). */
  finish(id: string, outcome: (customId: string, body: Record<string, any>, index: number) => FakeOutcome = () => ({ kind: 'ok' }), opts: { status?: string; mutate?: (lines: Record<string, unknown>[]) => Record<string, unknown>[] } = {}) {
    const b = this.batches.find(x => x.id === id);
    if (!b) throw new Error(`no fake batch ${id}`);
    let usageIn = 0, usageOut = 0;
    let lines: Record<string, unknown>[] = b.requests.map((r, i): Record<string, unknown> => {
      const o = outcome(r.custom_id, r.body, i);
      if (o.kind === 'ok') {
        const usage = o.usage === undefined
          ? (b.provider === 'openai' ? { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } : { input_tokens: 900, output_tokens: 100, service_tier: o.service_tier ?? this.serviceTier })
          : o.usage;
        if (usage && b.provider === 'openai') { usageIn += Number(usage.prompt_tokens ?? 0); usageOut += Number(usage.completion_tokens ?? 0); }
        const text = o.text ?? `answer for ${r.custom_id}`;
        if (b.provider === 'openai') {
          return { id: `req_${i}`, custom_id: r.custom_id, response: { status_code: 200, body: { id: `chatcmpl-${i}`, model: r.body.model, choices: [{ message: { content: text }, finish_reason: o.finish ?? 'stop' }], usage, service_tier: 'default' } }, error: null };
        }
        return { custom_id: r.custom_id, result: { type: 'succeeded', message: { model: r.body.model, content: [{ type: 'text', text }], stop_reason: o.finish ?? 'end_turn', usage } } };
      }
      if (o.kind === 'expired') {
        return b.provider === 'openai' ? { custom_id: r.custom_id, response: null, error: { code: 'batch_expired', message: 'expired' } } : { custom_id: r.custom_id, result: { type: 'expired' } };
      }
      return b.provider === 'openai' ? { custom_id: r.custom_id, response: { status_code: 500, body: { error: { message: 'boom' } } }, error: null } : { custom_id: r.custom_id, result: { type: 'errored', error: { type: 'api_error' } } };
    });
    if (opts.mutate) lines = opts.mutate(lines);
    b.lines = lines;
    b.status = opts.status ?? (b.provider === 'openai' ? 'completed' : 'ended');
    b.usage = b.provider === 'openai' ? { input_tokens: usageIn, output_tokens: usageOut, total_tokens: usageIn + usageOut } : null;
  }

  private openaiJson(b: FakeBatch) {
    const failed = (b.lines ?? []).filter((l: any) => l.response?.status_code !== 200).length;
    return {
      id: b.id, object: 'batch', status: b.status, created_at: Math.floor(b.created_at_ms / 1000), metadata: b.metadata,
      request_counts: { total: b.requests.length, completed: (b.lines?.length ?? 0) - failed, failed },
      output_file_id: b.lines ? `file-out-${b.id}` : null, error_file_id: b.lines && failed ? `file-err-${b.id}` : null, usage: b.usage,
    };
  }

  private anthropicJson(b: FakeBatch) {
    const ended = b.status === 'ended';
    return {
      id: b.id, type: 'message_batch', processing_status: b.status, created_at: new Date(b.created_at_ms).toISOString(),
      request_counts: { processing: ended ? 0 : b.requests.length, succeeded: ended ? b.requests.length : 0, errored: 0, canceled: 0, expired: 0 },
      results_url: ended ? `https://api.anthropic.com/v1/messages/batches/${b.id}/results` : null,
    };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (method === 'POST') {
      let body: unknown = null;
      if (init?.body instanceof FormData) {
        const file = init.body.get('file') as Blob;
        body = { purpose: init.body.get('purpose'), file: await file.text() };
      } else if (typeof init?.body === 'string') body = JSON.parse(init.body);
      this.posts.push({ url, body });
      if (path === '/v1/responses/input_tokens' || path === '/v1/messages/count_tokens') return json({ input_tokens: this.tokensPerBody });
      if (path === '/v1/files') {
        const id = `file-in-${++this.seq}`;
        this.files.set(id, (body as { file: string }).file);
        return json({ id });
      }
      if (path === '/v1/batches') {
        const b = body as { input_file_id: string; metadata: Record<string, string> };
        const text = this.files.get(b.input_file_id) ?? '';
        const requests = text.split('\n').filter(Boolean).map(l => JSON.parse(l)).map((l: any) => ({ custom_id: l.custom_id, body: l.body }));
        const batch: FakeBatch = { id: `batch_${++this.seq}`, provider: 'openai', created_at_ms: this.clock, status: 'in_progress', metadata: b.metadata, requests, lines: null, usage: null };
        this.batches.push(batch);
        return json(this.openaiJson(batch));
      }
      if (path === '/v1/messages/batches') {
        const requests = (body as { requests: { custom_id: string; params: any }[] }).requests.map(r => ({ custom_id: r.custom_id, body: r.params }));
        const batch: FakeBatch = { id: `msgbatch_${++this.seq}`, provider: 'anthropic', created_at_ms: this.clock, status: 'in_progress', metadata: null, requests, lines: null, usage: null };
        this.batches.push(batch);
        return json(this.anthropicJson(batch));
      }
      if (path === '/v1/chat/completions' || path === '/v1/messages') return json({ usage: { input_tokens: 1, output_tokens: 1 } });
      return json({ error: 'unknown POST' }, 404);
    }
    this.gets.push(url);
    let m: RegExpExecArray | null;
    if (path === '/v1/batches') return json({ data: this.batches.filter(b => b.provider === 'openai').reverse().map(b => this.openaiJson(b)), has_more: false });
    if ((m = /^\/v1\/batches\/([^/]+)$/.exec(path))) {
      const b = this.batches.find(x => x.id === m![1]);
      return b ? json(this.openaiJson(b)) : json({ error: 'not found' }, 404);
    }
    if ((m = /^\/v1\/files\/file-(out|err)-([^/]+)\/content$/.exec(path))) {
      const b = this.batches.find(x => x.id === m![2])!;
      const lines = (b.lines ?? []).filter((l: any) => (m![1] === 'out') === (l.response?.status_code === 200));
      return new Response(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    }
    if (path === '/v1/messages/batches') return json({ data: this.batches.filter(b => b.provider === 'anthropic').reverse().map(b => this.anthropicJson(b)), has_more: false });
    if ((m = /^\/v1\/messages\/batches\/([^/]+)\/results$/.exec(path))) {
      const b = this.batches.find(x => x.id === m![1])!;
      return new Response((b.lines ?? []).map(l => JSON.stringify(l)).join('\n') + '\n');
    }
    if ((m = /^\/v1\/messages\/batches\/([^/]+)$/.exec(path))) {
      const b = this.batches.find(x => x.id === m![1]);
      return b ? json(this.anthropicJson(b)) : json({ error: 'not found' }, 404);
    }
    return json({ error: `unknown GET ${path}` }, 404);
  };
}
