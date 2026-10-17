import { describe, expect, it } from 'bun:test';
import {
  clampPercent,
  colorSpecHex,
  colorSpecOpacity,
  DEFAULT_TASK_OPACITY_PERCENT,
  formatColorSpec,
  hexToHsv,
  hsvToHex,
  normalizeHex,
  parseColorSpec,
} from '../src/colorSpec.js';
import { TASK_COLOR_HEX } from '../src/taskStyle.js';

const ids = new Set(['none', ...Object.keys(TASK_COLOR_HEX)]);

describe('color specs', () => {
  it('reads a plain palette id, as older caches store it', () => {
    expect(parseColorSpec('green', ids)).toEqual({ color: 'green' });
  });

  it('reads custom colors and explicit opacities', () => {
    expect(parseColorSpec('#5CAE6E', ids)).toEqual({ color: '#5cae6e' });
    expect(parseColorSpec('red@54', ids)).toEqual({ color: 'red', opacity: 54 });
    expect(parseColorSpec('#112233@0', ids)).toEqual({ color: '#112233', opacity: 0 });
    expect(parseColorSpec('#112233@100', ids)).toEqual({ color: '#112233', opacity: 100 });
  });

  it('rejects unknown colors, \'none\' and bad opacities', () => {
    for (const bad of ['chartreuse', 'none', '#12345', '#gggggg', 'red@', 'red@101', 'red@-1', 'red@5.5', '@40', ''])
      expect(parseColorSpec(bad, ids), bad).toBeNull();
  });

  it('round-trips through formatColorSpec', () => {
    for (const spec of ['blue', 'blue@30', '#a1b2c3', '#a1b2c3@77'])
      expect(formatColorSpec(parseColorSpec(spec, ids)!)).toBe(spec);
  });

  it('resolves the hex a spec paints with', () => {
    expect(colorSpecHex({ color: 'green' }, TASK_COLOR_HEX)).toBe(TASK_COLOR_HEX.green);
    expect(colorSpecHex({ color: '#010203' }, TASK_COLOR_HEX)).toBe('#010203');
  });
});

describe('default task opacity', () => {
  it('is 70%', () => {
    expect(DEFAULT_TASK_OPACITY_PERCENT).toBe(70);
    expect(colorSpecOpacity({ color: 'red' })).toBe(70);
  });

  it('an explicit opacity wins over the default', () => {
    expect(colorSpecOpacity({ color: 'red', opacity: 5 })).toBe(5);
    expect(colorSpecOpacity({ color: '#123456', opacity: 0 })).toBe(0);
  });

  it('clamps and rounds percentages', () => {
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(41.6)).toBe(42);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe('hex and HSV', () => {
  it('normalizes the hex forms people type', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('5cae6e')).toBe('#5cae6e');
    expect(normalizeHex(' #5CAE6E ')).toBe('#5cae6e');
    expect(normalizeHex('#5cae6')).toBeNull();
    expect(normalizeHex('blue')).toBeNull();
  });

  it('converts primaries both ways', () => {
    expect(hexToHsv('#ff0000')).toEqual({ h: 0, s: 1, v: 1 });
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe('#00ff00');
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe('#0000ff');
    expect(hsvToHex({ h: 0, s: 0, v: 0 })).toBe('#000000');
    expect(hsvToHex({ h: 0, s: 0, v: 1 })).toBe('#ffffff');
  });

  it('round-trips every palette color', () => {
    for (const hex of Object.values(TASK_COLOR_HEX))
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
  });

  it('wraps the hue', () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe('#ff0000');
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe('#0000ff');
  });
});
