import type { TextStrings } from './textInteraction.js';

// Interface language for the extension's own UI text (labels, buttons,
// hints, placeholder messages) — set via the 'language' GSettings key and
// the "Language" row in preferences. Does not translate task content itself,
// which comes from the user's own Google Tasks data.
export type Lang = 'en' | 'ru';

export const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    taskListsLabel: 'Task Lists',
    noTaskLists: 'No task lists',
    completed: 'Completed',
    taskTitleHint: 'Task title',
    subtaskTitleHint: 'Subtask title',
    descriptionHint: 'Description (optional)',
    cancel: 'Cancel',
    save: 'Save',
    subtaskForPrefix: 'Subtask for',
    headerTitle: 'All Tasks',
    dateMenuNotFound: 'Date menu not found',
    uncompleteParentFirst: 'Uncomplete the parent task first.',
    noTaskListsFound: 'No task lists found',
    noTasks: 'No tasks',
    color_none: 'No color',
    color_red: 'Red',
    color_orange: 'Orange',
    color_yellow: 'Yellow',
    color_green: 'Green',
    color_blue: 'Blue',
    color_purple: 'Purple',
    copy: 'Copy',
    cut: 'Cut',
    paste: 'Paste',
    selectAll: 'Select all',
    openLink: 'Open link',
    copyLink: 'Copy link',
    copyTitle: 'Copy title',
    copyDescription: 'Copy description',
    copyAll: 'Copy title and description',
    loadingTasks: 'Loading tasks…',
    tasksUnavailable: 'Tasks unavailable',
    createdPrefix: '',
    completedPrefix: 'done ',
  },
  ru: {
    taskListsLabel: 'Списки задач',
    noTaskLists: 'Нет списков задач',
    completed: 'Выполненные',
    taskTitleHint: 'Название задачи',
    subtaskTitleHint: 'Название подзадачи',
    descriptionHint: 'Описание (необязательно)',
    cancel: 'Отмена',
    save: 'Сохранить',
    subtaskForPrefix: 'Подзадача для',
    headerTitle: 'Все задачи',
    dateMenuNotFound: 'Меню даты не найдено',
    uncompleteParentFirst: 'Сначала снимите отметку с родительской задачи.',
    noTaskListsFound: 'Списки задач не найдены',
    noTasks: 'Задач нет',
    color_none: 'Без цвета',
    color_red: 'Красный',
    color_orange: 'Оранжевый',
    color_yellow: 'Жёлтый',
    color_green: 'Зелёный',
    color_blue: 'Синий',
    color_purple: 'Фиолетовый',
    copy: 'Копировать',
    cut: 'Вырезать',
    paste: 'Вставить',
    selectAll: 'Выделить всё',
    openLink: 'Открыть ссылку',
    copyLink: 'Копировать ссылку',
    copyTitle: 'Копировать название',
    copyDescription: 'Копировать описание',
    copyAll: 'Копировать название и описание',
    loadingTasks: 'Загрузка задач…',
    tasksUnavailable: 'Задачи недоступны',
    createdPrefix: '',
    completedPrefix: 'вып. ',
  },
};

export function t(lang: Lang, key: string): string {
  return STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}

// Built fresh on every call rather than captured once, so a language change
// reaches menus opened afterwards without extra wiring.
export function textStrings(lang: Lang): TextStrings {
  return {
    copy: t(lang, 'copy'),
    cut: t(lang, 'cut'),
    paste: t(lang, 'paste'),
    selectAll: t(lang, 'selectAll'),
    openLink: t(lang, 'openLink'),
    copyLink: t(lang, 'copyLink'),
  };
}
