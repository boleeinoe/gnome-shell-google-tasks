import type { Lang } from './i18n.js';
import type { LevelsResult } from './nestingCheck.js';
import type { GoogleTask, GoogleTaskList } from './tasksManager.js';
import type { TasksSectionInstance } from './tasksSection.js';
import type { TaskSortOrder, TaskTimeframe } from './taskTree.js';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
  t,
  textStrings,
} from './i18n.js';
import { buildRejection, findNestingOffenders, parseLevelsRequest, serializeLevelsResult } from './nestingCheck.js';
import { parseCreationTimes, parseTaskColors, pruneToLiveIds, serializeMap } from './persistence.js';
import {
  COLUMN_WIDTH_KEY,
  COMPLETED_RETENTION_MINUTES_KEY,
  CORNER_RADIUS_KEY,
  DEFAULT_COLUMN_WIDTH_PX,
  DEFAULT_DESCRIPTION_FONT_SIZE_PX,
  DEFAULT_EMPTY_STATE_FONT_SIZE_PX,
  DEFAULT_EMPTY_STATE_ICON,
  DEFAULT_EMPTY_STATE_ICON_SIZE_PX,
  DEFAULT_EMPTY_STATE_OPACITY_PERCENT,
  DEFAULT_SUBTASK_BLOCK_SIZE_PX,
  DEFAULT_TASK_BLOCK_SIZE_PX,
  DEFAULT_TASK_BLOCKS_EDGE_BLUR_PX,
  DEFAULT_TASK_BLOCKS_ENABLED,
  DEFAULT_TASK_BLOCKS_OPACITY_PERCENT,
  DEFAULT_TASK_COLOR_CORNER_RADIUS_PX,
  DEFAULT_TITLE_FONT_SIZE_PX,
  DESCRIPTION_FONT_SIZE_KEY,
  EMPTY_STATE_FONT_SIZE_KEY,
  EMPTY_STATE_ICON_KEY,
  EMPTY_STATE_ICON_SIZE_KEY,
  EMPTY_STATE_OPACITY_KEY,
  LANGUAGE_KEY,
  RADIO_SIZE_KEY,
  REFRESH_INTERVAL_KEY,
  REFRESH_INTERVAL_SECONDS,
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
import { GoogleTasksManager, isCancelledError } from './tasksManager.js';
import {
  PENDING_TASK_ID_PREFIX,
  TasksSection,
} from './tasksSection.js';
import {
  DEFAULT_RADIO_SIZE_PX,
  DEFAULT_SUBTASK_RADIO_SIZE_PX,
  TASK_COLOR_HEX,
} from './taskStyle.js';
import {
  buildTaskTree,
  canUncompleteTask,
  collectDescendantIds,
  DEFAULT_SUBTASK_LEVELS,
  filterTaskTreeByTimeframe,
  normalizeSubtaskLevels,
  resolveEffectiveColors,
  sortTaskTree,

  VALID_TASK_SORT_ORDERS,
  VALID_TASK_TIMEFRAMES,
} from './taskTree.js';
import {
  closeContextMenu,
  setOnContextMenuClosed,
  setupRichLabel,
} from './textInteraction.js';

// Delay before the local caches (colors, creation times) are written, so a
// burst of changes costs one write.
const CACHE_SAVE_DELAY_MS = 1000;

// Right after login, Online Accounts / network-manager / DNS can take a
// while to come up — the configured refresh-interval (20s by default) then
// means several minutes of dead air before the panel first populates,
// retrying only every 20s. Poll faster until the very first load succeeds,
// then switch to the normal cadence.
const STARTUP_RETRY_INTERVAL_SECONDS = 5;

export default class GoogleTasksExtension extends Extension {
  private _tasksSection: TasksSectionInstance | null = null;
  private _tasksManager: GoogleTasksManager | null = null;
  private _settings: Gio.Settings | null = null;
  // Every changed:: handler on this._settings, disconnected together.
  private _settingsSignalIds: number[] = [];
  // Id of the latest nesting-levels request from the preferences; a check
  // still running for an older one drops its answer.
  private _levelsRequestId: string | null = null;
  // Local caches with unsaved changes, written together (see _scheduleCacheSave()).
  private _dirtyCaches: Set<'colors' | 'times'> = new Set();
  private _cacheSaveTimerId: number | null = null;
  private _refreshTimerId: number | null = null;
  // A poll was skipped while the date menu was closed (see _startRefreshTimer()).
  private _refreshWhenShown: boolean = false;
  private _hasLoadedOnce: boolean = false;
  private _networkMonitorId: number | null = null;
  private _selectedTaskListId: string | null = null;
  private _taskLists: GoogleTaskList[] = [];
  private _activeTasksByListId: Map<string, GoogleTask[]> = new Map();
  private _completedTasksByListId: Map<string, GoogleTask[]> = new Map();
  private _columnContainer: St.BoxLayout | null = null;
  private _headerLabel: St.Label | null = null;
  private _taskColors: Map<string, string> = new Map();

  // taskId -> creation time (epoch ms). The Tasks API has `updated` and
  // `completed` but no creation timestamp, so the first sighting records
  // `updated` as the closest stand-in and everything after is our own record —
  // which is what lets the date survive a trip through the completed list.
  private _taskCreationTimes: Map<string, number> = new Map();
  private _collapsedTaskIds: Set<string> = new Set();
  private _renderDeferred: boolean = false;
  private _lastRenderSignature: string | null = null;
  private _dateMenu: any = null;
  private _menuBoxLayout: Clutter.BoxLayout | null = null;
  private _menuBoxOrientation: Clutter.Orientation | null = null;
  private _dateMenuOpenStateId: number | null = null;
  private _refreshRequestSeq: number = 0;
  private _pendingMutations: number = 0;
  private _reconcileTimerId: number | null = null;
  private _renderOnlyTimerId: number | null = null;

  // Explicit, so TypeScript doesn't synthesise one that forwards through
  // `arguments`. Extension is a plain class, unlike the GObject section
  // above, so it can simply take its argument and pass it on.
  constructor(metadata: any) {
    super(metadata);
  }

  enable() {
    this._settings = this.getSettings();
    this._tasksSection = new TasksSection();
    this._tasksSection.setLanguage(this._getLanguage());
    this._tasksManager = new GoogleTasksManager();
    this._loadTaskColors();
    this._loadTaskCreationTimes();

    const dateMenu = Main.panel.statusArea.dateMenu as any;
    if (!dateMenu) {
      Main.notify('Google Tasks Extension', this._t('dateMenuNotFound'));
      return;
    }

    // Something on screen before the first fetch returns: the panel used to
    // sit empty until the network answered.
    this._applyEmptyStateSettings();
    this._tasksSection.showEmptyState(this._t('loadingTasks'));
    this._lastRenderSignature = 'loading';

    const onAnyMenuClosed = () => {
      if (!this._renderDeferred)
        return;
      this._renderDeferred = false;
      this._renderCurrentTaskList();
    };
    this._tasksSection.setOnMenusClosed(onAnyMenuClosed);
    setOnContextMenuClosed(onAnyMenuClosed);

    if (dateMenu.menu) {
      this._dateMenuOpenStateId = dateMenu.menu.connect('open-state-changed', (_menu: any, isOpen: boolean) => {
        if (!isOpen)
          this._tasksSection?.closeAllForms();
        else if (this._refreshWhenShown && this._pendingMutations === 0)
          this._refreshTasks();
        return false;
      });
      this._dateMenu = dateMenu.menu;
    }

    const menuBox = dateMenu._box || dateMenu.menu?.box;
    if (menuBox) {
      this._columnContainer = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        // 'datemenu-calendar-column' is GNOME Shell's own class — it's
        // what draws the existing border-left between the notification
        // list and the calendar column, pulling its color/width from
        // the active shell theme. Reusing it here (instead of a custom
        // divider) makes our line pixel-identical to that one, and its
        // height naturally follows the column's own content instead of
        // stretching the full popup height.
        style_class: 'google-tasks-column datemenu-calendar-column',
      });

      this._headerLabel = new St.Label({
        text: this._t('headerTitle'),
        style_class: 'google-tasks-header',
        x_align: Clutter.ActorAlign.CENTER,
      });
      setupRichLabel(this._headerLabel, {
        getStrings: () => textStrings(this._getLanguage()),
        text: this._t('headerTitle'),
        enableLinks: false,
      });
      this._columnContainer.add_child(this._headerLabel);
      this._columnContainer.add_child(this._tasksSection);

      const children = menuBox.get_children();
      let calendarIndex = -1;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.constructor.name.includes('Calendar')
          || child.style_class?.includes('calendar')) {
          calendarIndex = i;
          break;
        }
      }

      if (calendarIndex === -1) {
        calendarIndex = 1;
      }

      menuBox.insert_child_at_index(this._columnContainer, calendarIndex + 1);

      // The date menu belongs to the shell, not to us: remember what its
      // layout looked like so disable() can hand it back unchanged.
      if (menuBox.get_layout_manager() instanceof Clutter.BoxLayout) {
        const layoutManager = menuBox.get_layout_manager() as Clutter.BoxLayout;
        this._menuBoxLayout = layoutManager;
        this._menuBoxOrientation = layoutManager.orientation;
        layoutManager.orientation = Clutter.Orientation.HORIZONTAL;
      }

      this._applyColumnWidth();
    }

    this._tasksSection.connect('add-task-clicked', (_section: any, title: string, description: string, taskListId: string, parentTaskId: string) => {
      this._onAddTask(
        title,
        description,
        taskListId || this._selectedTaskListId || undefined,
        parentTaskId || undefined,
      );
    });

    if (this._settings) {
      this._settingsSignalIds.push(this._settings.connect(`changed::${REFRESH_INTERVAL_KEY}`, () => {
        this._startRefreshTimer();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${TASK_SORT_ORDER_KEY}`, () => {
        this._renderCurrentTaskList();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${SHOW_COMPLETED_TASKS_KEY}`, () => {
        this._refreshTasks();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${SHOW_TASK_DATE_KEY}`, () => {
        this._tasksSection?.setShowTaskDate(this._getShowTaskDate());
        this._renderCurrentTaskList();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${TASK_TIMEFRAME_KEY}`, () => {
        this._renderCurrentTaskList();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${LANGUAGE_KEY}`, () => {
        this._applyLanguage();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${COLUMN_WIDTH_KEY}`, () => {
        this._applyColumnWidth();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${CORNER_RADIUS_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${TITLE_FONT_SIZE_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${DESCRIPTION_FONT_SIZE_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${TASK_BLOCK_SIZE_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${SUBTASK_BLOCK_SIZE_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${RADIO_SIZE_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${EMPTY_STATE_ICON_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${EMPTY_STATE_ICON_SIZE_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${EMPTY_STATE_FONT_SIZE_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      this._settingsSignalIds.push(this._settings.connect(`changed::${EMPTY_STATE_OPACITY_KEY}`, () => {
        this._scheduleRenderOnly();
      }));
      // A request left over from before this enable() was answered (or
      // timed out in the preferences) long ago; only new ones are handled.
      this._levelsRequestId = parseLevelsRequest(this._settings.get_string(SUBTASK_LEVELS_REQUEST_KEY))?.id ?? null;
      this._settingsSignalIds.push(this._settings.connect(`changed::${SUBTASK_LEVELS_REQUEST_KEY}`, () => {
        this._onSubtaskLevelsRequest();
      }));
      for (const key of [SUBTASK_RADIO_SIZE_KEY, SUBTASK_LEVELS_KEY]) {
        this._settingsSignalIds.push(this._settings.connect(`changed::${key}`, () => {
          this._scheduleRenderOnly();
        }));
      }
      for (const key of [TASK_BLOCKS_ENABLED_KEY, TASK_BLOCKS_OPACITY_KEY, TASK_BLOCKS_EDGE_BLUR_KEY]) {
        this._settingsSignalIds.push(this._settings.connect(`changed::${key}`, () => {
          this._applyTaskBlocks();
        }));
      }
    }
    this._applyTaskBlocks();

    this._refreshTasks();
    this._startRefreshTimer();

    // Belt-and-braces alongside the fast startup-retry cadence above:
    // react the moment the network actually comes up (Wi-Fi association,
    // VPN, DNS) instead of waiting for the next poll tick to notice.
    // Only wired up until the first successful load — after that the
    // periodic timer alone is enough.
    this._networkMonitorId = Gio.NetworkMonitor.get_default().connect('network-changed', (_monitor: any, available: boolean) => {
      if (available && !this._hasLoadedOnce)
        this._refreshTasks();
    });
  }

  // Task colors are purely a local visual preference — they have no equivalent
  // field in the Google Tasks API, so they're never synced there. Persisted to a
  // small JSON file instead of a GSettings key, since that would need a schema
  // change this extension doesn't currently define.
  private _getTaskColorsFile(): Gio.File {
    return this._getCacheFile('task-colors.json');
  }

  private _getTaskCreationTimesFile(): Gio.File {
    return this._getCacheFile('task-created.json');
  }

  private _getCacheFile(name: string): Gio.File {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'google-tasks-extension']);
    // Private: task ids and per-task data are nobody else's business.
    GLib.mkdir_with_parents(dir, 0o700);
    return Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
  }

  _loadTaskCreationTimes() {
    try {
      const file = this._getTaskCreationTimesFile();
      if (!file.query_exists(null))
        return;
      const [ok, contents] = file.load_contents(null);
      if (!ok)
        return;
      this._taskCreationTimes = parseCreationTimes(new TextDecoder().decode(contents));
    }
    catch (e) {
      console.error(`Google Tasks: Failed to load task creation times: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Saves are coalesced and written asynchronously: every refresh and every
  // color change used to write synchronously on the shell's main thread.
  _scheduleCacheSave(cache: 'colors' | 'times') {
    this._dirtyCaches.add(cache);
    if (this._cacheSaveTimerId !== null)
      return;
    this._cacheSaveTimerId = GLib.timeout_add(GLib.PRIORITY_LOW, CACHE_SAVE_DELAY_MS, () => {
      this._cacheSaveTimerId = null;
      this._writeDirtyCaches(false);
      return GLib.SOURCE_REMOVE;
    });
  }

  // Writes the caches with unsaved changes. Synchronously on disable(), so
  // nothing is lost and no callback outlives the extension.
  _writeDirtyCaches(sync: boolean) {
    for (const cache of this._dirtyCaches) {
      const [file, map] = cache === 'colors'
        ? [this._getTaskColorsFile(), this._taskColors as Map<string, unknown>]
        : [this._getTaskCreationTimesFile(), this._taskCreationTimes as Map<string, unknown>];
      const bytes = new TextEncoder().encode(serializeMap(map));
      const fail = (e: unknown) => console.error(`Google Tasks: Failed to save ${file.get_basename()}: ${e instanceof Error ? e.message : String(e)}`);
      try {
        if (sync) {
          file.replace_contents(bytes, null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        }
        else {
          file.replace_contents_bytes_async(GLib.Bytes.new(bytes), null, false, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null, (source: any, result: Gio.AsyncResult) => {
            try {
              source.replace_contents_finish(result);
            }
            catch (err) {
              fail(err);
            }
          });
        }
      }
      catch (err) {
        fail(err);
      }
    }
    this._dirtyCaches.clear();
  }

  // Records a creation time for tasks not seen before and, when every list
  // loaded (prune), drops records of tasks that no longer exist. Returns
  // true when the map needs saving.
  _syncTaskCreationTimes(allTasks: GoogleTask[], prune: boolean): boolean {
    let changed = false;
    const liveIds = new Set<string>();

    for (const task of allTasks) {
      if (!task.id)
        continue;
      liveIds.add(task.id);
      if (this._taskCreationTimes.has(task.id))
        continue;

      const fromUpdated = task.updated ? Date.parse(task.updated) : Number.NaN;
      this._taskCreationTimes.set(task.id, Number.isNaN(fromUpdated) ? Date.now() : fromUpdated);
      changed = true;
    }

    // A task pending deletion (tombstoned in GoogleTasksManager, but the
    // server hasn't caught up yet) is filtered out of allTasks the same as
    // a genuinely-gone one, so its record is dropped a little early here.
    // Harmless: the row is already hidden locally, and a failed delete's
    // rollback just re-adds the record on the next sync.
    if (prune && pruneToLiveIds(this._taskCreationTimes, liveIds))
      changed = true;

    return changed;
  }

  _loadTaskColors() {
    try {
      const file = this._getTaskColorsFile();
      if (!file.query_exists(null))
        return;
      const [ok, contents] = file.load_contents(null);
      if (!ok)
        return;
      this._taskColors = parseTaskColors(new TextDecoder().decode(contents), new Set(Object.keys(TASK_COLOR_HEX)));
    }
    catch (e) {
      console.error(`Google Tasks: Failed to load task colors: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  _onTaskColorChange(task: GoogleTask, colorId: string) {
    if (!task.id)
      return;
    if (colorId === 'none')
      this._taskColors.delete(task.id);
    else
      this._taskColors.set(task.id, colorId);
    this._scheduleCacheSave('colors');
    this._renderCurrentTaskList();
  }

  // Subtasks default to expanded (a task id not in the set is expanded).
  _isTaskExpanded(taskId: string): boolean {
    return !this._collapsedTaskIds.has(taskId);
  }

  // A subtask can't leave "completed" while its parent is still completed —
  // the parent must be uncompleted first.
  _canUncomplete(task: GoogleTask): boolean {
    if (!task.taskListId)
      return true;
    return canUncompleteTask(task, this._completedTasksByListId.get(task.taskListId));
  }

  _onToggleTaskExpand(task: GoogleTask) {
    if (!task.id)
      return;
    if (this._collapsedTaskIds.has(task.id))
      this._collapsedTaskIds.delete(task.id);
    else
      this._collapsedTaskIds.add(task.id);
    this._renderCurrentTaskList();
  }

  _getRefreshIntervalSeconds() {
    if (!this._settings)
      return REFRESH_INTERVAL_SECONDS;
    const configuredInterval = this._settings.get_int(REFRESH_INTERVAL_KEY);
    return configuredInterval > 0 ? configuredInterval : REFRESH_INTERVAL_SECONDS;
  }

  _getColumnWidth(): number {
    if (!this._settings)
      return DEFAULT_COLUMN_WIDTH_PX;
    const configuredWidth = this._settings.get_int(COLUMN_WIDTH_KEY);
    return configuredWidth > 0 ? configuredWidth : DEFAULT_COLUMN_WIDTH_PX;
  }

  _getLanguage(): Lang {
    if (!this._settings)
      return 'en';
    const value = this._settings.get_string(LANGUAGE_KEY);
    return value === 'ru' ? 'ru' : 'en';
  }

  _t(key: string): string {
    return t(this._getLanguage(), key);
  }

  // Re-applies the current language to everything that isn't rebuilt on
  // every render: the tasks column's own header, and TasksSection's static
  // labels (via setLanguage()). Dynamic per-render text (empty-state
  // messages, task rows) picks up the new language on the
  // _renderCurrentTaskList() call at the end here.
  _applyLanguage() {
    const lang = this._getLanguage();
    if (this._tasksSection)
      this._tasksSection.setLanguage(lang);
    if (this._headerLabel)
      this._headerLabel.text = this._t('headerTitle');
    this._renderCurrentTaskList();
  }

  _getCornerRadiusPx(): number {
    if (!this._settings)
      return DEFAULT_TASK_COLOR_CORNER_RADIUS_PX;
    return this._settings.get_int(CORNER_RADIUS_KEY);
  }

  _getTitleFontSizePx(): number {
    if (!this._settings)
      return DEFAULT_TITLE_FONT_SIZE_PX;
    const value = this._settings.get_int(TITLE_FONT_SIZE_KEY);
    return value > 0 ? value : DEFAULT_TITLE_FONT_SIZE_PX;
  }

  _getDescriptionFontSizePx(): number {
    if (!this._settings)
      return DEFAULT_DESCRIPTION_FONT_SIZE_PX;
    const value = this._settings.get_int(DESCRIPTION_FONT_SIZE_KEY);
    return value > 0 ? value : DEFAULT_DESCRIPTION_FONT_SIZE_PX;
  }

  _getTaskBlockSizePx(): number {
    if (!this._settings)
      return DEFAULT_TASK_BLOCK_SIZE_PX;
    return this._settings.get_int(TASK_BLOCK_SIZE_KEY);
  }

  _getSubtaskBlockSizePx(): number {
    if (!this._settings)
      return DEFAULT_SUBTASK_BLOCK_SIZE_PX;
    return this._settings.get_int(SUBTASK_BLOCK_SIZE_KEY);
  }

  _getRadioSizePx(): number {
    if (!this._settings)
      return DEFAULT_RADIO_SIZE_PX;
    const value = this._settings.get_int(RADIO_SIZE_KEY);
    return value > 0 ? value : DEFAULT_RADIO_SIZE_PX;
  }

  _getSubtaskRadioSizePx(): number {
    if (!this._settings)
      return DEFAULT_SUBTASK_RADIO_SIZE_PX;
    const value = this._settings.get_int(SUBTASK_RADIO_SIZE_KEY);
    return value > 0 ? value : DEFAULT_SUBTASK_RADIO_SIZE_PX;
  }

  _getSubtaskLevels(): number {
    if (!this._settings)
      return DEFAULT_SUBTASK_LEVELS;
    return normalizeSubtaskLevels(this._settings.get_int(SUBTASK_LEVELS_KEY));
  }

  // The preferences asked for a new nesting limit. Raising it can't leave
  // any task too deep, so it's applied at once; lowering it is applied only
  // if no task in any list is nested deeper than the new limit. Every list
  // is fetched fresh (completed tasks included), and if any list fails to
  // load the change is refused rather than checked against partial data.
  async _onSubtaskLevelsRequest() {
    if (!this._settings)
      return;
    const request = parseLevelsRequest(this._settings.get_string(SUBTASK_LEVELS_REQUEST_KEY));
    if (!request || request.id === this._levelsRequestId)
      return;
    this._levelsRequestId = request.id;
    const levels = normalizeSubtaskLevels(request.levels);

    const answer = (result: LevelsResult) => {
      if (!this._settings || this._levelsRequestId !== request.id)
        return;
      if (result.status === 'applied')
        this._settings.set_int(SUBTASK_LEVELS_KEY, levels);
      this._settings.set_string(SUBTASK_LEVELS_RESULT_KEY, serializeLevelsResult(result));
    };

    if (levels >= this._getSubtaskLevels()) {
      answer({ id: request.id, status: 'applied', levels });
      return;
    }
    if (!this._tasksManager) {
      answer({ id: request.id, status: 'failed', levels, failedLists: [] });
      return;
    }

    try {
      const { lists, tasks, failedListIds } = await this._tasksManager.getListsAndTasks(true);
      if (failedListIds.length > 0) {
        const titles = failedListIds.map(id => lists.find(list => list.id === id)?.title || id);
        answer({ id: request.id, status: 'failed', levels, failedLists: titles });
        return;
      }
      const offenders = findNestingOffenders(lists, tasks, levels);
      answer(offenders.length > 0
        ? buildRejection(request.id, levels, offenders)
        : { id: request.id, status: 'applied', levels });
    }
    catch (e) {
      if (isCancelledError(e))
        return;
      console.error(`[google-tasks] nesting check failed: ${e}`);
      answer({ id: request.id, status: 'failed', levels, failedLists: [], detail: e instanceof Error ? e.message : String(e) });
    }
  }

  _getEmptyStateIcon(): string {
    if (!this._settings)
      return DEFAULT_EMPTY_STATE_ICON;
    const value = this._settings.get_string(EMPTY_STATE_ICON_KEY);
    return value.length > 0 ? value : DEFAULT_EMPTY_STATE_ICON;
  }

  _getEmptyStateIconSizePx(): number {
    if (!this._settings)
      return DEFAULT_EMPTY_STATE_ICON_SIZE_PX;
    const value = this._settings.get_int(EMPTY_STATE_ICON_SIZE_KEY);
    return value > 0 ? value : DEFAULT_EMPTY_STATE_ICON_SIZE_PX;
  }

  _getEmptyStateFontSizePx(): number {
    if (!this._settings)
      return DEFAULT_EMPTY_STATE_FONT_SIZE_PX;
    const value = this._settings.get_int(EMPTY_STATE_FONT_SIZE_KEY);
    return value > 0 ? value : DEFAULT_EMPTY_STATE_FONT_SIZE_PX;
  }

  _applyTaskBlocks() {
    if (!this._tasksSection)
      return;
    const enabled = this._settings
      ? this._settings.get_boolean(TASK_BLOCKS_ENABLED_KEY)
      : DEFAULT_TASK_BLOCKS_ENABLED;
    const opacity = this._settings
      ? this._settings.get_int(TASK_BLOCKS_OPACITY_KEY)
      : DEFAULT_TASK_BLOCKS_OPACITY_PERCENT;
    const edgeBlur = this._settings
      ? this._settings.get_int(TASK_BLOCKS_EDGE_BLUR_KEY)
      : DEFAULT_TASK_BLOCKS_EDGE_BLUR_PX;
    this._tasksSection.setTaskBlocks(enabled, opacity, edgeBlur);
  }

  _getEmptyStateOpacityPercent(): number {
    if (!this._settings)
      return DEFAULT_EMPTY_STATE_OPACITY_PERCENT;
    const value = this._settings.get_int(EMPTY_STATE_OPACITY_KEY);
    return value > 0 ? value : DEFAULT_EMPTY_STATE_OPACITY_PERCENT;
  }

  _getCompletedRetentionMinutes(): number {
    if (!this._settings)
      return 0;
    return this._settings.get_int(COMPLETED_RETENTION_MINUTES_KEY);
  }

  _applyColumnWidth() {
    if (!this._columnContainer)
      return;
    const width = this._getColumnWidth();
    // Inline style takes precedence over the .google-tasks-column CSS class's
    // own rules, so this always wins regardless of what's in the stylesheet
    // (or whether the stylesheet even got picked up). The divider itself is
    // now a separate widget (see enable()) rather than a border here, since
    // a border-left on this container floated in the box layout's spacing
    // gap instead of sitting flush against the calendar.
    this._columnContainer.set_style([
      `width: ${width}px`,
      `min-width: ${width}px`,
      `max-width: ${width}px`,
      'padding-left: 16px',
    ].join('; '));
  }

  async _onAddTask(title: string, description: string, taskListId?: string, parentTaskId?: string) {
    if (!this._tasksManager)
      return;

    const resolvedListId = taskListId || this._selectedTaskListId || this._taskLists[0]?.id;
    if (!resolvedListId) {
      console.error('Google Tasks: No task list available to add to');
      return;
    }

    const tempId = `${PENDING_TASK_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const optimisticTask: GoogleTask = {
      id: tempId,
      title,
      notes: description || undefined,
      status: 'needsAction',
      taskListId: resolvedListId,
      parent: parentTaskId,
    };

    // Show it immediately — don't wait on the createTask() round trip at all.
    // This is what made adding feel slow while completing (already optimistic)
    // felt instant: the previous version still awaited the network response
    // before inserting anything locally.
    if (!this._activeTasksByListId.has(resolvedListId))
      this._activeTasksByListId.set(resolvedListId, []);
    this._activeTasksByListId.get(resolvedListId)!.push(optimisticTask);
    // Any refresh in flight predates this change and would overwrite it
    // with the old state — make its response stale.
    this._refreshRequestSeq++;
    this._renderCurrentTaskList();

    this._pendingMutations++;
    try {
      const created = await this._tasksManager!.createTask(title, description || undefined, resolvedListId, parentTaskId);

      const list = this._activeTasksByListId.get(resolvedListId);
      if (list) {
        const index = list.findIndex(t => t.id === tempId);
        if (index >= 0)
          list[index] = created;
      }
      this._renderCurrentTaskList();

      // Reconcile quietly in the background (server-assigned position, etc.).
      this._scheduleReconcile();
    }
    catch (e) {
      if (!isCancelledError(e))
        console.error(`Google Tasks: Failed to add task: ${e instanceof Error ? e.message : String(e)}`);

      const list = this._activeTasksByListId.get(resolvedListId);
      if (list) {
        const index = list.findIndex(t => t.id === tempId);
        if (index >= 0)
          list.splice(index, 1);
      }
      this._renderCurrentTaskList();
    }
    finally {
      this._pendingMutations--;
    }
  }

  _startRefreshTimer() {
    this._stopRefreshTimer();
    // Fast cadence until the very first successful load (see
    // STARTUP_RETRY_INTERVAL_SECONDS); _refreshTasks() switches this back
    // to the configured interval once that happens.
    const intervalSeconds = this._hasLoadedOnce ? this._getRefreshIntervalSeconds() : STARTUP_RETRY_INTERVAL_SECONDS;
    this._refreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, intervalSeconds, () => {
      if (this._pendingMutations > 0)
        return GLib.SOURCE_CONTINUE;
      // Nobody sees the list while the date menu is closed, so polling
      // Google every few seconds around the clock only costs network and
      // battery. Once loaded, a tick with the menu closed just marks the
      // data stale; opening the menu refreshes it.
      if (this._hasLoadedOnce && this._dateMenu && !this._dateMenu.isOpen)
        this._refreshWhenShown = true;
      else
        this._refreshTasks();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopRefreshTimer() {
    if (this._refreshTimerId !== null) {
      GLib.source_remove(this._refreshTimerId);
      this._refreshTimerId = null;
    }
  }

  _renderCurrentTaskList() {
    if (!this._tasksSection)
      return;

    // Rebuilding the rows destroys the actor an open menu is anchored to,
    // which closes it under the user. The render waits until the menu is
    // gone; setOnMenusClosed below flushes it.
    if (this._tasksSection.hasOpenMenu()) {
      this._renderDeferred = true;
      return;
    }
    this._renderDeferred = false;

    if (this._taskLists.length === 0) {
      if (this._alreadyRendered('no-lists'))
        return;
      this._tasksSection.setTaskLists([], '', () => { });
      this._applyEmptyStateSettings();
      this._tasksSection.showEmptyState(this._t('noTaskListsFound'));
      this._tasksSection.finishRender();
      return;
    }

    if (!this._selectedTaskListId || !this._taskLists.some(l => l.id === this._selectedTaskListId))
      this._selectedTaskListId = this._taskLists[0].id;

    const selectedTaskListId = this._selectedTaskListId;
    this._tasksSection.setCurrentTaskListId(selectedTaskListId);
    this._tasksSection.setShowTaskDate(this._getShowTaskDate());
    this._tasksSection.setTaskCreationTimes(this._taskCreationTimes);
    this._tasksSection.setTaskColors(this._taskColors);
    this._tasksSection.setCornerRadius(this._getCornerRadiusPx());
    this._tasksSection.setTitleFontSize(this._getTitleFontSizePx());
    this._tasksSection.setDescriptionFontSize(this._getDescriptionFontSizePx());
    this._tasksSection.setTaskBlockSize(this._getTaskBlockSizePx());
    this._tasksSection.setSubtaskBlockSize(this._getSubtaskBlockSizePx());
    this._tasksSection.setRadioSize(this._getRadioSizePx());
    this._tasksSection.setSubtaskRadioSize(this._getSubtaskRadioSizePx());
    this._tasksSection.setSubtaskLevels(this._getSubtaskLevels());
    this._tasksSection.setEmptyStateIcon(this._getEmptyStateIcon());
    this._tasksSection.setEmptyStateIconSize(this._getEmptyStateIconSizePx());
    this._tasksSection.setEmptyStateFontSize(this._getEmptyStateFontSizePx());
    this._tasksSection.setEmptyStateOpacity(this._getEmptyStateOpacityPercent());

    this._tasksSection.setTaskLists(this._taskLists, selectedTaskListId, (taskListId) => {
      this._selectedTaskListId = taskListId;
      this._renderCurrentTaskList();
    });

    const sortOrder = this._getTaskSortOrder();
    const activeTasks = sortTaskTree(
      filterTaskTreeByTimeframe(
        buildTaskTree(this._activeTasksByListId.get(selectedTaskListId) ?? []),
        this._getTaskTimeframe(),
        new Date(),
      ),
      sortOrder,
    );

    // Completed задачи НЕ фильтруем по timeframe — показываем ВСЕ.
    // ВАЖНО: не гейтить этот блок настройкой showCompletedTasks — секция сама
    // управляет видимостью через шеврон "Completed". Если здесь снова появится
    // условие `showCompletedTasks ? ... : []`, завершённые задачи опять
    // перестанут показываться независимо от того, что возвращает API.
    const completedTasks = sortTaskTree(
      buildTaskTree(this._completedTasksByListId.get(selectedTaskListId) ?? []),
      sortOrder,
    );

    const effectiveColors = this._computeEffectiveColors(selectedTaskListId);
    this._tasksSection.setEffectiveTaskColors(effectiveColors);

    if (activeTasks.length === 0 && completedTasks.length === 0) {
      if (this._alreadyRendered(`empty:${selectedTaskListId}`))
        return;
      this._tasksSection.showEmptyState(this._t('noTasks'));
      this._tasksSection.finishRender();
      return;
    }

    if (this._alreadyRendered(this._renderSignature(selectedTaskListId, activeTasks, completedTasks, effectiveColors)))
      return;

    this._tasksSection.clearTasks();

    this._addTaskTree(activeTasks);

    this._tasksSection.setCompletedTasks(
      completedTasks,
      id => this._isTaskExpanded(id),
      t => this._canUncomplete(t),
      t => this._onToggleTaskExpand(t),
      t => this._onTaskUncompleted(t),
      (t, title, notes) => this._onTaskEdit(t, title, notes),
      t => this._onDeleteTask(t),
      (t, colorId) => this._onTaskColorChange(t, colorId),
    );

    this._tasksSection.finishRender();
  }

  // Coalesces a burst of actions (e.g. completing/coloring/deleting several
  // tasks quickly) into a single background refresh instead of firing one per
  // action — each optimistic local update still renders immediately, this only
  // debounces the network reconcile that follows.
  _scheduleReconcile() {
    if (this._reconcileTimerId !== null)
      GLib.source_remove(this._reconcileTimerId);
    this._reconcileTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
      this._reconcileTimerId = null;
      this._refreshTasks();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Same coalescing as _scheduleReconcile(), but for settings that only
  // affect how the current tasks are drawn (fonts, sizes, colors…): a
  // SpinRow firing several changed:: signals in a row (e.g. a held stepper)
  // otherwise tears down and rebuilds the whole visible tree once per signal.
  _scheduleRenderOnly() {
    if (this._renderOnlyTimerId !== null)
      GLib.source_remove(this._renderOnlyTimerId);
    this._renderOnlyTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      this._renderOnlyTimerId = null;
      this._renderCurrentTaskList();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Deletes completed tasks older than the configured retention period.
  // Removes them from the in-memory maps immediately (so the render right
  // after this never shows them) and fires the actual server deletes in the
  // background — same optimistic pattern as every other mutation here.
  _pruneExpiredCompletedTasks() {
    const retentionMinutes = this._getCompletedRetentionMinutes();
    if (retentionMinutes <= 0 || !this._tasksManager)
      return;

    const cutoffMs = Date.now() - retentionMinutes * 60 * 1000;

    for (const [listId, tasks] of this._completedTasksByListId) {
      for (let i = tasks.length - 1; i >= 0; i--) {
        const task = tasks[i];
        const completedAt = task.completed || task.updated;
        if (!completedAt)
          continue;
        const completedMs = Date.parse(completedAt);
        if (Number.isNaN(completedMs) || completedMs > cutoffMs)
          continue;

        tasks.splice(i, 1);

        this._pendingMutations++;
        this._tasksManager!.deleteTask(listId, task.id)
          .catch((e) => {
            if (!isCancelledError(e))
              console.error(`Google Tasks: Failed to auto-delete expired completed task: ${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => {
            this._pendingMutations--;
          });
      }
    }
  }

  async _refreshTasks() {
    if (!this._tasksSection || !this._tasksManager) {
      // Both are only ever set together, at the very start of enable() —
      // reaching this null means disable() already ran and a queued
      // refresh (timer tick, mutation retry, debounced reconcile) is
      // arriving late, not that initialization actually failed.
      return;
    }

    this._refreshWhenShown = false;
    // Completed tasks are always fetched
    const includeCompletedTasks = true;
    const requestId = ++this._refreshRequestSeq;

    try {
      const { lists: taskLists, tasks: fetchedTasks, failedListIds } = await this._tasksManager.getListsAndTasks(includeCompletedTasks);

      if (!this._tasksSection || !this._tasksManager)
        return;

      // A newer refresh (or an optimistic action started after this one) has
      // already been issued — this response is stale. Applying it now would
      // overwrite more-recent state with older data, which is what made
      // tasks flicker or land back in the wrong section.
      if (requestId !== this._refreshRequestSeq)
        return;

      if (!this._hasLoadedOnce) {
        this._hasLoadedOnce = true;
        // Drop back from the fast startup-retry cadence to the
        // configured one now that a load has actually succeeded.
        this._startRefreshTimer();
        if (this._networkMonitorId !== null) {
          Gio.NetworkMonitor.get_default().disconnect(this._networkMonitorId);
          this._networkMonitorId = null;
        }
      }

      // A list that failed to load keeps what was already known about it,
      // rather than reading as "every task in it was deleted" — which
      // blanked it on screen and threw away its local dates and colors.
      const failed = new Set(failedListIds);
      const allTasks = [...fetchedTasks];
      for (const listId of failed) {
        allTasks.push(...this._activeTasksByListId.get(listId) ?? []);
        allTasks.push(...this._completedTasksByListId.get(listId) ?? []);
      }
      const everyListLoaded = failed.size === 0;

      this._taskLists = taskLists;
      this._activeTasksByListId = new Map(taskLists.map(list => [list.id, []] as [string, GoogleTask[]]));
      this._completedTasksByListId = new Map(taskLists.map(list => [list.id, []] as [string, GoogleTask[]]));

      if (this._syncTaskCreationTimes(allTasks, everyListLoaded))
        this._scheduleCacheSave('times');
      // Colors of deleted tasks used to stay in the cache forever.
      if (everyListLoaded && pruneToLiveIds(this._taskColors, new Set(allTasks.map(task => task.id))))
        this._scheduleCacheSave('colors');

      // allTasks has already been reconciled against optimistic writes
      // still in flight — see GoogleTasksManager.getListsAndTasks() —
      // so a status here is exactly what should be rendered right now.
      for (const task of allTasks) {
        if (!task.taskListId)
          continue;

        const bucket = task.status === 'completed' ? this._completedTasksByListId : this._activeTasksByListId;
        bucket.get(task.taskListId)?.push(task);
      }

      this._pruneExpiredCompletedTasks();
      this._renderCurrentTaskList();
    }
    catch (e) {
      if (isCancelledError(e))
        return;
      console.error(`Google Tasks: Failed to refresh tasks: ${e instanceof Error ? e.message : String(e)}`);
      // Keep whatever is already on screen; only say something when there
      // is nothing to keep.
      if (this._tasksSection && this._taskLists.length === 0 && this._lastRenderSignature !== 'unavailable') {
        this._applyEmptyStateSettings();
        this._tasksSection.showEmptyState(this._t('tasksUnavailable'));
        this._tasksSection.finishRender();
        this._lastRenderSignature = 'unavailable';
      }
    }
  }

  // Color resolution over every task of the list, active and completed
  // together (see resolveEffectiveColors()).
  _computeEffectiveColors(taskListId: string): Map<string, string> {
    return resolveEffectiveColors([
      ...this._activeTasksByListId.get(taskListId) ?? [],
      ...this._completedTasksByListId.get(taskListId) ?? [],
    ], this._taskColors);
  }

  _addTaskTree(tasks: GoogleTask[], depth: number = 0) {
    if (!this._tasksSection)
      return;

    for (const task of tasks) {
      const expanded = this._isTaskExpanded(task.id);
      if (task.title) {
        this._tasksSection.addTask(
          task,
          expanded,
          t => this._onToggleTaskExpand(t),
          t => this._onTaskCompleted(t),
          (t, title, notes) => this._onTaskEdit(t, title, notes),
          (t, title, notes) => this._onAddSubtask(t, title, notes),
          t => this._onDeleteTask(t),
          (t, colorId) => this._onTaskColorChange(t, colorId),
          depth,
        );
      }
      if (task.children && task.children.length > 0 && expanded)
        this._addTaskTree(task.children, depth + 1);
    }
  }

  _getTaskSortOrder(): TaskSortOrder {
    if (!this._settings)
      return 'my-order';
    const configuredSortOrder = this._settings.get_string(TASK_SORT_ORDER_KEY);
    return VALID_TASK_SORT_ORDERS.has(configuredSortOrder as TaskSortOrder)
      ? configuredSortOrder as TaskSortOrder
      : 'my-order';
  }

  // Every refresh tick used to tear the whole list down and build it again,
  // even when the response was identical to what was already on screen. That
  // cost a few hundred actors a second or two, and it was what made the
  // action buttons blink, hover reset, and open menus close under the user.
  // A render now happens only when something it depends on has changed.
  _alreadyRendered(signature: string): boolean {
    if (this._lastRenderSignature === signature)
      return true;
    this._lastRenderSignature = signature;
    return false;
  }

  _renderSignature(
    selectedTaskListId: string,
    activeTasks: GoogleTask[],
    completedTasks: GoogleTask[],
    effectiveColors: Map<string, string>,
  ): string {
    const parts: string[] = [
      selectedTaskListId,
      this._taskLists.map(list => `${list.id}:${list.title}`).join(','),
      this._settingsSignature(),
      [...this._collapsedTaskIds].sort().join(','),
    ];

    const walk = (tasks: GoogleTask[], depth: number) => {
      for (const task of tasks) {
        parts.push([
          depth,
          task.id,
          task.title,
          task.notes ?? '',
          task.status,
          task.completed ?? '',
          this._taskColors.get(task.id) ?? '',
          effectiveColors.get(task.id) ?? '',
          this._taskCreationTimes.get(task.id) ?? '',
        ].join('\u0001'));
        if (task.children?.length)
          walk(task.children, depth + 1);
      }
    };

    walk(activeTasks, 0);
    parts.push('--completed--');
    walk(completedTasks, 0);

    return parts.join('\u0002');
  }

  // Everything a rendered row reads from settings. Cheap to build, and it
  // keeps a settings change from being mistaken for "nothing changed".
  _settingsSignature(): string {
    return [
      this._getLanguage(),
      this._getTaskTimeframe(),
      this._getTaskSortOrder(),
      this._getShowTaskDate() ? '1' : '0',
      this._getShowCompletedTasks() ? '1' : '0',
      this._getCornerRadiusPx(),
      this._getTitleFontSizePx(),
      this._getDescriptionFontSizePx(),
      this._getTaskBlockSizePx(),
      this._getSubtaskBlockSizePx(),
      this._getRadioSizePx(),
      this._getSubtaskRadioSizePx(),
      this._getSubtaskLevels(),
      this._getEmptyStateIcon(),
      this._getEmptyStateIconSizePx(),
      this._getEmptyStateFontSizePx(),
      this._getEmptyStateOpacityPercent(),
    ].join('|');
  }

  _applyEmptyStateSettings() {
    if (!this._tasksSection)
      return;
    this._tasksSection.setEmptyStateIcon(this._getEmptyStateIcon());
    this._tasksSection.setEmptyStateIconSize(this._getEmptyStateIconSizePx());
    this._tasksSection.setEmptyStateFontSize(this._getEmptyStateFontSizePx());
    this._tasksSection.setEmptyStateOpacity(this._getEmptyStateOpacityPercent());
  }

  _getShowTaskDate(): boolean {
    if (!this._settings)
      return true;
    return this._settings.get_boolean(SHOW_TASK_DATE_KEY);
  }

  _getShowCompletedTasks(): boolean {
    if (!this._settings)
      return true;
    return this._settings.get_boolean(SHOW_COMPLETED_TASKS_KEY);
  }

  _getTaskTimeframe(): TaskTimeframe {
    if (!this._settings)
      return 'all';
    const configuredTimeframe = this._settings.get_string(TASK_TIMEFRAME_KEY);
    return VALID_TASK_TIMEFRAMES.has(configuredTimeframe as TaskTimeframe)
      ? configuredTimeframe as TaskTimeframe
      : 'all';
  }

  _onTaskEdit(task: GoogleTask, title: string, notes: string) {
    if (!this._tasksManager || !task.taskListId)
      return;
    const taskListId = task.taskListId;

    // Optimistic local update so the row reflects the edit immediately.
    const applyEdit = (map: Map<string, GoogleTask[]>) => {
      const tasks = map.get(taskListId);
      if (!tasks)
        return;
      const index = tasks.findIndex(t => t.id === task.id);
      if (index >= 0)
        tasks[index] = { ...tasks[index], title, notes };
    };
    applyEdit(this._activeTasksByListId);
    applyEdit(this._completedTasksByListId);
    // Any refresh in flight predates this change and would overwrite it
    // with the old state — make its response stale.
    this._refreshRequestSeq++;
    this._renderCurrentTaskList();

    this._pendingMutations++;
    this._tasksManager!.updateTask(taskListId, task.id, title, notes)
      .then(() => this._scheduleReconcile())
      .catch((e) => {
        if (isCancelledError(e))
          return;
        console.error(`Google Tasks: Failed to update task: ${e instanceof Error ? e.message : String(e)}`);
        this._refreshTasks();
      })
      .finally(() => {
        this._pendingMutations--;
      });
  }

  _onAddSubtask(task: GoogleTask, title: string, notes: string) {
    this._onAddTask(title, notes, task.taskListId, task.id);
  }

  _onTaskCompleted(task: GoogleTask) {
    if (!this._tasksManager || !task.taskListId)
      return;
    const taskListId = task.taskListId;

    const activeTasks = this._activeTasksByListId.get(taskListId);
    const completedTasks = this._completedTasksByListId.get(taskListId);
    if (!activeTasks || !completedTasks)
      return;

    // A subtask can't exist outside its parent's state: completing a task
    // also completes every one of its (currently active) subtasks, at any
    // depth.
    const idsToComplete = [task.id, ...collectDescendantIds(task.id, activeTasks)];

    // Move it locally and re-render right away — the previous version waited
    // for the completeTask() network round trip, then a *second* full
    // getTaskLists+getTasks refetch on a 50ms delay, which is what made
    // completing a task feel slow. GoogleTasksManager.completeTask() tracks
    // its own optimistic status override for the reconcile that follows.
    for (const id of idsToComplete) {
      const index = activeTasks.findIndex(t => t.id === id);
      if (index >= 0) {
        const [moved] = activeTasks.splice(index, 1);
        completedTasks.push({ ...moved, status: 'completed' });
      }
    }

    // Any refresh in flight predates this change and would overwrite it
    // with the old state — make its response stale.
    this._refreshRequestSeq++;
    this._renderCurrentTaskList();

    this._pendingMutations++;
    Promise.all(idsToComplete.map(id => this._tasksManager!.completeTask(taskListId, id)))
      .then(() => this._scheduleReconcile())
      .catch((e) => {
        if (isCancelledError(e))
          return;
        console.error(`Google Tasks: Failed to mark task completed: ${e instanceof Error ? e.message : String(e)}`);
        // completeTask() has already rolled back its own optimistic
        // override for whichever id(s) failed; refresh to re-sync the
        // local render with that.
        this._refreshTasks();
      })
      .finally(() => {
        this._pendingMutations--;
      });
  }

  async _onTaskUncompleted(task: GoogleTask) {
    if (!task.taskListId)
      return;

    const taskListId = task.taskListId;
    const completedTasks = this._completedTasksByListId.get(taskListId);

    // A subtask can't leave "completed" while its parent is still there —
    // uncomplete the parent first. This check is also enforced in the row's
    // click handlers (via _canUncomplete/isCompletedRowLocked), but it's
    // re-checked here too since state can shift between render and click.
    if (task.parent && completedTasks?.some(t => t.id === task.parent)) {
      Main.notify('Google Tasks', this._t('uncompleteParentFirst'));
      this._renderCurrentTaskList();
      return;
    }

    if (completedTasks) {
      const taskIndex = completedTasks.findIndex(t => t.id === task.id);
      if (taskIndex >= 0)
        completedTasks.splice(taskIndex, 1);
    }

    const activeTasks = this._activeTasksByListId.get(taskListId);
    if (activeTasks)
      activeTasks.push({ ...task, status: 'needsAction' });

    // Any refresh in flight predates this change and would overwrite it
    // with the old state — make its response stale.
    this._refreshRequestSeq++;
    this._renderCurrentTaskList();

    if (!this._tasksManager)
      return;

    try {
      this._pendingMutations++;
      // uncompleteTask() tracks its own optimistic status override for
      // the reconcile that follows.
      await this._tasksManager!.uncompleteTask(taskListId, task.id);
      this._scheduleReconcile();
    }
    catch (e) {
      if (isCancelledError(e))
        return;
      console.error(`Google Tasks: Failed to mark task unfinished: ${e instanceof Error ? e.message : String(e)}`);
      this._refreshTasks();
    }
    finally {
      this._pendingMutations--;
    }
  }

  _onDeleteTask(task: GoogleTask) {
    if (!this._tasksManager || !task.taskListId)
      return;
    const taskListId = task.taskListId;

    const activeTasks = this._activeTasksByListId.get(taskListId);
    const completedTasks = this._completedTasksByListId.get(taskListId);
    const allInList = [...(activeTasks ?? []), ...(completedTasks ?? [])];

    // A subtask can't exist without its parent: deleting a task deletes every
    // one of its subtasks too, at any depth, whether they're active or
    // already completed.
    const idsToDelete = new Set([task.id, ...collectDescendantIds(task.id, allInList)]);

    const removeMatching = (tasks: GoogleTask[] | undefined) => {
      if (!tasks)
        return;
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (idsToDelete.has(tasks[i].id))
          tasks.splice(i, 1);
      }
    };
    removeMatching(activeTasks);
    removeMatching(completedTasks);
    // Any refresh in flight predates this delete and still believes the
    // task exists — make its response stale.
    this._refreshRequestSeq++;
    this._renderCurrentTaskList();

    this._pendingMutations++;
    // deleteTask() tracks its own pending-deletion tombstone for the
    // reconcile that follows.
    Promise.all(Array.from(idsToDelete).map(id => this._tasksManager!.deleteTask(taskListId, id)))
      .then(() => this._scheduleReconcile())
      .catch((e) => {
        if (isCancelledError(e))
          return;
        console.error(`Google Tasks: Failed to delete task: ${e instanceof Error ? e.message : String(e)}`);
        this._refreshTasks();
      })
      .finally(() => {
        this._pendingMutations--;
      });
  }

  disable() {
    this._stopRefreshTimer();
    if (this._networkMonitorId !== null) {
      Gio.NetworkMonitor.get_default().disconnect(this._networkMonitorId);
      this._networkMonitorId = null;
    }
    setOnContextMenuClosed(null);
    closeContextMenu();
    if (this._cacheSaveTimerId !== null) {
      GLib.source_remove(this._cacheSaveTimerId);
      this._cacheSaveTimerId = null;
    }
    this._writeDirtyCaches(true);
    this._taskColors.clear();
    this._lastRenderSignature = null;
    this._renderDeferred = false;
    this._refreshWhenShown = false;
    this._hasLoadedOnce = false;
    this._taskCreationTimes.clear();

    if (this._menuBoxLayout && this._menuBoxOrientation !== null) {
      this._menuBoxLayout.orientation = this._menuBoxOrientation;
      this._menuBoxLayout = null;
      this._menuBoxOrientation = null;
    }
    if (this._dateMenu && this._dateMenuOpenStateId !== null) {
      this._dateMenu.disconnect(this._dateMenuOpenStateId);
      this._dateMenuOpenStateId = null;
      this._dateMenu = null;
    }
    if (this._reconcileTimerId !== null) {
      GLib.source_remove(this._reconcileTimerId);
      this._reconcileTimerId = null;
    }
    if (this._renderOnlyTimerId !== null) {
      GLib.source_remove(this._renderOnlyTimerId);
      this._renderOnlyTimerId = null;
    }

    for (const id of this._settingsSignalIds)
      this._settings?.disconnect(id);
    this._settingsSignalIds = [];
    this._levelsRequestId = null;

    this._settings = null;
    this._selectedTaskListId = null;
    this._taskLists = [];
    this._activeTasksByListId.clear();
    this._completedTasksByListId.clear();

    if (this._tasksManager) {
      this._tasksManager.destroy();
      this._tasksManager = null;
    }

    if (this._columnContainer) {
      this._columnContainer.destroy();
      this._columnContainer = null;
    }
    this._headerLabel = null;

    if (this._tasksSection) {
      // Drops the closure holding a reference back to this extension
      // before the actor goes away.
      this._tasksSection.setOnMenusClosed(null);
      this._tasksSection.destroy();
      this._tasksSection = null;
    }
  }
}
