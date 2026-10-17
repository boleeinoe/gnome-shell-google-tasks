// A task's color as stored in the local colors cache: a palette id ('red')
// or a custom '#rrggbb', optionally followed by '@<opacity>' (0-100) when the
// user set the fill opacity explicitly. Without '@' the row uses
// DEFAULT_TASK_OPACITY_PERCENT. A plain
// palette id is exactly what older caches hold, so they keep loading.
// Pure, so it runs under `bun test`.

export interface ColorSpec {
  // Palette id or lowercase '#rrggbb'.
  color: string;
  // Explicit fill opacity in percent, or undefined to follow the default.
  opacity?: number;
}

export interface Hsv {
  // 0-360
  h: number;
  // 0-1
  s: number;
  // 0-1
  v: number;
}

// Fill opacity of a colored row whose opacity wasn't set explicitly.
export const DEFAULT_TASK_OPACITY_PERCENT = 70;

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

// '#abc', 'abc', '#aabbcc' or 'aabbcc' (any case) -> '#aabbcc'; else null.
export function normalizeHex(text: string): string | null {
  const clean = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(clean))
    return `#${[...clean].map(c => c + c).join('')}`.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(clean))
    return `#${clean}`.toLowerCase();
  return null;
}

export function parseColorSpec(spec: string, paletteIds: ReadonlySet<string>): ColorSpec | null {
  const at = spec.lastIndexOf('@');
  const colorPart = at >= 0 ? spec.slice(0, at) : spec;
  let opacity: number | undefined;
  if (at >= 0) {
    const raw = spec.slice(at + 1);
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > 100)
      return null;
    opacity = Number(raw);
  }

  let color: string | null;
  if (colorPart.startsWith('#'))
    color = /^#[0-9a-f]{6}$/i.test(colorPart) ? colorPart.toLowerCase() : null;
  else
    color = paletteIds.has(colorPart) && colorPart !== 'none' ? colorPart : null;
  if (!color)
    return null;
  return opacity === undefined ? { color } : { color, opacity };
}

export function formatColorSpec({ color, opacity }: ColorSpec): string {
  return opacity === undefined ? color : `${color}@${clampPercent(opacity)}`;
}

// The '#rrggbb' a spec paints with, given the palette.
export function colorSpecHex(spec: ColorSpec, palette: Readonly<Record<string, string>>): string | undefined {
  return spec.color.startsWith('#') ? spec.color : palette[spec.color];
}

// The fill opacity a spec paints with, in percent.
export function colorSpecOpacity(spec: ColorSpec): number {
  return spec.opacity ?? DEFAULT_TASK_OPACITY_PERCENT;
}

export function hexToHsv(hex: string): Hsv {
  const clean = (normalizeHex(hex) ?? '#000000').slice(1);
  const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
  const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
  const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r)
      h = ((g - b) / d) % 6;
    else if (max === g)
      h = (b - r) / d + 2;
    else
      h = (r - g) / d + 4;
    h *= 60;
    if (h < 0)
      h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const val = Math.max(0, Math.min(1, v));
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  const [r, g, b] = hue < 60
    ? [c, x, 0]
    : hue < 120
      ? [x, c, 0]
      : hue < 180
        ? [0, c, x]
        : hue < 240
          ? [0, x, c]
          : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

export function hsvToHex(hsv: Hsv): string {
  const byte = (unit: number) => Math.round(unit * 255).toString(16).padStart(2, '0');
  return `#${hsvToRgb(hsv).map(byte).join('')}`;
}
