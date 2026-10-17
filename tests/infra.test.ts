import { describe, expect, it } from 'bun:test';
import { findLinks, isSafeLinkUri, toUri, trimTrailingPunctuation } from '../src/links.js';
import { parseCreationTimes, parseTaskColors, pruneToLiveIds, serializeMap } from '../src/persistence.js';
import { HttpError, NOT_PROCESSED_HTTP_STATUSES, RETRYABLE_HTTP_STATUSES, withRetry } from '../src/retry.js';
import { TASK_COLOR_HEX, themeColorToRgba } from '../src/taskStyle.js';

const noDelay = () => Promise.resolve();

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => ++calls, { shouldRetry: () => true, delay: noDelay });
    expect(result).toBe(1);
    expect(calls).toBe(1);
  });

  it('retries a retryable error, then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      if (++calls < 3)
        throw new Error('flaky');
      return 'ok';
    }, { retries: 2, shouldRetry: () => true, delay: noDelay });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after the configured retries and rethrows the last error', async () => {
    let calls = 0;
    const run = withRetry(async () => {
      calls++;
      throw new Error(`fail ${calls}`);
    }, { retries: 2, shouldRetry: () => true, delay: noDelay });
    await expect(run).rejects.toThrow('fail 3');
    expect(calls).toBe(3);
  });

  it('does not retry an error the policy rejects (e.g. a POST that may have gone through)', async () => {
    let calls = 0;
    const run = withRetry(async () => {
      calls++;
      throw new HttpError(500, 'server error');
    }, { shouldRetry: e => e instanceof HttpError && NOT_PROCESSED_HTTP_STATUSES.has(e.status), delay: noDelay });
    await expect(run).rejects.toThrow('server error');
    expect(calls).toBe(1);
  });

  it('stops retrying once cancelled, including during the backoff', async () => {
    let calls = 0;
    let cancelled = false;
    const run = withRetry(async () => {
      calls++;
      throw new Error('down');
    }, {
      retries: 5,
      shouldRetry: () => true,
      isCancelled: () => cancelled,
      delay: async () => {
        cancelled = true;
      },
    });
    await expect(run).rejects.toThrow('down');
    expect(calls).toBe(1);
  });

  it('backs off linearly', async () => {
    const waits: number[] = [];
    await withRetry(async () => {
      if (waits.length < 2)
        throw new Error('x');
    }, { retries: 2, baseDelayMs: 100, shouldRetry: () => true, delay: async (ms) => {
      waits.push(ms);
    } });
    expect(waits).toEqual([100, 200]);
  });

  it('retries transient statuses only, and resends a POST only when it was not processed', () => {
    for (const status of [408, 429, 500, 502, 503, 504])
      expect(RETRYABLE_HTTP_STATUSES.has(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 410])
      expect(RETRYABLE_HTTP_STATUSES.has(status)).toBe(false);
    expect([...NOT_PROCESSED_HTTP_STATUSES].sort()).toEqual([429, 503]);
  });

  it('HttpError carries its status', () => {
    const error = new HttpError(404, 'gone');
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(404);
    expect(error.message).toBe('gone');
  });
});

describe('links', () => {
  it('finds web and mail links and adds a scheme where missing', () => {
    const links = findLinks('see https://example.com/a, www.gnome.org or me@example.com.');
    expect(links.map(l => l.uri)).toEqual(['https://example.com/a', 'https://www.gnome.org', 'mailto:me@example.com']);
    expect(links.map(l => l.text)).toEqual(['https://example.com/a', 'www.gnome.org', 'me@example.com']);
  });

  it('never makes other schemes clickable (file://, custom app handlers)', () => {
    const text = 'file:///etc/passwd steam://run/1 ssh://host vscode://x/y ftp://old.example.com javascript://x';
    expect(findLinks(text)).toEqual([]);
  });

  it('only web and mail URIs count as safe to open', () => {
    expect(isSafeLinkUri('https://a.b')).toBe(true);
    expect(isSafeLinkUri('HTTP://a.b')).toBe(true);
    expect(isSafeLinkUri('mailto:a@b.c')).toBe(true);
    expect(isSafeLinkUri('file:///etc/passwd')).toBe(false);
    expect(isSafeLinkUri('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkUri('steam://run/1')).toBe(false);
  });

  it('keeps punctuation and closing brackets out of the link', () => {
    expect(trimTrailingPunctuation('https://example.com/page.')).toBe('https://example.com/page');
    expect(trimTrailingPunctuation('https://example.com)')).toBe('https://example.com');
    expect(trimTrailingPunctuation('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
  });

  it('reports UTF-8 byte offsets for hit-testing after non-ASCII text', () => {
    const [link] = findLinks('Задача https://example.com');
    expect(link.jsStart).toBe(7);
    // "Задача " is 6 two-byte letters and a space.
    expect(link.byteStart).toBe(13);
    expect(link.byteEnd - link.byteStart).toBe('https://example.com'.length);
  });

  it('toUri leaves an explicit scheme alone', () => {
    expect(toUri('https://x.y')).toBe('https://x.y');
    expect(toUri('www.x.y')).toBe('https://www.x.y');
  });

  it('finds nothing in empty text', () => {
    expect(findLinks('')).toEqual([]);
  });
});

describe('local caches', () => {
  const colorIds = new Set(Object.keys(TASK_COLOR_HEX));

  it('loads valid colors and drops unknown or malformed entries', () => {
    const colors = parseTaskColors(JSON.stringify({ a: 'green', b: 'chartreuse', c: 42, d: 'none', e: 'red' }), colorIds);
    expect([...colors]).toEqual([['a', 'green'], ['e', 'red']]);
  });

  it('loads only finite, positive creation times', () => {
    const times = parseCreationTimes(JSON.stringify({ a: 1700000000000, b: 'x', c: -1, d: null, e: 0 }));
    expect([...times]).toEqual([['a', 1700000000000]]);
  });

  it('rejects a file that is not a JSON object', () => {
    expect(() => parseTaskColors('[]', colorIds)).toThrow();
    expect(() => parseCreationTimes('null')).toThrow();
    expect(() => parseCreationTimes('{oops')).toThrow();
  });

  it('round-trips through serializeMap', () => {
    const map = new Map([['a', 'green'], ['b', 'red']]);
    expect(parseTaskColors(serializeMap(map), colorIds)).toEqual(map);
  });

  it('prunes entries of tasks that no longer exist and reports the change', () => {
    const map = new Map([['live', 1], ['gone', 2]]);
    expect(pruneToLiveIds(map, new Set(['live']))).toBe(true);
    expect([...map.keys()]).toEqual(['live']);
    expect(pruneToLiveIds(map, new Set(['live']))).toBe(false);
  });
});

describe('themeColorToRgba', () => {
  it('reads a Cogl.Color (GNOME 47+) through its 0-1 getters', () => {
    const cogl = {
      red: 0.2,
      green: 0.4,
      blue: 0.6,
      alpha: 0.5,
      get_red: () => 0.2,
      get_green: () => 0.4,
      get_blue: () => 0.6,
      get_alpha: () => 0.5,
    };
    expect(themeColorToRgba(cogl)).toEqual({ r: 51, g: 102, b: 153, a: 0.5 });
  });

  it('reads a Clutter.Color (GNOME 46 and older) from its byte fields', () => {
    expect(themeColorToRgba({ red: 255, green: 128, blue: 0, alpha: 51 })).toEqual({ r: 255, g: 128, b: 0, a: 0.2 });
  });

  it('clamps out-of-range values', () => {
    const c = themeColorToRgba({ get_red: () => 2, get_green: () => -1, get_blue: () => Number.NaN, get_alpha: () => 3 });
    expect(c).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
});
