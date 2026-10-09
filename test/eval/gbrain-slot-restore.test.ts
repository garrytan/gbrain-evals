import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshProviderBaseUrls } from '../../eval/runner/cat40/gbrain-arm.ts';

function home(cfg: Record<string, unknown>): string {
  const h = mkdtempSync(join(tmpdir(), 'slot-home-'));
  mkdirSync(join(h, '.gbrain'));
  writeFileSync(join(h, '.gbrain', 'config.json'), JSON.stringify(cfg));
  return h;
}
const read = (h: string) => JSON.parse(readFileSync(join(h, '.gbrain', 'config.json'), 'utf8'));

describe('refreshProviderBaseUrls (restored slots rerank through the live proxy)', () => {
  test('a snapshot built under an earlier proxy port is pointed at the current one', () => {
    const h = home({ engine: 'pglite', provider_base_urls: { voyage: 'http://127.0.0.1:37547/s1/voyage/v1', google: 'http://x' } });
    expect(refreshProviderBaseUrls(h, 'http://127.0.0.1:41000/s1/voyage/v1')).toBe(true);
    expect(read(h)).toEqual({ engine: 'pglite', provider_base_urls: { voyage: 'http://127.0.0.1:41000/s1/voyage/v1', google: 'http://x' } });
  });
  test('an up-to-date or unset Voyage URL is left alone', () => {
    const same = home({ provider_base_urls: { voyage: 'http://127.0.0.1:41000/s1/voyage/v1' } });
    expect(refreshProviderBaseUrls(same, 'http://127.0.0.1:41000/s1/voyage/v1')).toBe(false);
    const none = home({ engine: 'pglite' });
    expect(refreshProviderBaseUrls(none, 'http://127.0.0.1:41000/s1/voyage/v1')).toBe(false);
    expect(read(none)).toEqual({ engine: 'pglite' });
  });
  test('a home without a config is a no-op', () => {
    expect(refreshProviderBaseUrls(mkdtempSync(join(tmpdir(), 'slot-home-')), 'http://127.0.0.1:1/v1')).toBe(false);
  });
});
