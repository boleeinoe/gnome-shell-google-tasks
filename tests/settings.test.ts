import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { STRINGS, t, textStrings } from '../src/i18n.js';
import * as settings from '../src/settings.js';

const schemaXml = readFileSync(join(import.meta.dir, '..', 'schemas/org.gnome.shell.extensions.googletasks.gschema.xml'), 'utf-8');

function schemaDefault(key: string): string {
  const body = schemaXml.match(new RegExp(`<key name="${key}" [^>]+>([\\s\\S]*?)</key>`))?.[1];
  const value = body?.match(/<default>([\s\S]*?)<\/default>/)?.[1].trim();
  if (value === undefined)
    throw new Error(`no default for ${key} in the schema`);
  return value;
}

describe('code fallbacks match the schema defaults', () => {
  // Used while settings aren't available yet; a mismatch shows one look on
  // first paint and another right after.
  const pairs: [string, unknown][] = [
    ['refresh-interval', settings.REFRESH_INTERVAL_SECONDS],
    ['column-width', settings.DEFAULT_COLUMN_WIDTH_PX],
    ['corner-radius', settings.DEFAULT_TASK_COLOR_CORNER_RADIUS_PX],
    ['title-font-size', settings.DEFAULT_TITLE_FONT_SIZE_PX],
    ['description-font-size', settings.DEFAULT_DESCRIPTION_FONT_SIZE_PX],
    ['task-block-size', settings.DEFAULT_TASK_BLOCK_SIZE_PX],
    ['subtask-block-size', settings.DEFAULT_SUBTASK_BLOCK_SIZE_PX],
    ['empty-state-icon', settings.DEFAULT_EMPTY_STATE_ICON],
    ['empty-state-icon-size', settings.DEFAULT_EMPTY_STATE_ICON_SIZE_PX],
    ['empty-state-font-size', settings.DEFAULT_EMPTY_STATE_FONT_SIZE_PX],
    ['empty-state-opacity', settings.DEFAULT_EMPTY_STATE_OPACITY_PERCENT],
    ['task-blocks-enabled', settings.DEFAULT_TASK_BLOCKS_ENABLED],
    ['task-blocks-opacity', settings.DEFAULT_TASK_BLOCKS_OPACITY_PERCENT],
    ['task-blocks-edge-blur', settings.DEFAULT_TASK_BLOCKS_EDGE_BLUR_PX],
  ];

  for (const [key, value] of pairs) {
    it(key, () => {
      const raw = schemaDefault(key);
      const expected = typeof value === 'string' ? `'${value}'` : String(value);
      expect(raw).toBe(expected);
    });
  }
});

describe('interface strings', () => {
  it('every language has exactly the same keys', () => {
    const en = Object.keys(STRINGS.en).sort();
    for (const [lang, strings] of Object.entries(STRINGS))
      expect(Object.keys(strings).sort(), lang).toEqual(en);
  });

  it('every color in the picker has a label in every language', () => {
    for (const strings of Object.values(STRINGS)) {
      for (const id of ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'])
        expect(strings[`color_${id}`]).toBeTruthy();
    }
  });

  it('falls back to English, then to the key itself', () => {
    expect(t('ru', 'save')).toBe(STRINGS.ru.save);
    expect(t('en', 'definitely-not-a-key')).toBe('definitely-not-a-key');
  });

  it('builds the clipboard/link menu strings for each language', () => {
    for (const lang of Object.keys(STRINGS) as (keyof typeof STRINGS)[]) {
      const strings = textStrings(lang);
      for (const value of Object.values(strings))
        expect(value.length).toBeGreaterThan(0);
    }
  });
});
