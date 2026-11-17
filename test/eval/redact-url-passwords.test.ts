import { describe, expect, test } from 'bun:test';
import { redactUrlPasswords } from '../../eval/runner/hermetic-env.ts';
import { recordedCommand } from '../../eval/runner/engine-bench/perf.ts';

// Fake credentials are assembled at runtime so no literal connection string with a password sits in the source.
const pw = (...parts: string[]) => parts.join('');
const url = (scheme: string, user: string, pass: string, rest: string) => `${scheme}://${user}:${pass}@${rest}`;

describe('redactUrlPasswords', () => {
  const cases: Array<[string, string, string]> = [
    ['well-formed postgres', url('postgres', 'bench', pw('s3', 'cret'), '127.0.0.1:5432/db'), url('postgres', 'bench', '***', '127.0.0.1:5432/db')],
    ['postgresql scheme', url('postgresql', 'u', pw('hun', 'ter2'), 'db.internal/x'), url('postgresql', 'u', '***', 'db.internal/x')],
    ['empty user', url('postgres', '', pw('on', 'ly'), 'h:5432/d'), url('postgres', '', '***', 'h:5432/d')],
    ['percent-encoded', url('postgres', 'u', pw('p%40', 'ss%3Aw%2F'), 'h/d'), url('postgres', 'u', '***', 'h/d')],
    ['malformed raw @', url('postgres', 'u', pw('p@', 'ss'), 'h:5432/d'), url('postgres', 'u', '***', 'h:5432/d')],
    ['malformed raw slash and colon', url('postgres', 'u', pw('pa/', 'ss:w'), 'h/d'), url('postgres', 'u', '***', 'h/d')],
    ['other scheme', url('mysql', 'root', pw('to', 'pse'), 'h/d'), url('mysql', 'root', '***', 'h/d')],
    ["' in the password", url('postgres', 'u', pw("pa'", 'ss'), 'h/db'), url('postgres', 'u', '***', 'h/db')],
    ["' in the user", url('postgres', "o'brien", pw('p', 'w'), 'h/db'), url('postgres', "o'brien", '***', 'h/db')],
    ['password= in a query string', 'postgres://h/d?sslmode=require&' + pw('pass', 'word=') + pw('x', 'yz') + '&a=1', 'postgres://h/d?sslmode=require&password=***&a=1'],
    ['libpq key=value list', 'host=h ' + pw('pass', 'word=') + pw('x', 'yz') + ' dbname=d', 'host=h password=*** dbname=d'],
    ['libpq single-quoted value', 'host=h ' + pw('pass', 'word=') + pw("'se c", "ret'") + ' dbname=d', 'host=h password=*** dbname=d'],
    ['libpq double-quoted value', 'host=h ' + pw('pass', 'word=') + pw('"se c', 'ret"') + ' dbname=d', 'host=h password=*** dbname=d'],
  ];
  for (const [name, input, want] of cases) {
    test(name, () => {
      expect(redactUrlPasswords(input)).toBe(want);
      expect(redactUrlPasswords(`gbrain init --url "${input}" --json`)).toBe(`gbrain init --url "${want}" --json`);
    });
  }

  test('several URLs in one line are each masked', () => {
    const a = url('postgres', 'a', pw('o', 'ne'), 'h1/d'), b = url('postgres', 'b', pw('t', 'wo'), 'h2/d');
    expect(redactUrlPasswords(`${a} ${b}`)).toBe(`${url('postgres', 'a', '***', 'h1/d')} ${url('postgres', 'b', '***', 'h2/d')}`);
  });

  test('text without a password is unchanged', () => {
    for (const s of ['postgres://user@host/db', 'postgres://host:5432/db', 'https://example.com:8443/a:b', 'see https://x.org/p?q=1', 'no url here: a@b', '']) {
      expect(redactUrlPasswords(s)).toBe(s);
    }
  });

  test('a port followed by an @ later in the same token is masked, failing closed', () => {
    expect(redactUrlPasswords('https://host:8443/path@foo')).toBe('https://host:***@foo');
  });

  test('a caller may choose the mask', () => {
    expect(redactUrlPasswords(url('postgres', 'postgres', pw('ab', 'c'), '127.0.0.1:55432/sl'), '<redacted>')).toBe(url('postgres', 'postgres', '<redacted>', '127.0.0.1:55432/sl'));
  });

  test("the speed stage's recorded command uses it", () => {
    expect(recordedCommand(['--postgres-url', url('postgres', 'u', pw('p@', 'ss%21'), 'h/d')])).toBe('bun eval/runner/engine-bench/perf.ts --postgres-url ' + url('postgres', 'u', '***', 'h/d'));
  });
});
