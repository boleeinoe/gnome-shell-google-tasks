// Pure style builders for task rows, inline forms, popup menus and the task
// blocks: they only turn numbers into St inline-CSS strings. No GNOME
// imports, so they run under `bun test` as well as in the shell.

export interface Rgb { r: number; g: number; b: number }
export interface Rgba extends Rgb { a: number }

// Must match the .task-color-dot-* classes in stylesheet.css (checked by
// tests/stylesheet.test.ts): the swatch and the row show the same color.
export const TASK_COLOR_HEX: Readonly<Record<string, string>> = {
  red: '#e05252',
  orange: '#e0964f',
  yellow: '#dcc94a',
  green: '#5cae6e',
  blue: '#5b8fd9',
  purple: '#9b6fd0',
};

// A colored row is the task color mixed into a neutral base, painted almost
// opaque. A thin translucent tint picked up the hue of whatever was beneath
// (the block over a purple wallpaper turned a 12% green into plain gray).
export const TASK_COLOR_MIX_OWN = 0.32;
export const TASK_COLOR_MIX_INHERITED = 0.22;
export const TASK_COLOR_FORM_MIX = 0.2;
export const TASK_COLOR_FILL_ALPHA = 0.94;
export const TASK_COLOR_BASE_DARK: Rgb = { r: 40, g: 40, b: 40 };
export const TASK_COLOR_BASE_LIGHT: Rgb = { r: 246, g: 246, b: 246 };

// Completion circle sizes. Subtasks get a smaller one, so the levels read
// apart at a glance. Must match the schema defaults.
export const DEFAULT_RADIO_SIZE_PX = 12;
export const DEFAULT_SUBTASK_RADIO_SIZE_PX = 9;

// Block headings ("My tasks" picker, "Completed"): one step above the task
// title, so they lead their block at any title size, and always identical to
// each other. Their icons (picker arrow, "+", chevron) share one size, the
// standard 16px of GNOME's symbolic icons.
export const BLOCK_HEADING_STEP_PX = 1;
export const BLOCK_HEADING_ICON_SIZE_PX = 16;

export function blockHeadingFontSizePx(titleFontSizePx: number): number {
  return Math.round(titleFontSizePx) + BLOCK_HEADING_STEP_PX;
}

// Each nesting level shifts a row (and its inline forms) this far right, so a
// subtask sits under its parent's title and a sub-subtask one step further.
export const SUBTASK_INDENT_PX = 24;

export function subtaskIndentPx(depth: number): number {
  return Math.max(0, Math.round(depth)) * SUBTASK_INDENT_PX;
}

// Popup menus (task-list picker, color pickers): solid fallback base for when
// a background blur isn't available, and the cap on their corner radius.
export const MENU_FALLBACK_BASE: Rgb = { r: 34, g: 34, b: 34 };
export const MENU_MAX_RADIUS_PX = 8;
// Extra alpha for the blocks' and menus' edge over their fill.
export const BLOCK_BORDER_ALPHA_EXTRA = 0.06;

export function parseHex(hex: string): Rgb {
  const clean = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(clean))
    throw new Error(`not a #rrggbb color: ${hex}`);
  return {
    r: Number.parseInt(clean.substring(0, 2), 16),
    g: Number.parseInt(clean.substring(2, 4), 16),
    b: Number.parseInt(clean.substring(4, 6), 16),
  };
}

export function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function mixRgb(fg: Rgb, bg: Rgb, fgWeight: number): Rgb {
  const channel = (f: number, b: number) => Math.round(f * fgWeight + b * (1 - fgWeight));
  return { r: channel(fg.r, bg.r), g: channel(fg.g, bg.g), b: channel(fg.b, bg.b) };
}

// The task color mixed into a neutral base.
export function taskColorFill(hex: string, mix: number, base: Rgb, alpha: number): Rgba {
  return { ...mixRgb(parseHex(hex), base, mix), a: alpha };
}

export function rgbaCss({ r, g, b, a }: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Neutral base the task colors are mixed into: dark under light text, light
// under dark text, so it follows the shell theme.
export function pickTaskColorBase(foreground: Rgb): Rgb {
  const luminance = (0.2126 * foreground.r + 0.7152 * foreground.g + 0.0722 * foreground.b) / 255;
  return luminance > 0.5 ? TASK_COLOR_BASE_DARK : TASK_COLOR_BASE_LIGHT;
}

export interface TaskRowStyleOptions {
  // Vertical padding of the row.
  blockSizePx: number;
  cornerRadiusPx: number;
  // Hex of the row's effective color, if it has one.
  colorHex?: string;
  // The color is the task's own (true) or inherited from its parent (false).
  isOwnColor?: boolean;
  base?: Rgb;
  // Nesting level: 0 for a task, 1 for a subtask, 2 for a sub-subtask.
  depth?: number;
}

export interface TaskRowStyle {
  // Inline style for the row box.
  style: string;
}

// A row's inline style. A colored row is just a rounded fill, with no border
// or accent bar: St can't draw a one-sided border on a rounded box (a light
// crescent showed in the corner), and a separate accent bar added nothing the
// fill doesn't already say. Subtasks are shifted right by their depth.
export function buildTaskRowStyle(options: TaskRowStyleOptions): TaskRowStyle {
  const parts = [
    `padding-top: ${options.blockSizePx}px`,
    `padding-bottom: ${options.blockSizePx}px`,
  ];
  const indent = subtaskIndentPx(options.depth ?? 0);
  if (indent > 0)
    parts.push(`margin-left: ${indent}px`);
  if (options.colorHex) {
    const own = options.isOwnColor ?? true;
    const fill = taskColorFill(
      options.colorHex,
      own ? TASK_COLOR_MIX_OWN : TASK_COLOR_MIX_INHERITED,
      options.base ?? TASK_COLOR_BASE_DARK,
      TASK_COLOR_FILL_ALPHA,
    );
    parts.push(`background-color: ${rgbaCss(fill)}`);
    parts.push('border: none');
    parts.push(`border-radius: ${options.cornerRadiusPx}px`);
  }
  return { style: `${parts.join('; ')};` };
}

// Inline edit/add-subtask form under a colored row: same treatment as the
// row, a shade lighter so it reads as part of it.
export function buildTaskFormStyle(colorHex: string, cornerRadiusPx: number, base: Rgb = TASK_COLOR_BASE_DARK): string {
  const fill = taskColorFill(colorHex, TASK_COLOR_FORM_MIX, base, TASK_COLOR_FILL_ALPHA);
  return [
    `border-radius: ${cornerRadiusPx}px`,
    'border: none',
    `background-color: ${rgbaCss(fill)}`,
  ].join('; ');
}

// Edge of a block or menu: a soft inner glow of the given width, or a crisp
// 1px outline when the width is 0.
export function edgeStyle(color: Rgb, alpha: number, edgeBlurPx: number): string[] {
  const blur = Math.max(0, Math.round(edgeBlurPx));
  const rgba = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.min(1, alpha + BLOCK_BORDER_ALPHA_EXTRA).toFixed(3)})`;
  return blur > 0
    ? ['border: none', `box-shadow: inset 0 0 ${blur}px ${rgba}`]
    : [`border: 1px solid ${rgba}`];
}

export interface MenuStyles {
  // For a menu with a background blur: the notification color as is.
  blurred: string;
  // Without the blur: the notification tint flattened onto a solid base, so
  // nothing behind the menu shows through.
  solid: string;
}

export function buildMenuStyles(color: Rgba, radiusPx: number, edgeBlurPx: number): MenuStyles {
  const style = (fill: string) => `${[
    `background-color: ${fill}`,
    ...edgeStyle(color, color.a, edgeBlurPx),
    `border-radius: ${Math.min(radiusPx, MENU_MAX_RADIUS_PX)}px`,
  ].join('; ')};`;
  const solid = mixRgb(color, MENU_FALLBACK_BASE, color.a);
  return {
    blurred: style(`rgba(${color.r}, ${color.g}, ${color.b}, ${color.a.toFixed(3)})`),
    solid: style(`rgb(${solid.r}, ${solid.g}, ${solid.b})`),
  };
}

// The "my tasks" / "completed" blocks: the notification color with its alpha
// scaled by the opacity setting (a percentage; 100 = like a notification).
export function buildBlockStyle(color: Rgba, opacityPercent: number, radiusPx: number, edgeBlurPx: number): string {
  const fillAlpha = Math.min(1, color.a * Math.max(0, opacityPercent) / 100);
  return `${[
    `background-color: rgba(${color.r}, ${color.g}, ${color.b}, ${fillAlpha.toFixed(3)})`,
    ...edgeStyle(color, fillAlpha, edgeBlurPx),
    `border-radius: ${radiusPx}px`,
  ].join('; ')};`;
}

// A theme-node color as 0-255 channels and a 0-1 alpha. Clutter.Color (GNOME
// 46 and older) has byte fields; Cogl.Color (47+) has get_red() & co.
// returning 0-1 floats. Reading the fields of a Cogl.Color as bytes gave a
// near-black, near-transparent color.
export function themeColorToRgba(color: {
  red?: number;
  green?: number;
  blue?: number;
  alpha?: number;
  get_red?: () => number;
  get_green?: () => number;
  get_blue?: () => number;
  get_alpha?: () => number;
}): Rgba {
  const unit = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  if (typeof color.get_red === 'function' && color.get_green && color.get_blue && color.get_alpha) {
    const byte = (v: number) => Math.round(unit(v) * 255);
    return { r: byte(color.get_red()), g: byte(color.get_green()), b: byte(color.get_blue()), a: unit(color.get_alpha()) };
  }
  const byte = (v: number | undefined) => Math.round(Math.max(0, Math.min(255, v ?? 0)));
  return { r: byte(color.red), g: byte(color.green), b: byte(color.blue), a: unit((color.alpha ?? 0) / 255) };
}
