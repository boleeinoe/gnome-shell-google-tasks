import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { STRINGS } from '../src/i18n.js';
import { buildRejection, describeLevelsProblem, describeLevelsTimeout } from '../src/nestingCheck.js';
import { levelWord, pluralForm, PREFS_STRINGS, pt, resolveLang } from '../src/prefsStrings.js';

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf-8');
const prefsTs = read('src/prefs.ts');
const nestingTs = read('src/nestingCheck.ts');

describe('preferences strings', () => {
  it('cover the same languages as the panel', () => {
    expect(Object.keys(PREFS_STRINGS).sort()).toEqual(Object.keys(STRINGS).sort());
  });

  it('every language has exactly the same keys, none empty', () => {
    const en = Object.keys(PREFS_STRINGS.en).sort();
    for (const [lang, strings] of Object.entries(PREFS_STRINGS)) {
      expect(Object.keys(strings).sort(), lang).toEqual(en);
      for (const [key, value] of Object.entries(strings))
        expect(value.trim().length, `${lang}.${key}`).toBeGreaterThan(0);
    }
  });

  it('every language uses the same placeholders in each string', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const key of Object.keys(PREFS_STRINGS.en)) {
      for (const lang of Object.keys(PREFS_STRINGS) as (keyof typeof PREFS_STRINGS)[])
        expect(placeholders(PREFS_STRINGS[lang][key]), `${lang}.${key}`).toEqual(placeholders(PREFS_STRINGS.en[key]));
    }
  });

  it('the Russian strings are actually Russian', () => {
    for (const [key, value] of Object.entries(PREFS_STRINGS.ru)) {
      if (key === 'ok')
        continue;
      expect(value, key).toMatch(/\p{Script=Cyrillic}/u);
    }
  });

  it('every key the preferences window and the nesting messages use exists', () => {
    const used = new Set<string>();
    for (const m of prefsTs.matchAll(/\bs\('(\w+)'/g))
      used.add(m[1]);
    for (const m of prefsTs.matchAll(/\bpt\(lang, '(\w+)'/g))
      used.add(m[1]);
    for (const m of nestingTs.matchAll(/\bpt\(lang, '(\w+)'/g))
      used.add(m[1]);
    for (const m of prefsTs.matchAll(/label: '([a-z]\w*)' \}/g))
      used.add(m[1]);
    expect(used.size).toBeGreaterThan(40);
    for (const key of used)
      expect(PREFS_STRINGS.en[key], key).toBeDefined();
  });

  it('no row, group or option in the window has hard-coded text', () => {
    // Titles, subtitles and descriptions all come from s(...) / pt(...).
    expect(prefsTs).not.toMatch(/\b(title|subtitle|description): '/);
    expect(prefsTs).not.toMatch(/\b(title|subtitle|description): `/);
    expect(prefsTs).not.toMatch(/add_response\('ok', '/);
  });

  it('the window rebuilds itself when the language changes', () => {
    expect(prefsTs).toMatch(/settings\.connect\(`changed::\$\{LANGUAGE_KEY\}`/);
    expect(prefsTs).toContain('resolveLang(settings.get_string(LANGUAGE_KEY))');
  });
});

describe('pt', () => {
  it('fills placeholders and falls back to English, then the key', () => {
    expect(pt('ru', 'subtaskLevelsApplied', { n: 2 })).toBe('Уровней вложенности теперь 2');
    expect(pt('en', 'subtaskLevelsApplied', { n: 2 })).toBe('Nesting levels set to 2');
    expect(pt('en', 'no-such-key')).toBe('no-such-key');
    expect(pt('en', 'subtaskLevelsApplied')).toContain('{n}');
  });

  it('resolves the language setting', () => {
    expect(resolveLang('ru')).toBe('ru');
    expect(resolveLang('en')).toBe('en');
    expect(resolveLang('')).toBe('en');
    expect(resolveLang('de')).toBe('en');
  });
});

describe('plurals', () => {
  it('russian one/few/many', () => {
    const forms = ['уровень', 'уровня', 'уровней'];
    expect([1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 111].map(n => pluralForm('ru', n, forms))).toEqual([
      'уровень',
      'уровня',
      'уровня',
      'уровня',
      'уровней',
      'уровней',
      'уровней',
      'уровней',
      'уровень',
      'уровня',
      'уровней',
      'уровней',
    ]);
  });

  it('english singular/plural', () => {
    expect(levelWord('en', 1)).toBe('level');
    expect(levelWord('en', 3)).toBe('levels');
  });
});

describe('nesting messages follow the language', () => {
  const offenders = [{ listTitle: 'Работа', path: ['Родитель', '', 'Внук'], level: 3 }];

  it('russian rejection', () => {
    const message = describeLevelsProblem(buildRejection('r', 2, offenders), 3, 'ru')!;
    expect(message.heading).toBe('Подзадачи вложены слишком глубоко');
    expect(message.body).toContain('вложены на 3 уровня');
    expect(message.body).toContain('Работа: Родитель › (без названия) › Внук');
  });

  it('english rejection', () => {
    const message = describeLevelsProblem(buildRejection('r', 2, offenders), 3, 'en')!;
    expect(message.body).toContain('nested 3 levels deep');
    expect(message.body).toContain('(untitled)');
  });

  it('russian failure and timeout', () => {
    expect(describeLevelsProblem({ id: 'r', status: 'failed', levels: 2, failedLists: ['Дом'] }, 3, 'ru')!.body).toContain('Не загрузились списки: Дом.');
    expect(describeLevelsTimeout(3, 'ru').heading).toBe('Расширение не отвечает');
  });
});
