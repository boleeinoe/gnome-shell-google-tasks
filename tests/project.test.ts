import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Static checks across the stylesheet, the GSettings schema and the sources:
// things the type checker can't see but that have broken before.
import { describe, expect, it } from 'bun:test';
import { blockHeadingFontSizePx, DEFAULT_RADIO_SIZE_PX, DEFAULT_SUBTASK_RADIO_SIZE_PX, TASK_COLOR_HEX } from '../src/taskStyle.js';
import { DEFAULT_SUBTASK_LEVELS, MAX_SUBTASK_LEVELS, MIN_SUBTASK_LEVELS, VALID_TASK_SORT_ORDERS, VALID_TASK_TIMEFRAMES } from '../src/taskTree.js';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf-8');

const css = read('src/stylesheet.css');
const schemaXml = read('schemas/org.gnome.shell.extensions.googletasks.gschema.xml');
const prefsTs = read('src/prefs.ts');
const settingsTs = read('src/settings.ts');
const sectionTs = read('src/tasksSection.ts');
const i18nTs = read('src/i18n.ts');
// Every source file but the pure settings module, for "is it used" checks
// and source-level guards that must hold wherever the code ends up.
const sourceFiles = readdirSync(join(root, 'src')).filter(f => f.endsWith('.ts'));
const allSources = sourceFiles.map(f => read(`src/${f}`)).join('\n');
const sourcesExceptSettings = sourceFiles.filter(f => f !== 'settings.ts').map(f => read(`src/${f}`)).join('\n');
const managerTs = read('src/tasksManager.ts');
const textTs = read('src/textInteraction.ts');

// --- tiny parsers ----------------------------------------------------------------

interface CssRule { selectors: string[]; decls: Map<string, string> }

function parseCss(text: string): CssRule[] {
  const rules: CssRule[] = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i > 0)
        decls.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    }
    rules.push({ selectors: m[1].split(',').map(s => s.trim()), decls });
  }
  return rules;
}

const rules = parseCss(css);
const rulesFor = (selector: string) => rules.filter(r => r.selectors.includes(selector));
const decl = (selector: string, prop: string) => rulesFor(selector).map(r => r.decls.get(prop)).find(v => v !== undefined);

interface SchemaKey { name: string; type: string; default: string; min?: number; max?: number }

function parseSchema(xml: string): Map<string, SchemaKey> {
  const keys = new Map<string, SchemaKey>();
  for (const m of xml.matchAll(/<key name="([^"]+)" (?:type|enum)="([^"]+)">([\s\S]*?)<\/key>/g)) {
    const body = m[3];
    const range = body.match(/<range min="([^"]+)" max="([^"]+)"\s*\/>/);
    keys.set(m[1], {
      name: m[1],
      type: m[2],
      default: body.match(/<default>([\s\S]*?)<\/default>/)?.[1].trim() ?? '',
      min: range ? Number(range[1]) : undefined,
      max: range ? Number(range[2]) : undefined,
    });
  }
  return keys;
}

const schema = parseSchema(schemaXml);

function enumNicks(id: string): string[] {
  const start = schemaXml.indexOf(`<enum id="${id}">`);
  if (start < 0)
    return [];
  const body = schemaXml.slice(start, schemaXml.indexOf('</enum>', start));
  return [...body.matchAll(/nick="([^"]+)"/g)].map(m => m[1]);
}

// KEY_CONST -> 'schema-key', as declared in settings.ts.
const keyConsts = new Map([...settingsTs.matchAll(/const (\w+_KEY) = '([^']+)';/g)].map(m => [m[1], m[2]]));

function settingKeysIn(source: string): string[] {
  return [...source.matchAll(/const \w+_KEY = '([^']+)';/g)].map(m => m[1]);
}

// --- stylesheet --------------------------------------------------------------------

describe('stylesheet', () => {
  it('never combines a one-sided border with rounded corners (St draws a crescent)', () => {
    const offenders: string[] = [];
    for (const rule of rules) {
      const radius = rule.decls.get('border-radius');
      if (!radius || /^0(?:px)?$/.test(radius))
        continue;
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const value = rule.decls.get(`border-${side}`) ?? rule.decls.get(`border-${side}-width`);
        if (value && !/^(?:none|0(?:px)?)\b/.test(value))
          offenders.push(`${rule.selectors.join(', ')} { border-${side}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('task rows have no left accent border and symmetric horizontal padding', () => {
    expect(decl('.task-box', 'border-left')).toBeUndefined();
    const padding = decl('.task-box', 'padding')!.split(/\s+/);
    const right = padding[1] ?? padding[0];
    const left = padding[3] ?? right;
    expect(left).toBe(right);
  });

  it('leaves subtask indent to the inline style (no fixed margin in CSS)', () => {
    // A fixed CSS margin would indent every level by the same amount; the
    // row and form styles indent by depth instead.
    for (const selector of ['.task-box-subtask', '.task-box.task-box-subtask', '.google-tasks-edit-form-nested'])
      expect(decl(selector, 'margin-left')).toBeUndefined();
  });

  it('keeps the row gap on the row content', () => {
    expect(decl('.task-box', 'spacing')).toBeUndefined();
    expect(decl('.task-row-content', 'spacing')).toBeDefined();
  });

  it('lays a task row out as a plain full-width box', () => {
    // The row is the styled box itself — no BinLayout wrapper around it,
    // which ended up centered at its natural width.
    const createRow = sectionTs.slice(sectionTs.indexOf('_createTaskRow('), sectionTs.indexOf('addTask('));
    expect(createRow).toMatch(/\n {4}return box;\n/);
    expect(createRow).not.toMatch(/return row;/);
    expect(createRow).not.toMatch(/const row = new St\.Widget/);
  });

  it('has no accent stripe on task rows', () => {
    expect(css).not.toContain('task-color-stripe');
    expect(sectionTs).not.toMatch(/stripe/i);
  });

  it('color swatches match the colors painted on the rows', () => {
    for (const [name, hex] of Object.entries(TASK_COLOR_HEX))
      expect(decl(`.task-color-dot-${name}`, 'background-color')?.toLowerCase()).toBe(hex);
  });

  it('every color offered in the picker has a swatch and a row color', () => {
    const palette = sectionTs.match(/const TASK_COLOR_PALETTE[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? '';
    const ids = [...palette.matchAll(/id: '([^']+)'/g)].map(m => m[1]);
    expect(ids).toContain('none');
    for (const id of ids.filter(id => id !== 'none')) {
      expect(TASK_COLOR_HEX[id]).toBeDefined();
      expect(rulesFor(`.task-color-dot-${id}`).length).toBeGreaterThan(0);
    }
  });

  it('block headings are set larger than a task title', () => {
    const titlePx = Number(settingsTs.match(/const DEFAULT_TITLE_FONT_SIZE_PX = (\d+);/)?.[1]);
    const headingPx = Number.parseInt(decl('.google-tasks-block-heading', 'font-size') ?? '0', 10);
    expect(headingPx).toBe(blockHeadingFontSizePx(titlePx));
    expect(headingPx).toBeGreaterThan(titlePx);
  });

  it('both block headings ("My tasks", "Completed") share every metric', () => {
    for (const prop of ['padding', 'border-radius', 'background-color', 'text-align']) {
      expect(decl('.google-tasks-dropdown-button', prop)).toBeDefined();
      expect(decl('.tasks-completed-toggle', prop)).toBe(decl('.google-tasks-dropdown-button', prop));
    }
    // Same fill inside a block, too.
    expect(decl('.google-tasks-block .tasks-completed-toggle', 'background-color'))
      .toBe(decl('.google-tasks-block .google-tasks-dropdown-button', 'background-color'));
    // Both labels and both icons use the shared heading classes, and no
    // header element sets its own font size or icon size.
    const headingLabels = sectionTs.match(/style_class: 'google-tasks-block-heading'/g) ?? [];
    expect(headingLabels.length).toBe(2);
    const headingIcons = sectionTs.match(/icon_size: BLOCK_HEADING_ICON_SIZE_PX/g) ?? [];
    expect(headingIcons.length).toBe(3);
    expect(css).not.toMatch(/tasks-completed-(label|chevron)/);
    // The two blocks are padded alike.
    expect(rulesFor('.google-tasks-block-completed')).toEqual([]);
  });

  it('every row action has the same size, shape and resting emphasis', () => {
    const actions = ['.task-edit-button', '.task-subtask-button', '.task-delete-button', '.task-color-button', '.task-expand-button'];
    for (const prop of ['width', 'height', 'border-radius', 'padding', 'opacity']) {
      const values = new Set(actions.map(a => decl(a, prop)));
      expect(values.size).toBe(1);
      expect([...values][0]).toBeDefined();
    }
  });

  it('every hoverable control gets the same treatment on keyboard focus', () => {
    for (const rule of rules) {
      for (const selector of rule.selectors.filter(s => s.endsWith(':hover'))) {
        if (selector.startsWith('.task-text-box') || selector.startsWith('.task-radio'))
          continue; // text and the completion circle aren't focusable buttons
        const focus = selector.replace(/:hover$/, ':focus');
        expect(rule.selectors).toContain(focus);
      }
    }
  });

  it('keeps to the design tokens: radius scale, two font weights, 4px spacing grid', () => {
    const radii = new Set(['2px', '6px', '8px', '12px', '99px']);
    const weights = new Set(['700', 'bold']);
    for (const rule of rules) {
      const radius = rule.decls.get('border-radius');
      if (radius)
        expect(radii, `${rule.selectors.join(', ')}: border-radius ${radius}`).toContain(radius);
      const weight = rule.decls.get('font-weight');
      if (weight)
        expect(weights, `${rule.selectors.join(', ')}: font-weight ${weight}`).toContain(weight);
      for (const prop of ['padding', 'spacing', 'padding-top', 'padding-left', 'padding-right', 'margin-bottom', 'margin-left']) {
        const value = rule.decls.get(prop);
        if (!value)
          continue;
        for (const part of value.split(/\s+/)) {
          const px = Number.parseInt(part, 10);
          // 2px and 6px are allowed: hairline offsets and the half step that
          // centers text in a 32px control.
          expect(px % 4 === 0 || px === 2 || px === 6, `${rule.selectors.join(', ')}: ${prop} ${value}`).toBe(true);
        }
      }
    }
  });

  it('the picker menu fallback background is opaque', () => {
    expect(decl('.google-tasks-dropdown-menu .popup-menu-content', 'background-color')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// --- GSettings schema ----------------------------------------------------------------

describe('settings schema', () => {
  it('has every key the extension and the preferences read', () => {
    const missing = settingKeysIn(allSources).filter(k => !schema.has(k));
    expect(missing).toEqual([]);
  });

  it('has no key that nothing uses', () => {
    // A key counts as used when its constant is referenced outside settings.ts.
    const used = new Set([...keyConsts].filter(([name]) => new RegExp(`\\b${name}\\b`).test(sourcesExceptSettings)).map(([, key]) => key));
    expect([...schema.keys()].filter(k => !used.has(k))).toEqual([]);
  });

  it('keeps every integer default within its range', () => {
    for (const key of schema.values()) {
      if (key.type !== 'i' || key.min === undefined)
        continue;
      const value = Number(key.default);
      expect(value, key.name).toBeGreaterThanOrEqual(key.min);
      expect(value, key.name).toBeLessThanOrEqual(key.max!);
    }
  });

  it('enum keys accept exactly the values the code handles', () => {
    expect(enumNicks(schema.get('task-sort-order')!.type).sort()).toEqual([...VALID_TASK_SORT_ORDERS].sort());
    expect(enumNicks(schema.get('task-timeframe')!.type).sort()).toEqual([...VALID_TASK_TIMEFRAMES].sort());
    const langs = i18nTs.match(/type Lang = ([^;]+);/)?.[1].match(/'([^']+)'/g)?.map(l => l.slice(1, -1)) ?? [];
    expect(langs.length).toBeGreaterThan(0);
    expect(enumNicks(schema.get('language')!.type).sort()).toEqual(langs.sort());
    for (const key of ['task-sort-order', 'task-timeframe', 'language'])
      expect(enumNicks(schema.get(key)!.type)).toContain(schema.get(key)!.default.replace(/'/g, ''));
  });

  it('defaults to two nesting levels, matching the code', () => {
    const levels = schema.get('subtask-levels')!;
    expect(Number(levels.default)).toBe(DEFAULT_SUBTASK_LEVELS);
    expect(DEFAULT_SUBTASK_LEVELS).toBe(3);
    expect(levels.min).toBe(MIN_SUBTASK_LEVELS);
    expect(levels.max).toBe(MAX_SUBTASK_LEVELS);
  });

  it('circle sizes match the code fallbacks, subtask circle smaller', () => {
    expect(Number(schema.get('radio-size')!.default)).toBe(DEFAULT_RADIO_SIZE_PX);
    expect(Number(schema.get('subtask-radio-size')!.default)).toBe(DEFAULT_SUBTASK_RADIO_SIZE_PX);
    expect(DEFAULT_SUBTASK_RADIO_SIZE_PX).toBeLessThan(DEFAULT_RADIO_SIZE_PX);
  });

  it('preferences spin rows use the schema ranges', () => {
    // Every Adw.SpinRow is followed by settings.bind(KEY, row, ...).
    const rows = [...prefsTs.matchAll(/const (\w+) = new Adw\.SpinRow\(\{[\s\S]*?lower: (-?\d+),[\s\S]*?upper: (-?\d+),[\s\S]*?\}\);\s*settings\.bind\((\w+_KEY), \1,/g)];
    expect(rows.length).toBeGreaterThan(0);
    for (const [, row, lower, upper, keyConst] of rows) {
      const key = schema.get(keyConsts.get(keyConst)!);
      expect(key, row).toBeDefined();
      if (key?.min !== undefined) {
        expect(Number(lower), row).toBe(key.min);
        expect(Number(upper), row).toBe(key.max!);
      }
    }
  });
});

// --- source-level guards ----------------------------------------------------------------

describe('sources', () => {
  it('every popup menu of the task panel gets the opaque/blurred menu look', () => {
    const menus = (sectionTs.match(/new PopupMenu\.PopupMenu\(/g) ?? []).length;
    const decorated = (sectionTs.match(/this\._decorateMenu\(/g) ?? []).length;
    expect(menus).toBeGreaterThan(0);
    expect(decorated).toBe(menus);
  });

  it('never resends a task-creating POST that may already have gone through', () => {
    const create = managerTs.match(/async createTask\([\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(create).toContain('\'POST\'');
    expect(create).toMatch(/\}, false\);/);
    expect(create).not.toContain('withRetry(');
  });

  it('only hands web and mail links to the desktop', () => {
    const openUri = textTs.match(/export function openUri\([\s\S]*?\n\}\n/)?.[0] ?? '';
    expect(openUri).toContain('isSafeLinkUri(uri)');
  });

  it('does not set one-sided borders inline', () => {
    expect(allSources).not.toMatch(/`border-(left|right)\s*:/);
  });

  it('indents rows and forms only through subtaskIndentPx()', () => {
    // Every inline margin-left comes from the indent helper, so a subtask,
    // its edit form and its new-subtask form all line up per level.
    const margins = [...allSources.matchAll(/`margin-left:\s*\$\{([^}]*)\}px/g)].map(m => m[1]);
    expect(margins.length).toBeGreaterThan(0);
    for (const expr of margins)
      expect(['indent', 'formIndentPx']).toContain(expr);
    expect(allSources).toContain('const indent = subtaskIndentPx(');
    expect(allSources).toContain('const formIndentPx = subtaskIndentPx(');
  });
});
