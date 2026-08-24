import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const REFRESH_INTERVAL_KEY = 'refresh-interval';
const TASK_SORT_ORDER_KEY = 'task-sort-order';
const SHOW_COMPLETED_TASKS_KEY = 'show-completed-tasks';
const SHOW_TASK_DATE_KEY = 'show-task-date';
const TASK_TIMEFRAME_KEY = 'task-timeframe';
const LANGUAGE_KEY = 'language';
const COLUMN_WIDTH_KEY = 'column-width';
const CORNER_RADIUS_KEY = 'corner-radius';
const COMPLETED_RETENTION_MINUTES_KEY = 'completed-retention-minutes';
const TITLE_FONT_SIZE_KEY = 'title-font-size';
const DESCRIPTION_FONT_SIZE_KEY = 'description-font-size';
const TASK_BLOCK_SIZE_KEY = 'task-block-size';
const SUBTASK_BLOCK_SIZE_KEY = 'subtask-block-size';
const RADIO_SIZE_KEY = 'radio-size';
const EMPTY_STATE_ICON_KEY = 'empty-state-icon';
const EMPTY_STATE_ICON_SIZE_KEY = 'empty-state-icon-size';
const EMPTY_STATE_FONT_SIZE_KEY = 'empty-state-font-size';
const EMPTY_STATE_OPACITY_KEY = 'empty-state-opacity';

const SORT_OPTIONS = [
  { id: 'my-order', label: 'My order' },
  { id: 'date', label: 'Date' },
  { id: 'deadline', label: 'Deadline' },
  { id: 'starred-recently', label: 'Starred recently' },
  { id: 'title', label: 'Title' },
];

const TIMEFRAME_OPTIONS = [
  { id: 'all', label: 'All tasks' },
  { id: 'today', label: 'Today' },
  { id: 'this-week', label: 'This week' },
  { id: 'this-month', label: 'This month' },
];

const LANGUAGE_OPTIONS = [
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
];

export default class GoogleTasksPreferences extends ExtensionPreferences {
  async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
      title: 'General',
    });

    const refreshIntervalRow = new Adw.SpinRow({
      title: 'Refresh interval',
      subtitle: 'How often to sync tasks (seconds). Each sync costs one request per task list plus one, against a Google Tasks quota of 50,000 requests per day — at 5 seconds and three lists that is already over the limit.',
      adjustment: new Gtk.Adjustment({
        lower: 5,
        upper: 3600,
        step_increment: 5,
        page_increment: 30,
      }),
      digits: 0,
      numeric: true,
    });

    settings.bind(REFRESH_INTERVAL_KEY, refreshIntervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const sortRow = new Adw.ComboRow({
      title: 'Sort by',
      model: Gtk.StringList.new(SORT_OPTIONS.map(option => option.label)),
    });

    const currentSortOrder = settings.get_string(TASK_SORT_ORDER_KEY);
    const currentSortOrderIndex = Math.max(0, SORT_OPTIONS.findIndex(option => option.id === currentSortOrder));
    sortRow.selected = currentSortOrderIndex;

    sortRow.connect('notify::selected', () => {
      const selectedOption = SORT_OPTIONS[sortRow.selected];
      if (selectedOption)
        settings.set_string(TASK_SORT_ORDER_KEY, selectedOption.id);
    });

    const showCompletedRow = new Adw.SwitchRow({
      title: 'Show completed tasks',
      subtitle: 'Display a collapsible section for completed tasks in the panel.',
    });

    settings.bind(SHOW_COMPLETED_TASKS_KEY, showCompletedRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const showTaskDateRow = new Adw.SwitchRow({
      title: 'Show task date',
      subtitle: 'Show when each task was created next to its title, or when it was completed in the completed section.',
    });

    settings.bind(SHOW_TASK_DATE_KEY, showTaskDateRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const timeframeRow = new Adw.ComboRow({
      title: 'Timeframe',
      subtitle: 'Show tasks due within the selected range.',
      model: Gtk.StringList.new(TIMEFRAME_OPTIONS.map(option => option.label)),
    });

    const currentTimeframe = settings.get_string(TASK_TIMEFRAME_KEY);
    const currentTimeframeIndex = Math.max(0, TIMEFRAME_OPTIONS.findIndex(option => option.id === currentTimeframe));
    timeframeRow.selected = currentTimeframeIndex;

    timeframeRow.connect('notify::selected', () => {
      const selectedOption = TIMEFRAME_OPTIONS[timeframeRow.selected];
      if (selectedOption)
        settings.set_string(TASK_TIMEFRAME_KEY, selectedOption.id);
    });

    const languageRow = new Adw.ComboRow({
      title: 'Language',
      subtitle: 'Language used for the extension\'s own interface text (labels, buttons, placeholder messages). Does not translate your task content.',
      model: Gtk.StringList.new(LANGUAGE_OPTIONS.map(option => option.label)),
    });

    const currentLanguage = settings.get_string(LANGUAGE_KEY);
    const currentLanguageIndex = Math.max(0, LANGUAGE_OPTIONS.findIndex(option => option.id === currentLanguage));
    languageRow.selected = currentLanguageIndex;

    languageRow.connect('notify::selected', () => {
      const selectedOption = LANGUAGE_OPTIONS[languageRow.selected];
      if (selectedOption)
        settings.set_string(LANGUAGE_KEY, selectedOption.id);
    });

    group.add(refreshIntervalRow);
    group.add(sortRow);
    group.add(showCompletedRow);
    group.add(showTaskDateRow);
    group.add(timeframeRow);
    group.add(languageRow);
    page.add(group);

    const appearanceGroup = new Adw.PreferencesGroup({
      title: 'Appearance',
    });

    const columnWidthRow = new Adw.SpinRow({
      title: 'Column width',
      subtitle: 'Width in pixels of the Google Tasks column in the calendar popup.',
      adjustment: new Gtk.Adjustment({
        lower: 300,
        upper: 800,
        step_increment: 10,
        page_increment: 50,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(COLUMN_WIDTH_KEY, columnWidthRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const cornerRadiusRow = new Adw.SpinRow({
      title: 'Corner radius',
      subtitle: 'Rounding in pixels for colored task rows and their edit form.',
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 24,
        step_increment: 1,
        page_increment: 4,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(CORNER_RADIUS_KEY, cornerRadiusRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    appearanceGroup.add(columnWidthRow);
    appearanceGroup.add(cornerRadiusRow);
    page.add(appearanceGroup);

    const typographyGroup = new Adw.PreferencesGroup({
      title: 'Typography',
    });

    const titleFontSizeRow = new Adw.SpinRow({
      title: 'Title font size',
      subtitle: 'Font size in pixels for task and subtask titles.',
      adjustment: new Gtk.Adjustment({
        lower: 8,
        upper: 24,
        step_increment: 1,
        page_increment: 2,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(TITLE_FONT_SIZE_KEY, titleFontSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const descriptionFontSizeRow = new Adw.SpinRow({
      title: 'Description font size',
      subtitle: 'Font size in pixels for task and subtask descriptions.',
      adjustment: new Gtk.Adjustment({
        lower: 8,
        upper: 20,
        step_increment: 1,
        page_increment: 2,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(DESCRIPTION_FONT_SIZE_KEY, descriptionFontSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const taskBlockSizeRow = new Adw.SpinRow({
      title: 'Task block size',
      subtitle: 'Vertical padding in pixels for top-level task rows.',
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 16,
        step_increment: 1,
        page_increment: 2,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(TASK_BLOCK_SIZE_KEY, taskBlockSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const subtaskBlockSizeRow = new Adw.SpinRow({
      title: 'Subtask block size',
      subtitle: 'Vertical padding in pixels for subtask rows.',
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 16,
        step_increment: 1,
        page_increment: 2,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(SUBTASK_BLOCK_SIZE_KEY, subtaskBlockSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const radioSizeRow = new Adw.SpinRow({
      title: 'Checkmark circle size',
      subtitle: 'Width and height in pixels of the completion circle for leaf tasks and subtasks.',
      adjustment: new Gtk.Adjustment({
        lower: 8,
        upper: 24,
        step_increment: 1,
        page_increment: 2,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(RADIO_SIZE_KEY, radioSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    typographyGroup.add(titleFontSizeRow);
    typographyGroup.add(descriptionFontSizeRow);
    typographyGroup.add(taskBlockSizeRow);
    typographyGroup.add(subtaskBlockSizeRow);
    typographyGroup.add(radioSizeRow);
    page.add(typographyGroup);

    const emptyStateGroup = new Adw.PreferencesGroup({
      title: 'Empty state',
      description: 'Shown when the selected list has no tasks.',
    });

    const emptyStateIconRow = new Adw.EntryRow({
      title: 'Icon name',
    });
    settings.bind(EMPTY_STATE_ICON_KEY, emptyStateIconRow, 'text', Gio.SettingsBindFlags.DEFAULT);

    const emptyStateIconSizeRow = new Adw.SpinRow({
      title: 'Icon size',
      subtitle: 'Size in pixels of the icon.',
      adjustment: new Gtk.Adjustment({
        lower: 24,
        upper: 128,
        step_increment: 4,
        page_increment: 16,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(EMPTY_STATE_ICON_SIZE_KEY, emptyStateIconSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const emptyStateFontSizeRow = new Adw.SpinRow({
      title: 'Text size',
      subtitle: 'Font size in pixels of the message.',
      adjustment: new Gtk.Adjustment({
        lower: 8,
        upper: 24,
        step_increment: 1,
        page_increment: 2,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(EMPTY_STATE_FONT_SIZE_KEY, emptyStateFontSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const emptyStateOpacityRow = new Adw.SpinRow({
      title: 'Opacity',
      subtitle: 'Opacity percentage for both the icon and the text.',
      adjustment: new Gtk.Adjustment({
        lower: 10,
        upper: 100,
        step_increment: 5,
        page_increment: 10,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(EMPTY_STATE_OPACITY_KEY, emptyStateOpacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    emptyStateGroup.add(emptyStateIconRow);
    emptyStateGroup.add(emptyStateIconSizeRow);
    emptyStateGroup.add(emptyStateFontSizeRow);
    emptyStateGroup.add(emptyStateOpacityRow);
    page.add(emptyStateGroup);

    const retentionGroup = new Adw.PreferencesGroup({
      title: 'Completed tasks',
    });

    const retentionRow = new Adw.SpinRow({
      title: 'Auto-delete after (minutes)',
      subtitle: 'Delete a task this many minutes after it\'s marked completed. 0 disables auto-deletion.',
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 43200,
        step_increment: 5,
        page_increment: 60,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(COMPLETED_RETENTION_MINUTES_KEY, retentionRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    retentionGroup.add(retentionRow);
    page.add(retentionGroup);

    window.add(page);
  }
}