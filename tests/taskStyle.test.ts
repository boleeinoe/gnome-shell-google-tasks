import type { Rgb } from '../src/taskStyle.js';
import { describe, expect, it } from 'bun:test';
import {
  BLOCK_HEADING_ICON_SIZE_PX,
  blockHeadingFontSizePx,
  buildBlockStyle,
  buildMenuStyle,
  buildTaskFormStyle,
  buildTaskRowStyle,
  DEFAULT_RADIO_SIZE_PX,
  DEFAULT_SUBTASK_RADIO_SIZE_PX,
  parseHex,
  percentToAlpha,
  pickTaskColorBase,
  SUBTASK_INDENT_PX,
  subtaskIndentPx,
  TASK_COLOR_BASE_DARK,
  TASK_COLOR_BASE_LIGHT,
  TASK_COLOR_FILL_ALPHA,
  TASK_COLOR_FORM_MIX,
  TASK_COLOR_HEX,
  TASK_COLOR_MIX_INHERITED,
  TASK_COLOR_MIX_OWN,
  taskColorFill,
} from '../src/taskStyle.js';

function hue({ r, g, b }: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0)
    return Number.NaN;
  let h: number;
  if (max === r)
    h = ((g - b) / d) % 6;
  else if (max === g)
    h = (b - r) / d + 2;
  else
    h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function chroma({ r, g, b }: Rgb): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// What the eye sees: a translucent fill painted over a background.
function over(fill: Rgb & { a: number }, bg: Rgb): Rgb {
  const c = (f: number, b: number) => f * fill.a + b * (1 - fill.a);
  return { r: c(fill.r, bg.r), g: c(fill.g, bg.g), b: c(fill.b, bg.b) };
}

function rgbaOf(css: string): { r: number; g: number; b: number; a: number } {
  const m = css.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);
  if (!m)
    throw new Error(`no color in: ${css}`);
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

// Backgrounds a task block can end up over: the purple wallpaper tint from the
// bug report, the opposite hues, plain dark/light, black and white.
const BACKGROUNDS: Record<string, Rgb> = {
  'purple wallpaper': { r: 72, g: 55, b: 65 },
  'green': { r: 40, g: 90, b: 50 },
  'blue': { r: 40, g: 60, b: 110 },
  'red': { r: 120, g: 40, b: 40 },
  'dark gray': { r: 48, g: 48, b: 48 },
  'light gray': { r: 230, g: 230, b: 230 },
  'black': { r: 0, g: 0, b: 0 },
  'white': { r: 255, g: 255, b: 255 },
};

describe('task colors read as the chosen color on any background', () => {
  for (const [name, hex] of Object.entries(TASK_COLOR_HEX)) {
    for (const [baseName, base] of [['dark theme', TASK_COLOR_BASE_DARK], ['light theme', TASK_COLOR_BASE_LIGHT]] as const) {
      for (const [mixName, mix] of [['own', TASK_COLOR_MIX_OWN], ['inherited', TASK_COLOR_MIX_INHERITED], ['edit form', TASK_COLOR_FORM_MIX]] as const) {
        it(`${name}, ${mixName}, ${baseName}`, () => {
          const target = hue(parseHex(hex));
          for (const [bgName, bg] of Object.entries(BACKGROUNDS)) {
            const seen = over(taskColorFill(hex, mix, base, TASK_COLOR_FILL_ALPHA), bg);
            // Not washed out to gray...
            expect(chroma(seen), `${name} over ${bgName}`).toBeGreaterThanOrEqual(10);
            // ...and still the same hue.
            expect(hueDistance(hue(seen), target), `${name} over ${bgName}`).toBeLessThanOrEqual(25);
          }
        });
      }
    }
  }

  it('green over the purple wallpaper is green, not gray (the reported bug)', () => {
    const seen = over(taskColorFill(TASK_COLOR_HEX.green, TASK_COLOR_MIX_OWN, TASK_COLOR_BASE_DARK, TASK_COLOR_FILL_ALPHA), BACKGROUNDS['purple wallpaper']);
    expect(seen.g - Math.max(seen.r, seen.b)).toBeGreaterThan(10);
  });
});

describe('buildTaskRowStyle', () => {
  const colored = buildTaskRowStyle({ blockSizePx: 4, cornerRadiusPx: 6, colorHex: TASK_COLOR_HEX.green, isOwnColor: true });
  const inherited = buildTaskRowStyle({ blockSizePx: 4, cornerRadiusPx: 6, colorHex: TASK_COLOR_HEX.green, isOwnColor: false });
  const plain = buildTaskRowStyle({ blockSizePx: 4, cornerRadiusPx: 6 });

  it('never uses a one-sided border (St draws a crescent in the rounded corner)', () => {
    for (const { style } of [colored, inherited, plain])
      expect(style).not.toMatch(/border-(left|right|top|bottom)/);
    expect(colored.style).toContain('border: none');
  });

  it('does not indent a top-level row', () => {
    for (const { style } of [colored, inherited, plain])
      expect(style).not.toMatch(/margin/);
  });

  it('indents subtasks one step per level', () => {
    const at = (depth: number) => buildTaskRowStyle({ blockSizePx: 4, cornerRadiusPx: 6, depth }).style;
    expect(at(1)).toContain(`margin-left: ${SUBTASK_INDENT_PX}px`);
    expect(at(2)).toContain(`margin-left: ${2 * SUBTASK_INDENT_PX}px`);
    expect(subtaskIndentPx(0)).toBe(0);
    expect(subtaskIndentPx(-1)).toBe(0);
    expect(subtaskIndentPx(2)).toBe(2 * SUBTASK_INDENT_PX);
  });

  it('keeps a colored row\'s padding the same as an uncolored one\'s', () => {
    for (const { style } of [colored, inherited, plain])
      expect(style).not.toContain('padding-left');
  });

  it('rounds and fills a colored row, with no accent bar', () => {
    expect(colored.style).toContain('border-radius: 6px');
    expect(colored.style).toContain('background-color');
    expect(Object.keys(colored)).toEqual(['style']);
  });

  it('paints an inherited color lighter than an own color', () => {
    expect(chroma(rgbaOf(inherited.style))).toBeLessThan(chroma(rgbaOf(colored.style)));
  });

  it('leaves an uncolored row transparent and unrounded', () => {
    expect(plain.style).not.toContain('background-color');
    expect(plain.style).not.toContain('border-radius');
  });

  it('uses the configured fill alpha for own and inherited colors', () => {
    for (const isOwnColor of [true, false]) {
      const style = buildTaskRowStyle({ blockSizePx: 4, cornerRadiusPx: 6, colorHex: TASK_COLOR_HEX.green, isOwnColor, fillAlpha: 0.5 }).style;
      expect(rgbaOf(style).a).toBe(0.5);
    }
    expect(rgbaOf(colored.style).a).toBe(TASK_COLOR_FILL_ALPHA);
  });

  it('clamps the fill alpha to 0-1', () => {
    const at = (fillAlpha: number) => rgbaOf(buildTaskRowStyle({ blockSizePx: 4, cornerRadiusPx: 6, colorHex: TASK_COLOR_HEX.red, fillAlpha }).style).a;
    expect(at(2)).toBe(1);
    expect(at(-1)).toBe(0);
    expect(percentToAlpha(150)).toBe(1);
  });

  it('applies the block size as vertical padding', () => {
    expect(buildTaskRowStyle({ blockSizePx: 7, cornerRadiusPx: 6 }).style).toContain('padding-top: 7px; padding-bottom: 7px');
  });
});

describe('buildTaskFormStyle', () => {
  it('fills the form without a one-sided border', () => {
    const style = buildTaskFormStyle(TASK_COLOR_HEX.blue, 6);
    expect(style).not.toMatch(/border-(left|right|top|bottom)/);
    expect(style).toContain('border: none');
    expect(style).toContain('background-color');
  });

  it('uses the configured fill alpha', () => {
    expect(rgbaOf(buildTaskFormStyle(TASK_COLOR_HEX.blue, 6, TASK_COLOR_BASE_DARK, 0.3)).a).toBe(0.3);
  });
});

describe('buildMenuStyle', () => {
  const notification = { r: 255, g: 255, b: 255, a: 0.08 };

  it('is opaque even for a translucent notification color, so nothing shows through', () => {
    const style = buildMenuStyle(notification, 12, 8);
    expect(style).toMatch(/background-color: rgb\(\d+, \d+, \d+\)/);
    expect(style).not.toMatch(/background-color: rgba/);
  });

  it('carries the notification tint on its solid base', () => {
    const tinted = rgbaOf(buildMenuStyle(notification, 12, 8));
    const untinted = rgbaOf(buildMenuStyle({ ...notification, a: 0 }, 12, 8));
    expect(tinted.r).toBeGreaterThan(untinted.r);
  });

  it('caps the corner radius at 8px', () => {
    expect(buildMenuStyle(notification, 16, 8)).toContain('border-radius: 8px');
    expect(buildMenuStyle(notification, 4, 8)).toContain('border-radius: 4px');
  });

  it('uses a soft inset edge, or a 1px outline when the edge blur is 0', () => {
    expect(buildMenuStyle(notification, 12, 8)).toContain('box-shadow: inset 0 0 8px');
    expect(buildMenuStyle(notification, 12, 0)).toContain('border: 1px solid');
  });
});

describe('buildBlockStyle', () => {
  const notification = { r: 54, g: 54, b: 58, a: 0.5 };

  it('scales the notification alpha by the opacity percentage', () => {
    expect(buildBlockStyle(notification, 100, 12, 8)).toContain('rgba(54, 54, 58, 0.500)');
    expect(buildBlockStyle(notification, 50, 12, 8)).toContain('rgba(54, 54, 58, 0.250)');
  });

  it('clamps the alpha into 0..1', () => {
    expect(buildBlockStyle(notification, 300, 12, 8)).toContain('rgba(54, 54, 58, 1.000)');
    expect(buildBlockStyle(notification, -10, 12, 8)).toContain('rgba(54, 54, 58, 0.000)');
  });
});

describe('theme base and helpers', () => {
  it('mixes into a dark base under light text and a light base under dark text', () => {
    expect(pickTaskColorBase({ r: 255, g: 255, b: 255 })).toEqual(TASK_COLOR_BASE_DARK);
    expect(pickTaskColorBase({ r: 20, g: 20, b: 20 })).toEqual(TASK_COLOR_BASE_LIGHT);
  });

  it('rejects malformed hex colors', () => {
    expect(() => parseHex('#abc')).toThrow();
    expect(() => parseHex('zzzzzz')).toThrow();
    expect(parseHex('#5cae6e')).toEqual({ r: 92, g: 174, b: 110 });
  });

  it('gives subtasks a smaller completion circle than tasks', () => {
    expect(DEFAULT_SUBTASK_RADIO_SIZE_PX).toBeLessThan(DEFAULT_RADIO_SIZE_PX);
  });
});

describe('block headings', () => {
  it('sit one step above the task title at any title size', () => {
    for (const title of [8, 11, 14, 18, 24])
      expect(blockHeadingFontSizePx(title)).toBe(title + 1);
  });

  it('use the standard 16px symbolic icon size', () => {
    expect(BLOCK_HEADING_ICON_SIZE_PX).toBe(16);
  });
});
