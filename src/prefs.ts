import type { Lang } from './i18n.js';
import type { LevelsMessage } from './nestingCheck.js';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
  describeLevelsProblem,
  describeLevelsTimeout,
  LEVELS_CHECK_TIMEOUT_SECONDS,
  parseLevelsResult,
  serializeLevelsRequest,
} from './nestingCheck.js';
import { pt, resolveLang } from './prefsStrings.js';
import {
  COLUMN_WIDTH_KEY,
  COMPLETED_RETENTION_MINUTES_KEY,
  CORNER_RADIUS_KEY,
  DESCRIPTION_FONT_SIZE_KEY,
  EMPTY_STATE_FONT_SIZE_KEY,
  EMPTY_STATE_ICON_KEY,
  EMPTY_STATE_ICON_SIZE_KEY,
  EMPTY_STATE_OPACITY_KEY,
  LANGUAGE_KEY,
  RADIO_SIZE_KEY,
  REFRESH_INTERVAL_KEY,
  SHOW_COMPLETED_TASKS_KEY,
  SHOW_TASK_DATE_KEY,
  SUBTASK_BLOCK_SIZE_KEY,
  SUBTASK_LEVELS_KEY,
  SUBTASK_LEVELS_REQUEST_KEY,
  SUBTASK_LEVELS_RESULT_KEY,
  SUBTASK_RADIO_SIZE_KEY,
  TASK_BLOCK_SIZE_KEY,
  TASK_BLOCKS_EDGE_BLUR_KEY,
  TASK_BLOCKS_ENABLED_KEY,
  TASK_BLOCKS_OPACITY_KEY,
  TASK_SORT_ORDER_KEY,
  TASK_TIMEFRAME_KEY,
  TITLE_FONT_SIZE_KEY,
} from './settings.js';
import { MAX_SUBTASK_LEVELS, MIN_SUBTASK_LEVELS } from './taskTree.js';

// Option ids (stored in GSettings) and the keys of their labels in
// prefsStrings.ts.
const SORT_OPTIONS = [
  { id: 'my-order', label: 'sortMyOrder' },
  { id: 'date', label: 'sortDate' },
  { id: 'deadline', label: 'sortDeadline' },
  { id: 'starred-recently', label: 'sortStarredRecently' },
  { id: 'title', label: 'sortTitle' },
];

const TIMEFRAME_OPTIONS = [
  { id: 'all', label: 'timeframeAll' },
  { id: 'today', label: 'timeframeToday' },
  { id: 'this-week', label: 'timeframeWeek' },
  { id: 'this-month', label: 'timeframeMonth' },
];

// Each language is named in itself, so it can be found whatever the
// current language is.
const LANGUAGE_OPTIONS = [
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
];

interface BuiltPage {
  page: Adw.PreferencesPage;
  // Disconnects whatever the page connected to the settings by hand.
  dispose: () => void;
}

export default class GoogleTasksPreferences extends ExtensionPreferences {
  // The window speaks the extension's interface language. Changing the
  // language rebuilds the page in place, so the switch is immediate.
  async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const settings = this.getSettings();
    let current: BuiltPage | null = null;

    const build = () => {
      const next = this._buildPage(window, settings, resolveLang(settings.get_string(LANGUAGE_KEY)));
      if (current) {
        current.dispose();
        window.remove(current.page);
      }
      window.add(next.page);
      window.set_visible_page(next.page);
      current = next;
    };
    build();

    // Deferred: the change comes from the language row itself, which the
    // rebuild destroys — not from inside its own signal handler.
    let rebuildId = 0;
    const languageId = settings.connect(`changed::${LANGUAGE_KEY}`, () => {
      if (rebuildId)
        return;
      rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        rebuildId = 0;
        build();
        return GLib.SOURCE_REMOVE;
      });
    });

    window.connect('close-request', () => {
      settings.disconnect(languageId);
      if (rebuildId)
        GLib.source_remove(rebuildId);
      rebuildId = 0;
      current?.dispose();
      current = null;
      return false;
    });
  }

  private _buildPage(window: Adw.PreferencesWindow, settings: Gio.Settings, lang: Lang): BuiltPage {
    const s = (key: string, params?: Record<string, string | number>) => pt(lang, key, params);

    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
      title: s('groupGeneral'),
    });

    const refreshIntervalRow = new Adw.SpinRow({
      title: s('refreshInterval'),
      subtitle: s('refreshIntervalHint'),
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
      title: s('sortBy'),
      model: Gtk.StringList.new(SORT_OPTIONS.map(option => s(option.label))),
    });
    const currentSortOrder = settings.get_string(TASK_SORT_ORDER_KEY);
    sortRow.selected = Math.max(0, SORT_OPTIONS.findIndex(option => option.id === currentSortOrder));
    sortRow.connect('notify::selected', () => {
      const selectedOption = SORT_OPTIONS[sortRow.selected];
      if (selectedOption)
        settings.set_string(TASK_SORT_ORDER_KEY, selectedOption.id);
    });

    const showCompletedRow = new Adw.SwitchRow({
      title: s('showCompleted'),
      subtitle: s('showCompletedHint'),
    });
    settings.bind(SHOW_COMPLETED_TASKS_KEY, showCompletedRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const showTaskDateRow = new Adw.SwitchRow({
      title: s('showTaskDate'),
      subtitle: s('showTaskDateHint'),
    });
    settings.bind(SHOW_TASK_DATE_KEY, showTaskDateRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const timeframeRow = new Adw.ComboRow({
      title: s('timeframe'),
      subtitle: s('timeframeHint'),
      model: Gtk.StringList.new(TIMEFRAME_OPTIONS.map(option => s(option.label))),
    });
    const currentTimeframe = settings.get_string(TASK_TIMEFRAME_KEY);
    timeframeRow.selected = Math.max(0, TIMEFRAME_OPTIONS.findIndex(option => option.id === currentTimeframe));
    timeframeRow.connect('notify::selected', () => {
      const selectedOption = TIMEFRAME_OPTIONS[timeframeRow.selected];
      if (selectedOption)
        settings.set_string(TASK_TIMEFRAME_KEY, selectedOption.id);
    });

    const languageRow = new Adw.ComboRow({
      title: s('language'),
      subtitle: s('languageHint'),
      model: Gtk.StringList.new(LANGUAGE_OPTIONS.map(option => option.label)),
    });
    languageRow.selected = Math.max(0, LANGUAGE_OPTIONS.findIndex(option => option.id === lang));
    languageRow.connect('notify::selected', () => {
      const selectedOption = LANGUAGE_OPTIONS[languageRow.selected];
      if (selectedOption && selectedOption.id !== settings.get_string(LANGUAGE_KEY))
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
      title: s('groupAppearance'),
    });

    const columnWidthRow = new Adw.SpinRow({
      title: s('columnWidth'),
      subtitle: s('columnWidthHint'),
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
      title: s('cornerRadius'),
      subtitle: s('cornerRadiusHint'),
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

    const taskBlocksRow = new Adw.SwitchRow({
      title: s('taskBlocks'),
      subtitle: s('taskBlocksHint'),
    });
    settings.bind(TASK_BLOCKS_ENABLED_KEY, taskBlocksRow, 'active', Gio.SettingsBindFlags.DEFAULT);

    const taskBlocksOpacityRow = new Adw.SpinRow({
      title: s('taskBlocksOpacity'),
      subtitle: s('taskBlocksOpacityHint'),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 300,
        step_increment: 5,
        page_increment: 25,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(TASK_BLOCKS_OPACITY_KEY, taskBlocksOpacityRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    settings.bind(TASK_BLOCKS_ENABLED_KEY, taskBlocksOpacityRow, 'sensitive', Gio.SettingsBindFlags.GET);

    const taskBlocksEdgeBlurRow = new Adw.SpinRow({
      title: s('taskBlocksEdgeBlur'),
      subtitle: s('taskBlocksEdgeBlurHint'),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 24,
        step_increment: 1,
        page_increment: 4,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(TASK_BLOCKS_EDGE_BLUR_KEY, taskBlocksEdgeBlurRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    appearanceGroup.add(columnWidthRow);
    appearanceGroup.add(cornerRadiusRow);
    appearanceGroup.add(taskBlocksRow);
    appearanceGroup.add(taskBlocksOpacityRow);
    appearanceGroup.add(taskBlocksEdgeBlurRow);
    page.add(appearanceGroup);

    const typographyGroup = new Adw.PreferencesGroup({
      title: s('groupTypography'),
    });

    const titleFontSizeRow = new Adw.SpinRow({
      title: s('titleFontSize'),
      subtitle: s('titleFontSizeHint'),
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
      title: s('descriptionFontSize'),
      subtitle: s('descriptionFontSizeHint'),
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
      title: s('taskBlockSize'),
      subtitle: s('taskBlockSizeHint'),
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
      title: s('subtaskBlockSize'),
      subtitle: s('subtaskBlockSizeHint'),
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
      title: s('radioSize'),
      subtitle: s('radioSizeHint'),
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

    const subtaskRadioSizeRow = new Adw.SpinRow({
      title: s('subtaskRadioSize'),
      subtitle: s('subtaskRadioSizeHint'),
      adjustment: new Gtk.Adjustment({
        lower: 6,
        upper: 24,
        step_increment: 1,
        page_increment: 2,
      }),
      digits: 0,
      numeric: true,
    });
    settings.bind(SUBTASK_RADIO_SIZE_KEY, subtaskRadioSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);

    const subtaskLevels = this._buildSubtaskLevelsRow(window, settings, lang);

    typographyGroup.add(titleFontSizeRow);
    typographyGroup.add(descriptionFontSizeRow);
    typographyGroup.add(taskBlockSizeRow);
    typographyGroup.add(subtaskBlockSizeRow);
    typographyGroup.add(radioSizeRow);
    typographyGroup.add(subtaskRadioSizeRow);
    typographyGroup.add(subtaskLevels.row);
    page.add(typographyGroup);

    const emptyStateGroup = new Adw.PreferencesGroup({
      title: s('groupEmptyState'),
      description: s('groupEmptyStateHint'),
    });

    const emptyStateIconRow = new Adw.EntryRow({
      title: s('emptyStateIcon'),
    });
    settings.bind(EMPTY_STATE_ICON_KEY, emptyStateIconRow, 'text', Gio.SettingsBindFlags.DEFAULT);

    const emptyStateIconSizeRow = new Adw.SpinRow({
      title: s('emptyStateIconSize'),
      subtitle: s('emptyStateIconSizeHint'),
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
      title: s('emptyStateFontSize'),
      subtitle: s('emptyStateFontSizeHint'),
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
      title: s('emptyStateOpacity'),
      subtitle: s('emptyStateOpacityHint'),
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
      title: s('groupCompleted'),
    });

    const retentionRow = new Adw.SpinRow({
      title: s('retention'),
      subtitle: s('retentionHint'),
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

    return { page, dispose: subtaskLevels.dispose };
  }

  // Not bound to the key like the other rows: raising the limit is applied
  // at once, but lowering it is only a request. The extension checks every
  // task list and applies it only if no subtask is nested deeper than the
  // new limit; otherwise the row goes back and a dialog lists the tasks to
  // fix first. See nestingCheck.ts.
  private _buildSubtaskLevelsRow(window: Adw.PreferencesWindow, settings: Gio.Settings, lang: Lang): { row: Adw.SpinRow; dispose: () => void } {
    const subtitle = pt(lang, 'subtaskLevelsHint');
    const row = new Adw.SpinRow({
      title: pt(lang, 'subtaskLevels'),
      subtitle,
      adjustment: new Gtk.Adjustment({
        lower: MIN_SUBTASK_LEVELS,
        upper: MAX_SUBTASK_LEVELS,
        step_increment: 1,
        page_increment: 1,
      }),
      digits: 0,
      numeric: true,
      value: settings.get_int(SUBTASK_LEVELS_KEY),
    });

    let syncing = false;
    let pending: { id: string; timerId: number } | null = null;

    const showRow = (value: number) => {
      syncing = true;
      row.value = value;
      syncing = false;
    };
    const endPending = () => {
      if (!pending)
        return;
      if (pending.timerId)
        GLib.source_remove(pending.timerId);
      pending = null;
      row.sensitive = true;
      row.subtitle = subtitle;
    };
    const showProblem = ({ heading, body }: LevelsMessage) => {
      const dialog = new Adw.AlertDialog({ heading, body });
      dialog.add_response('ok', pt(lang, 'ok'));
      dialog.present(window);
    };

    row.connect('notify::value', () => {
      if (syncing || pending)
        return;
      const wanted = Math.round(row.value);
      const current = settings.get_int(SUBTASK_LEVELS_KEY);
      if (wanted === current)
        return;
      if (wanted > current) {
        // Nothing can be nested too deep under a higher limit.
        settings.set_int(SUBTASK_LEVELS_KEY, wanted);
        return;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LEVELS_CHECK_TIMEOUT_SECONDS, () => {
        if (pending?.id === id) {
          pending.timerId = 0;
          endPending();
          const limit = settings.get_int(SUBTASK_LEVELS_KEY);
          showRow(limit);
          showProblem(describeLevelsTimeout(limit, lang));
        }
        return GLib.SOURCE_REMOVE;
      });
      pending = { id, timerId };
      row.sensitive = false;
      row.subtitle = pt(lang, 'subtaskLevelsChecking');
      settings.set_string(SUBTASK_LEVELS_REQUEST_KEY, serializeLevelsRequest({ id, levels: wanted }));
    });

    const resultId = settings.connect(`changed::${SUBTASK_LEVELS_RESULT_KEY}`, () => {
      const result = parseLevelsResult(settings.get_string(SUBTASK_LEVELS_RESULT_KEY));
      if (!result || !pending || result.id !== pending.id)
        return;
      endPending();
      const limit = settings.get_int(SUBTASK_LEVELS_KEY);
      showRow(limit);
      const problem = describeLevelsProblem(result, limit, lang);
      if (problem)
        showProblem(problem);
      else
        window.add_toast(new Adw.Toast({ title: pt(lang, 'subtaskLevelsApplied', { n: limit }), timeout: 3 }));
    });
    // Changed elsewhere (or applied by the extension): follow it, unless a
    // check is in progress — its result decides what the row shows.
    const levelsId = settings.connect(`changed::${SUBTASK_LEVELS_KEY}`, () => {
      if (!pending)
        showRow(settings.get_int(SUBTASK_LEVELS_KEY));
    });

    let disposed = false;
    const dispose = () => {
      if (disposed)
        return;
      disposed = true;
      settings.disconnect(resultId);
      settings.disconnect(levelsId);
      if (pending?.timerId)
        GLib.source_remove(pending.timerId);
      pending = null;
    };
    return { row, dispose };
  }
}
