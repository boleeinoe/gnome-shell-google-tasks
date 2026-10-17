// Text of the preferences window, in every interface language. The window
// follows the extension's own "language" setting (not the system locale),
// and rebuilds itself when that setting changes. Pure, so the tests check
// that both languages carry the same keys and that every key used exists.
import type { Lang } from './i18n.js';

export const PREFS_STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    groupGeneral: 'General',
    refreshInterval: 'Refresh interval',
    refreshIntervalHint: 'How often to sync tasks (seconds). Each sync costs one request per task list plus one, against a Google Tasks quota of 50,000 requests per day — at 5 seconds and three lists that is already over the limit.',
    sortBy: 'Sort by',
    sortMyOrder: 'My order',
    sortDate: 'Date',
    sortDeadline: 'Deadline',
    sortStarredRecently: 'Starred recently',
    sortTitle: 'Title',
    showCompleted: 'Show completed tasks',
    showCompletedHint: 'Display a collapsible section for completed tasks in the panel.',
    showTaskDate: 'Show task date',
    showTaskDateHint: 'Show when each task was created next to its title, or when it was completed in the completed section.',
    timeframe: 'Timeframe',
    timeframeHint: 'Show tasks due within the selected range.',
    timeframeAll: 'All tasks',
    timeframeToday: 'Today',
    timeframeWeek: 'This week',
    timeframeMonth: 'This month',
    language: 'Language',
    languageHint: 'Language of the extension\'s interface and of these settings. Does not translate your task content.',

    groupAppearance: 'Appearance',
    columnWidth: 'Column width',
    columnWidthHint: 'Width in pixels of the Google Tasks column in the calendar popup.',
    cornerRadius: 'Corner radius',
    cornerRadiusHint: 'Rounding in pixels for colored task rows and their edit form.',
    taskBlocks: 'Task blocks',
    taskBlocksHint: 'Draw "My tasks" and "Completed" as separate shaded blocks.',
    taskBlocksOpacity: 'Task block opacity',
    taskBlocksOpacityHint: 'Percent of the notification bubble\'s opacity: 100 looks exactly like a GNOME notification, lower is more transparent, higher more solid.',
    taskBlocksEdgeBlur: 'Task block edge blur',
    taskBlocksEdgeBlurHint: 'How soft the edge of the blocks and the list picker is, in pixels. 0 draws a crisp 1px outline.',
    listMenuVisibleLists: 'Visible task lists',
    listMenuVisibleListsHint: 'How many task lists the list picker shows before it starts scrolling.',

    groupTypography: 'Typography',
    titleFontSize: 'Title font size',
    titleFontSizeHint: 'Font size in pixels for task and subtask titles.',
    descriptionFontSize: 'Description font size',
    descriptionFontSizeHint: 'Font size in pixels for task and subtask descriptions.',
    taskBlockSize: 'Task row padding',
    taskBlockSizeHint: 'Vertical padding in pixels for top-level task rows.',
    subtaskBlockSize: 'Subtask row padding',
    subtaskBlockSizeHint: 'Vertical padding in pixels for subtask rows.',
    radioSize: 'Checkmark circle size',
    radioSizeHint: 'Width and height in pixels of the completion circle for tasks.',
    subtaskRadioSize: 'Subtask checkmark circle size',
    subtaskRadioSizeHint: 'Width and height in pixels of the completion circle for subtasks.',
    subtaskLevels: 'Task nesting levels',
    subtaskLevelsHint: '2: task and subtask. 3: a subtask can have its own subtasks.',
    subtaskLevelsChecking: 'Checking every task list for deeper subtasks…',
    subtaskLevelsApplied: 'Nesting levels set to {n}',

    groupEmptyState: 'Empty state',
    groupEmptyStateHint: 'Shown when the selected list has no tasks.',
    emptyStateIconSize: 'Icon size',
    emptyStateIconSizeHint: 'Size in pixels of the icon.',
    emptyStateFontSize: 'Text size',
    emptyStateFontSizeHint: 'Font size in pixels of the message.',
    emptyStateOpacity: 'Opacity',
    emptyStateOpacityHint: 'Opacity percentage for both the icon and the text.',

    groupCompleted: 'Completed tasks',
    retention: 'Auto-delete after (minutes)',
    retentionHint: 'Delete a task this many minutes after it\'s marked completed. 0 disables auto-deletion.',

    ok: 'OK',
    untitled: '(untitled)',
    tooDeepHeading: 'Subtasks are nested too deep',
    tooDeepBody: 'Some tasks are nested {deepest} {levelWord} deep, so the limit can\'t be lowered to {levels}. Move these subtasks up a level or delete them first, then try again. The limit stays at {current}.',
    tooDeepMore: '…and {n} more',
    checkFailedHeading: 'Couldn\'t check every task list',
    checkFailedLists: 'These task lists didn\'t load: {lists}.',
    checkFailedUnreachable: 'Google Tasks couldn\'t be reached.',
    checkFailedUnreachableDetail: 'Google Tasks couldn\'t be reached ({detail}).',
    checkFailedBody: '{reason} Every list has to be checked before the limit can be lowered, so it stays at {current}. Try again in a moment.',
    timeoutHeading: 'No answer from the extension',
    timeoutBody: 'Task lists are checked by the extension itself. Make sure it\'s enabled and online, then try again. The limit stays at {current}.',
  },
  ru: {
    groupGeneral: 'Основные',
    refreshInterval: 'Интервал обновления',
    refreshIntervalHint: 'Как часто синхронизировать задачи, в секундах. Каждая синхронизация — это один запрос на каждый список задач и ещё один сверху, а квота Google Tasks — 50 000 запросов в сутки: при 5 секундах и трёх списках она уже превышена.',
    sortBy: 'Сортировка',
    sortMyOrder: 'Мой порядок',
    sortDate: 'Дата',
    sortDeadline: 'Срок',
    sortStarredRecently: 'Недавно отмеченные',
    sortTitle: 'Название',
    showCompleted: 'Показывать выполненные задачи',
    showCompletedHint: 'Сворачиваемый раздел с выполненными задачами на панели.',
    showTaskDate: 'Показывать дату задачи',
    showTaskDateHint: 'Рядом с названием — когда задача создана, а в разделе выполненных — когда она выполнена.',
    timeframe: 'Период',
    timeframeHint: 'Показывать задачи со сроком в выбранном периоде.',
    timeframeAll: 'Все задачи',
    timeframeToday: 'Сегодня',
    timeframeWeek: 'Эта неделя',
    timeframeMonth: 'Этот месяц',
    language: 'Язык',
    languageHint: 'Язык интерфейса расширения и этих настроек. Сами задачи не переводятся.',

    groupAppearance: 'Внешний вид',
    columnWidth: 'Ширина колонки',
    columnWidthHint: 'Ширина колонки Google Tasks во всплывающем календаре, в пикселях.',
    cornerRadius: 'Скругление углов',
    cornerRadiusHint: 'Скругление цветных строк задач и их формы редактирования, в пикселях.',
    taskBlocks: 'Блоки задач',
    taskBlocksHint: 'Рисовать «Мои задачи» и «Выполненные» отдельными затенёнными блоками.',
    taskBlocksOpacity: 'Непрозрачность блоков',
    taskBlocksOpacityHint: 'В процентах от непрозрачности уведомления: 100 — точно как уведомление GNOME, меньше — прозрачнее, больше — плотнее.',
    taskBlocksEdgeBlur: 'Размытие края блоков',
    taskBlocksEdgeBlurHint: 'Насколько мягкий край у блоков и у меню списков, в пикселях. 0 — чёткая линия толщиной 1 пиксель.',
    listMenuVisibleLists: 'Видимых списков задач',
    listMenuVisibleListsHint: 'Сколько списков задач помещается в меню выбора списка, прежде чем появится прокрутка.',

    groupTypography: 'Текст и размеры',
    titleFontSize: 'Размер шрифта названия',
    titleFontSizeHint: 'Размер шрифта названий задач и подзадач, в пикселях.',
    descriptionFontSize: 'Размер шрифта описания',
    descriptionFontSizeHint: 'Размер шрифта описаний задач и подзадач, в пикселях.',
    taskBlockSize: 'Отступ строки задачи',
    taskBlockSizeHint: 'Вертикальный отступ строк задач верхнего уровня, в пикселях.',
    subtaskBlockSize: 'Отступ строки подзадачи',
    subtaskBlockSizeHint: 'Вертикальный отступ строк подзадач, в пикселях.',
    radioSize: 'Размер кружка отметки',
    radioSizeHint: 'Ширина и высота кружка выполнения у задач, в пикселях.',
    subtaskRadioSize: 'Размер кружка у подзадач',
    subtaskRadioSizeHint: 'Ширина и высота кружка выполнения у подзадач, в пикселях.',
    subtaskLevels: 'Уровни вложенности',
    subtaskLevelsHint: '2 — задача и подзадача. 3 — у подзадачи могут быть свои подзадачи.',
    subtaskLevelsChecking: 'Проверяю все списки задач на более глубокие подзадачи…',
    subtaskLevelsApplied: 'Уровней вложенности теперь {n}',

    groupEmptyState: 'Пустой список',
    groupEmptyStateHint: 'Показывается, когда в выбранном списке нет задач.',
    emptyStateIconSize: 'Размер значка',
    emptyStateIconSizeHint: 'Размер значка в пикселях.',
    emptyStateFontSize: 'Размер текста',
    emptyStateFontSizeHint: 'Размер шрифта сообщения, в пикселях.',
    emptyStateOpacity: 'Непрозрачность',
    emptyStateOpacityHint: 'Непрозрачность значка и текста, в процентах.',

    groupCompleted: 'Выполненные задачи',
    retention: 'Удалять через (минут)',
    retentionHint: 'Удалять задачу через столько минут после выполнения. 0 — не удалять.',

    ok: 'ОК',
    untitled: '(без названия)',
    tooDeepHeading: 'Подзадачи вложены слишком глубоко',
    tooDeepBody: 'Некоторые задачи вложены на {deepest} {levelWord}, поэтому уровень нельзя снизить до {levels}. Сначала поднимите эти подзадачи на уровень выше или удалите их, затем попробуйте снова. Пока остаётся {current}.',
    tooDeepMore: '…и ещё {n}',
    checkFailedHeading: 'Не удалось проверить все списки задач',
    checkFailedLists: 'Не загрузились списки: {lists}.',
    checkFailedUnreachable: 'Не удалось связаться с Google Tasks.',
    checkFailedUnreachableDetail: 'Не удалось связаться с Google Tasks ({detail}).',
    checkFailedBody: '{reason} Перед снижением уровня нужно проверить все списки, поэтому он остаётся {current}. Попробуйте ещё раз чуть позже.',
    timeoutHeading: 'Расширение не отвечает',
    timeoutBody: 'Списки задач проверяет само расширение. Убедитесь, что оно включено и есть сеть, затем попробуйте снова. Уровень вложенности остаётся {current}.',
  },
};

// Word forms for counted nouns: English singular/plural, Russian one/few/many.
const LEVEL_WORDS: Record<Lang, string[]> = {
  en: ['level', 'levels'],
  ru: ['уровень', 'уровня', 'уровней'],
};

export function pluralForm(lang: Lang, n: number, forms: string[]): string {
  if (lang === 'ru') {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11)
      return forms[0];
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
      return forms[1];
    return forms[2];
  }
  return n === 1 ? forms[0] : forms[1];
}

export function levelWord(lang: Lang, n: number): string {
  return pluralForm(lang, n, LEVEL_WORDS[lang]);
}

// The 'language' setting as a Lang; anything unknown falls back to English.
export function resolveLang(value: string): Lang {
  return value === 'ru' ? 'ru' : 'en';
}

// A preferences string with {name} placeholders filled in. Falls back to
// English, then to the key itself.
export function pt(lang: Lang, key: string, params: Record<string, string | number> = {}): string {
  const text = PREFS_STRINGS[lang]?.[key] ?? PREFS_STRINGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match);
}
