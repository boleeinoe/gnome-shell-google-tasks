import Gio from 'gi://Gio';
import type { GoogleTask, GoogleTaskList } from './tasksManager.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { GoogleTasksManager, isCancelledError } from './tasksManager.js';
import {
    copyToClipboard,
    enableEntryClipboard,
    isContextMenuOpen,
    setOnContextMenuClosed,
    setupRichLabel,
    type ContextMenuItem,
    type TextStrings,
} from './textInteraction.js';

const TASK_COLOR_PALETTE: { id: string; label: string }[] = [
    { id: 'none', label: 'No color' },
    { id: 'red', label: 'Red' },
    { id: 'orange', label: 'Orange' },
    { id: 'yellow', label: 'Yellow' },
    { id: 'green', label: 'Green' },
    { id: 'blue', label: 'Blue' },
    { id: 'purple', label: 'Purple' },
];

// Interface language for the extension's own UI text (labels, buttons,
// hints, placeholder messages) — set via the 'language' GSettings key and
// the "Language" row in preferences. Does not translate task content itself,
// which comes from the user's own Google Tasks data.
type Lang = 'en' | 'ru';

const STRINGS: Record<Lang, Record<string, string>> = {
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

function t(lang: Lang, key: string): string {
    return STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
}

// Full and unambiguous, in local time.
function formatTimestamp(epochMs: number): string {
    const stamp = GLib.DateTime.new_from_unix_local(Math.floor(epochMs / 1000));
    return stamp ? stamp.format('%d.%m.%Y %H:%M:%S') ?? '' : '';
}

interface FormRestoreState {
    focusField: 'title' | 'notes';
    titleCursor: number;
    notesCursor: number;
    titleBound: number;
    notesBound: number;
}

// Built fresh on every call rather than captured once, so a language change
// reaches menus opened afterwards without extra wiring.
function textStrings(lang: Lang): TextStrings {
    return {
        copy: t(lang, 'copy'),
        cut: t(lang, 'cut'),
        paste: t(lang, 'paste'),
        selectAll: t(lang, 'selectAll'),
        openLink: t(lang, 'openLink'),
        copyLink: t(lang, 'copyLink'),
    };
}

// Hex values matching the .task-color-dot-* classes in stylesheet.css — kept in
// sync manually since St CSS can't be queried from JS. Used wherever a color
// needs to be applied inline (row background/border, parent-task arrow) rather
// than via a CSS class, since the alpha varies (own color vs. inherited).
const TASK_COLOR_HEX: Record<string, string> = {
    red: '#e05252',
    orange: '#e0964f',
    yellow: '#dcc94a',
    green: '#5cae6e',
    blue: '#5b8fd9',
    purple: '#9b6fd0',
};

function hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace('#', '');
    const r = Number.parseInt(clean.substring(0, 2), 16);
    const g = Number.parseInt(clean.substring(2, 4), 16);
    const b = Number.parseInt(clean.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Indent applied per nesting level for subtasks — a grandchild task sits this
// many pixels further right than its parent subtask, same step as a first-level
// subtask sits relative to its parent task.
const SUBTASK_INDENT_PX = 24;

// Only a task (depth 0) or a subtask created directly from one (depth 1) can
// add further subtasks — a subtask created from another subtask (depth 2+)
// cannot. This caps nesting at 3 levels and keeps the tree shallow, which also
// avoids the slowdown deep nesting was causing.
const MAX_DEPTH_THAT_CAN_ADD_SUBTASKS = 1;

// Prefix for the temporary id given to an optimistically-added task, before the
// server has confirmed it and assigned a real id. Rows for such a task hide
// edit/delete/color/complete controls, since those would need a real task id.
const PENDING_TASK_ID_PREFIX = '__pending_';

// How long to trust a status we just set locally over what a reconcile fetch
// reports, if they disagree. Google's API can briefly return the pre-change
// status right after a successful write (eventual consistency) — without this,
// a reconcile landing in that window flips the task back, then a later
// reconcile flips it forward again once the read catches up, which looked like
// the row bouncing between Completed and active on its own.
const STATUS_OVERRIDE_TTL_MS = 30000;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Retries a failing network call a few times with backoff before giving up.
// Transient failures (dropped connections, momentary TLS handshake errors —
// exactly what shows up in the logs) were previously treated as permanent,
// triggering an immediate full refetch that rolled the optimistic UI back.
async function withRetry<T>(fn: () => Promise<T>, retries = 2, baseDelayMs = 200): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (e) {
            lastError = e;
            if (attempt < retries)
                await delay(baseDelayMs * (attempt + 1));
        }
    }
    throw lastError;
}

// Corner rounding for a task row's colored background (and its matching inline
// edit form), used as a fallback before settings are available and as the
// GSettings default. The live value comes from the 'corner-radius' key via
// TasksSection.setCornerRadius() — see GoogleTasksExtension._getCornerRadiusPx().
const DEFAULT_TASK_COLOR_CORNER_RADIUS_PX = 6;
const DEFAULT_TITLE_FONT_SIZE_PX = 14;
const DEFAULT_DESCRIPTION_FONT_SIZE_PX = 11;
const DEFAULT_TASK_BLOCK_SIZE_PX = 4;
const DEFAULT_SUBTASK_BLOCK_SIZE_PX = 4;
const DEFAULT_RADIO_SIZE_PX = 12;
const DEFAULT_EMPTY_STATE_ICON = 'view-list-symbolic';
const DEFAULT_EMPTY_STATE_ICON_SIZE_PX = 64;
const DEFAULT_EMPTY_STATE_FONT_SIZE_PX = 14;
const DEFAULT_EMPTY_STATE_OPACITY_PERCENT = 50;

const TasksSection = GObject.registerClass({
    GTypeName: 'GoogleTasksSection',
    Signals: {
        'add-task-clicked': {
            param_types: [
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
                GObject.TYPE_STRING,
            ],
        },
    },
}, class TasksSection extends St.BoxLayout {
    private _taskListDropdownButton!: St.Button;
    private _taskListDropdownLabel!: St.Label;
    private _taskListDropdownMenu!: PopupMenu.PopupMenu;
    private _taskListDropdownMenuManager!: PopupMenu.PopupMenuManager;
    private _colorMenuManager!: PopupMenu.PopupMenuManager;
    private _activeTasksList!: St.BoxLayout;
    private _completedHeaderButton!: St.Button;
    private _completedLabel!: St.Label;
    private _completedChevronIcon!: St.Icon;
    private _completedTasksList!: St.BoxLayout;
    private _completedExpanded!: boolean;

    private _addTaskForm!: St.BoxLayout;
    private _addTaskEntry!: St.Entry;
    private _addTaskDescriptionEntry!: St.Entry;
    private _addTaskCancelButton!: St.Button;
    private _addTaskSaveButton!: St.Button;
    private _addTaskParentLabel!: St.Label;

    private _currentTaskListId!: string;
    private _currentParentTaskId!: string | null;
    private _taskColors!: Map<string, string>;
    private _effectiveTaskColors!: Map<string, string>;

    // taskId -> creation time (epoch ms). Google Tasks has no "created" field,
    // so the extension keeps its own record; see _loadTaskCreationTimes.
    private _taskCreationTimes!: Map<string, number>;
    private _showTaskDate!: boolean;
    private _openMenuCount!: number;
    private _onMenusClosed!: (() => void) | null;
    private _cornerRadiusPx!: number;
    private _titleFontSizePx!: number;
    private _descriptionFontSizePx!: number;
    private _taskBlockSizePx!: number;
    private _subtaskBlockSizePx!: number;
    private _radioSizePx!: number;
    private _emptyStateIcon!: string;
    private _emptyStateIconSizePx!: number;
    private _emptyStateFontSizePx!: number;
    private _emptyStateOpacityPercent!: number;
    private _lang!: Lang;

    // Snapshot of the currently-open inline form (if any), captured right before
    // a rebuild destroys it, and used to reopen an equivalent form — with
    // whatever the user had typed — on the same task's new row afterward. This
    // is what lets every action render instantly everywhere: renders no longer
    // need to be suppressed just because some other row has a form open.
    private _activeFormSnapshot!: {
        taskId: string;
        kind: 'edit' | 'subtask';
        title: string;
        notes: string;
        // Which field the user was typing in when the rebuild hit, and where the
        // caret was. Without it, every re-render — a refresh tick is enough —
        // reopened the form with focus back on the title.
        focusField: 'title' | 'notes';
        titleCursor: number;
        notesCursor: number;
        // Selection bounds, so a selection survives the rebuild too: restoring
        // only the caret silently dropped whatever the user had selected.
        titleBound: number;
        notesBound: number;
        liveTitleEntry: St.Entry | null;
        liveDescEntry: St.Entry | null;
    } | null;

    private _pendingFormReopen!: (() => void) | null;

    // Closes whichever inline form is open, so the section can drop an
    // in-progress edit from the outside without hunting through row actors.
    private _activeFormCloser!: (() => void) | null;

    _init() {
        super._init({
            style_class: 'google-tasks-section',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        // Field defaults live here, not on the declarations: for a GObject
        // subclass, declaration initializers run after super(), and super() is
        // what calls _init() — so everything below would otherwise read
        // undefined and have its own writes overwritten a moment later.
        this._completedExpanded = false;
        this._currentTaskListId = '';
        this._currentParentTaskId = null;
        this._taskColors = new Map();
        this._effectiveTaskColors = new Map();
        this._taskCreationTimes = new Map();
        this._showTaskDate = true;
        this._openMenuCount = 0;
        this._onMenusClosed = null;
        this._cornerRadiusPx = DEFAULT_TASK_COLOR_CORNER_RADIUS_PX;
        this._titleFontSizePx = DEFAULT_TITLE_FONT_SIZE_PX;
        this._descriptionFontSizePx = DEFAULT_DESCRIPTION_FONT_SIZE_PX;
        this._taskBlockSizePx = DEFAULT_TASK_BLOCK_SIZE_PX;
        this._subtaskBlockSizePx = DEFAULT_SUBTASK_BLOCK_SIZE_PX;
        this._radioSizePx = DEFAULT_RADIO_SIZE_PX;
        this._emptyStateIcon = DEFAULT_EMPTY_STATE_ICON;
        this._emptyStateIconSizePx = DEFAULT_EMPTY_STATE_ICON_SIZE_PX;
        this._emptyStateFontSizePx = DEFAULT_EMPTY_STATE_FONT_SIZE_PX;
        this._emptyStateOpacityPercent = DEFAULT_EMPTY_STATE_OPACITY_PERCENT;
        this._lang = 'en';
        this._activeFormSnapshot = null;
        this._pendingFormReopen = null;
        this._activeFormCloser = null;

        const box = new St.BoxLayout({
            style_class: 'google-tasks-box',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(box);

        const titleBox = new St.BoxLayout({ style_class: 'weather-header-box' });

        this._taskListDropdownLabel = new St.Label({
            text: t(this._lang, 'taskListsLabel'),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._taskListDropdownLabel.clutter_text.set_ellipsize(3);

        const dropdownIcon = new St.Icon({
            icon_name: 'pan-down-symbolic',
            icon_size: 12,
        });

        const dropdownContent = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        dropdownContent.add_child(this._taskListDropdownLabel);
        dropdownContent.add_child(dropdownIcon);

        this._taskListDropdownButton = new St.Button({
            style_class: 'google-tasks-dropdown-button',
            can_focus: true,
            x_expand: true,
            child: dropdownContent,
        });

        this._taskListDropdownMenu = new PopupMenu.PopupMenu(this._taskListDropdownButton, 0.0, St.Side.TOP);
        Main.uiGroup.add_child(this._taskListDropdownMenu.actor);
        this._taskListDropdownMenu.actor.hide();
        this._taskListDropdownMenuManager = new PopupMenu.PopupMenuManager(this);
        this._taskListDropdownMenuManager.addMenu(this._taskListDropdownMenu);

        // One shared manager for every task row's color-picker popup, instead of a
        // new PopupMenuManager per row per render — creating many short-lived
        // managers was part of what made the "already disposed" crash happen when
        // a re-render tore a row down mid-interaction.
        this._colorMenuManager = new PopupMenu.PopupMenuManager(this);

        this._taskListDropdownButton.connect('clicked', () => {
            this._taskListDropdownMenu.toggle();
            return Clutter.EVENT_STOP;
        });

        const addButton = new St.Button({
            style_class: 'google-tasks-add-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'list-add-symbolic',
                icon_size: 15,
            }),
        });
        addButton.connect('clicked', () => {
            this._showAddTaskForm();
            return Clutter.EVENT_STOP;
        });

        titleBox.add_child(this._taskListDropdownButton);
        titleBox.add_child(addButton);
        box.add_child(titleBox);

        this._addTaskForm = new St.BoxLayout({
            style_class: 'google-tasks-add-form',
            vertical: true,
            visible: false,
            opacity: 0,
        });

        this._addTaskParentLabel = new St.Label({
            text: '',
            style_class: 'google-tasks-subtask-label',
            visible: false,
            x_expand: true,
        });
        setupRichLabel(this._addTaskParentLabel, {
            getStrings: () => textStrings(this._lang),
            enableLinks: false,
        });

        this._addTaskEntry = new St.Entry({
            style_class: 'google-tasks-dialog-entry google-tasks-inline-entry',
            hint_text: t(this._lang, 'taskTitleHint'),
            can_focus: true,
            x_expand: true,
        });

        this._addTaskDescriptionEntry = new St.Entry({
            style_class: 'google-tasks-dialog-entry google-tasks-inline-entry',
            hint_text: t(this._lang, 'descriptionHint'),
            can_focus: true,
            x_expand: true,
        });

        const formButtons = new St.BoxLayout({
            style_class: 'google-tasks-form-buttons',
        });

        this._addTaskCancelButton = new St.Button({
            style_class: 'google-tasks-form-button',
            label: t(this._lang, 'cancel'),
            can_focus: true,
            x_expand: true,
        });
        this._addTaskCancelButton.connect('clicked', () => {
            this._hideAddTaskForm();
        });

        this._addTaskSaveButton = new St.Button({
            style_class: 'google-tasks-form-button google-tasks-form-button-save',
            label: t(this._lang, 'save'),
            can_focus: true,
            x_expand: true,
        });
        this._addTaskSaveButton.connect('clicked', () => {
            this._onAddTaskFromForm();
        });

        // Copy/paste (Ctrl+C/X/V/A, Ctrl+/Shift+Insert, right-click menu,
        // middle-click paste) for both fields of the persistent add-task form.
        enableEntryClipboard(this._addTaskEntry, { getStrings: () => textStrings(this._lang), onEscape: () => this._hideAddTaskForm() });
        enableEntryClipboard(this._addTaskDescriptionEntry, { getStrings: () => textStrings(this._lang), onEscape: () => this._hideAddTaskForm() });

        this._addTaskEntry.clutter_text.connect('activate', () => {
            this._onAddTaskFromForm();
        });
        this._addTaskDescriptionEntry.clutter_text.connect('activate', () => {
            this._onAddTaskFromForm();
        });

        formButtons.add_child(this._addTaskCancelButton);
        formButtons.add_child(this._addTaskSaveButton);

        this._addTaskForm.add_child(this._addTaskParentLabel);
        this._addTaskForm.add_child(this._addTaskEntry);
        this._addTaskForm.add_child(this._addTaskDescriptionEntry);
        this._addTaskForm.add_child(formButtons);
        box.add_child(this._addTaskForm);

        this._activeTasksList = new St.BoxLayout({
            style_class: 'tasks-list',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._activeTasksList);

        const completedHeaderContent = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._completedLabel = new St.Label({
            text: t(this._lang, 'completed'),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'tasks-completed-label',
        });

        this._completedChevronIcon = new St.Icon({
            icon_name: 'pan-end-symbolic',
            icon_size: 12,
            style_class: 'tasks-completed-chevron',
        });

        completedHeaderContent.add_child(this._completedLabel);
        completedHeaderContent.add_child(this._completedChevronIcon);

        this._completedHeaderButton = new St.Button({
            style_class: 'tasks-completed-toggle',
            can_focus: true,
            x_expand: true,
            child: completedHeaderContent,
            visible: false,
        });
        this._completedHeaderButton.connect('clicked', () => {
            this._setCompletedExpanded(!this._completedExpanded);
            return Clutter.EVENT_STOP;
        });

        this._completedTasksList = new St.BoxLayout({
            style_class: 'tasks-list tasks-completed-list',
            vertical: true,
            x_expand: true,
            visible: false,
        });

        box.add_child(this._completedHeaderButton);
        box.add_child(this._completedTasksList);

        this.connect('destroy', () => {
            this._taskListDropdownMenu.destroy();
        });
    }

    setCurrentTaskListId(id: string) {
        this._currentTaskListId = id;
    }

    hasOpenMenu(): boolean {
        return this._openMenuCount > 0 || isContextMenuOpen();
    }

    setOnMenusClosed(callback: (() => void) | null) {
        this._onMenusClosed = callback;
    }

    setShowTaskDate(show: boolean) {
        this._showTaskDate = show;
    }

    setTaskCreationTimes(times: Map<string, number>) {
        this._taskCreationTimes = times;
    }

    setTaskColors(colors: Map<string, string>) {
        this._taskColors = colors;
    }

    setEffectiveTaskColors(colors: Map<string, string>) {
        this._effectiveTaskColors = colors;
    }

    setCornerRadius(px: number) {
        this._cornerRadiusPx = px;
    }

    setTitleFontSize(px: number) {
        this._titleFontSizePx = px;
    }

    setDescriptionFontSize(px: number) {
        this._descriptionFontSizePx = px;
    }

    setTaskBlockSize(px: number) {
        this._taskBlockSizePx = px;
    }

    setSubtaskBlockSize(px: number) {
        this._subtaskBlockSizePx = px;
    }

    setRadioSize(px: number) {
        this._radioSizePx = px;
    }

    setEmptyStateIcon(iconName: string) {
        this._emptyStateIcon = iconName;
    }

    setEmptyStateIconSize(px: number) {
        this._emptyStateIconSizePx = px;
    }

    setEmptyStateFontSize(px: number) {
        this._emptyStateFontSizePx = px;
    }

    setEmptyStateOpacity(percent: number) {
        this._emptyStateOpacityPercent = percent;
    }

    // Updates the interface language and immediately re-applies it to every
    // static label/hint built once in _init() (the dropdown, the persistent
    // add-task form, "Completed"). Anything built per-render or per-opened-form
    // (task rows, inline edit forms, the color menu) just reads this._lang at
    // creation time, so a subsequent render/open already picks up the change —
    // no separate update path needed for those.
    setLanguage(lang: Lang) {
        this._lang = lang;
        this._taskListDropdownLabel.set_text(t(lang, 'taskListsLabel'));
        this._completedLabel.text = t(lang, 'completed');
        this._addTaskEntry.hint_text = this._currentParentTaskId
            ? t(lang, 'subtaskTitleHint')
            : t(lang, 'taskTitleHint');
        this._addTaskDescriptionEntry.hint_text = t(lang, 'descriptionHint');
        this._addTaskCancelButton.label = t(lang, 'cancel');
        this._addTaskSaveButton.label = t(lang, 'save');
    }

    // Called once, after a full render pass (clearTasks + rebuilding every row)
    // finishes. If a form was open when the rebuild started, its row registered
    // a reopen callback (see _createTaskRow) — run it now so the form comes back
    // with the user's in-progress text, on the freshly rebuilt row.
    finishRender() {
        if (this._pendingFormReopen) {
            const reopen = this._pendingFormReopen;
            this._pendingFormReopen = null;
            reopen();
        }
    }

    private _showAddTaskForm(parentTask?: GoogleTask) {
        this._currentParentTaskId = parentTask?.id ?? null;

        if (parentTask) {
            this._addTaskParentLabel.text = `${t(this._lang, 'subtaskForPrefix')}: ${parentTask.title}`;
            this._addTaskParentLabel.visible = true;
            this._addTaskEntry.hint_text = t(this._lang, 'subtaskTitleHint');
            this._addTaskForm.add_style_class_name('google-tasks-add-form-subtask');
        } else {
            this._addTaskParentLabel.text = '';
            this._addTaskParentLabel.visible = false;
            this._addTaskEntry.hint_text = t(this._lang, 'taskTitleHint');
            this._addTaskForm.remove_style_class_name('google-tasks-add-form-subtask');
        }

        this._addTaskForm.visible = true;
        this._addTaskForm.opacity = 255;
        this._addTaskEntry.set_text('');
        this._addTaskDescriptionEntry.set_text('');
        this._addTaskEntry.grab_key_focus();
    }

    // Drops every open form, discarding whatever was typed. Called when the
    // date menu closes: an edit left open would otherwise reappear next time,
    // reading as though the popup had saved it.
    closeAllForms() {
        this._activeFormCloser?.();
        this._activeFormCloser = null;
        this._activeFormSnapshot = null;
        this._pendingFormReopen = null;
        this._hideAddTaskForm();
    }

    private _hideAddTaskForm() {
        this._addTaskForm.visible = false;
        this._addTaskForm.opacity = 0;
        this._currentParentTaskId = null;
        this._addTaskParentLabel.visible = false;
        this._addTaskForm.remove_style_class_name('google-tasks-add-form-subtask');
    }

    private _onAddTaskFromForm() {
        const title = this._addTaskEntry.get_text().trim();
        if (title.length > 0) {
            const description = this._addTaskDescriptionEntry.get_text().trim();
            const taskListId = this._currentTaskListId;
            const parentTaskId = this._currentParentTaskId || '';
            this.emit('add-task-clicked', title, description, taskListId, parentTaskId);
            this._hideAddTaskForm();
        }
    }

    setTaskLists(taskLists: GoogleTaskList[], selectedTaskListId: string, onSelect: (taskListId: string) => void) {
        this._currentTaskListId = selectedTaskListId;
        this._taskListDropdownMenu.removeAll();

        if (taskLists.length === 0) {
            this._taskListDropdownLabel.set_text(t(this._lang, 'noTaskLists'));
            this._taskListDropdownButton.reactive = false;
            this._taskListDropdownMenu.close();
            return;
        }

        this._taskListDropdownButton.reactive = true;
        const selectedTaskList = taskLists.find(list => list.id === selectedTaskListId) ?? taskLists[0];
        this._taskListDropdownLabel.set_text(selectedTaskList.title);

        for (const list of taskLists) {
            const dropdownItem = new PopupMenu.PopupMenuItem(list.title);
            if (list.id === selectedTaskListId)
                dropdownItem.setOrnament(PopupMenu.Ornament.CHECK);
            dropdownItem.connect('activate', () => {
                onSelect(list.id);
            });
            this._taskListDropdownMenu.addMenuItem(dropdownItem);
        }
    }

    private _createTaskRow(
        task: GoogleTask,
        isCompleted: boolean,
        isExpanded: boolean,
        onComplete?: (task: GoogleTask) => void,
        onUncomplete?: (task: GoogleTask) => void,
        onEdit?: (task: GoogleTask, title: string, notes: string) => void,
        onAddSubtask?: (task: GoogleTask, title: string, notes: string) => void,
        onDelete?: (task: GoogleTask) => void,
        onColorChange?: (task: GoogleTask, colorId: string) => void,
        onToggleExpand?: (task: GoogleTask) => void,
        depth: number = 0,
        canUncomplete: boolean = true,
    ) {
        const isPending = task.id.startsWith(PENDING_TASK_ID_PREFIX);

        const box = new St.BoxLayout({
            style_class: depth > 0 ? 'task-box task-box-subtask' : 'task-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
            track_hover: true,
        });

        // The action buttons are hover-driven, and opening the color menu takes
        // the pointer grab — which drops the row's hover. They stay up while
        // this row's menu is open.
        let colorMenuOpen = false;
        const hoverButtons: St.Button[] = [];
        // Set below when the row has a timestamp: it and the action buttons
        // share the same strip, so only one is shown at a time.
        let setStampVisible: ((visible: boolean) => void) | null = null;
        const updateHoverButtons = () => {
            const shown = box.hover || colorMenuOpen;
            for (const button of hoverButtons)
                button.opacity = shown ? 255 : 0;
            setStampVisible?.(!shown);
        };
        box.connect('notify::hover', updateHoverButtons);

        // A rebuilt row starts with hover unset even when the pointer is already
        // over it, and St only sets it on the next enter event — so the buttons
        // blinked out until the pointer moved again. sync_hover asks for the
        // real state as soon as the row appears.
        box.connect('notify::mapped', () => {
            if (box.mapped)
                box.sync_hover();
        });

        const ownColor = task.id ? this._taskColors.get(task.id) : undefined;
        // The swatch shows the color the row actually has, which for a subtask
        // without a color of its own is the one inherited from its parent.
        const currentColor = ownColor ?? (task.id ? this._effectiveTaskColors.get(task.id) : undefined);
        const effectiveColor = task.id ? this._effectiveTaskColors.get(task.id) : undefined;

        const boxStyleParts: string[] = [];
        const blockSizePx = depth > 0 ? this._subtaskBlockSizePx : this._taskBlockSizePx;
        boxStyleParts.push(`padding-top: ${blockSizePx}px`);
        boxStyleParts.push(`padding-bottom: ${blockSizePx}px`);
        if (effectiveColor && effectiveColor !== 'none') {
            const hex = TASK_COLOR_HEX[effectiveColor];
            if (hex) {
                // Own explicit color: same look as before. Inherited from an
                // ancestor task: noticeably more transparent, so it reads as a
                // grouping hint rather than the task's own setting.
                const isOwnColor = currentColor === effectiveColor;
                boxStyleParts.push(`background-color: ${hexToRgba(hex, isOwnColor ? 0.12 : 0.05)}`);
                boxStyleParts.push(`border-left: 3px solid ${hexToRgba(hex, isOwnColor ? 1 : 0.4)}`);
            }
            boxStyleParts.push(`border-radius: ${this._cornerRadiusPx}px`);
        }
        if (depth > 0)
            boxStyleParts.push(`margin-left: ${depth * SUBTASK_INDENT_PX}px`);
        if (boxStyleParts.length > 0)
            box.set_style(`${boxStyleParts.join('; ')};`);

        if (isPending)
            box.add_style_class_name('task-box-pending');

        // Active: the circle is hidden on a task/subtask that has children —
        // completing cascades down from a leaf, not up from a parent, so
        // there's no direct "complete" action for a container row.
        // Completed: only the top-level (depth 0) row keeps its circle — every
        // descendant got there alongside it via the same cascade, so showing a
        // checkmark on each level is redundant. The root's circle is also the
        // only way back out of "completed" (descendants stay locked there via
        // canUncomplete while the root remains completed, matching this).
        const hasChildren = !!(task.children && task.children.length > 0);
        const showRadio = isCompleted ? depth === 0 : !hasChildren;

        const radio = new St.Button({
            style_class: 'task-radio',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: !isPending,
        });
        radio.set_style(`width: ${this._radioSizePx}px; height: ${this._radioSizePx}px;`);

        const checkIcon = new St.Icon({
            icon_name: 'object-select-symbolic',
            style_class: 'task-radio-check',
            icon_size: Math.round(this._radioSizePx * 1.25),
        });
        checkIcon.opacity = isCompleted ? 255 : 0;
        radio.set_child(checkIcon);

        radio.connect('notify::hover', () => {
            if (!isCompleted && !radio.has_style_class_name('task-radio-completed'))
                checkIcon.opacity = radio.hover ? 255 : 0;
        });

        const label = new St.Label({
            text: task.title,
            style_class: 'task-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.set_style(`font-size: ${this._titleFontSizePx}px;`);
        // The title shares its line with the timestamp, so it has to give way:
        // without ellipsizing it demands its full natural width and pushes the
        // timestamp past the row's right edge.
        label.clutter_text.set_single_line_mode(true);
        label.clutter_text.set_ellipsize(3);

        const textBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            reactive: !isPending,
            track_hover: true,
            style_class: 'task-text-box',
        });

        const titleRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'task-title-row',
        });
        label.x_expand = true;
        titleRow.add_child(label);

        textBox.add_child(titleRow);

        // Clicking the text does not complete the task: the circle on the left
        // is the only way, which keeps the gesture unambiguous now that the
        // text handles links.
        const copyMenuItems = (): ContextMenuItem[] => {
            const items: ContextMenuItem[] = [];
            items.push({
                label: t(this._lang, 'copyTitle'),
                action: () => copyToClipboard(task.title),
            });
            if (task.notes) {
                items.push({
                    label: t(this._lang, 'copyDescription'),
                    action: () => copyToClipboard(task.notes as string),
                });
                items.push({
                    label: t(this._lang, 'copyAll'),
                    action: () => copyToClipboard(`${task.title}\n${task.notes}`),
                });
            }
            return items;
        };

        setupRichLabel(label, {
            getStrings: () => textStrings(this._lang),
            text: task.title,
            extraMenuItems: copyMenuItems,
        });

        if (task.notes) {
            const descLabel = new St.Label({
                text: task.notes,
                style_class: 'task-description',
                y_align: Clutter.ActorAlign.CENTER,
            });
            descLabel.set_style(`font-size: ${this._descriptionFontSizePx}px;`);
            // One line, ellipsized, like the title: a wrapping description can
            // grow past its row, and markup on a link inside makes the height
            // unpredictable.
            descLabel.clutter_text.set_line_wrap(false);
            descLabel.clutter_text.set_single_line_mode(true);
            descLabel.clutter_text.set_ellipsize(3);
            setupRichLabel(descLabel, {
                getStrings: () => textStrings(this._lang),
                text: task.notes,
                extraMenuItems: copyMenuItems,
            });
            textBox.add_child(descLabel);
        }


        if (isCompleted) {
            radio.add_style_class_name('task-radio-completed');
            label.add_style_class_name('task-label-completed');
            if (canUncomplete) {
                radio.connect('clicked', () => {
                    radio.reactive = false;
                    if (onUncomplete)
                        onUncomplete(task);
                });
            }
            else {
                // Can't leave "completed" while the parent is still there.
                radio.reactive = false;
                box.add_style_class_name('task-box-locked');
            }
        } else {
            radio.connect('clicked', () => {
                radio.add_style_class_name('task-radio-completed');
                checkIcon.opacity = 255;
                label.add_style_class_name('task-label-completed');
                radio.reactive = false;
                if (onComplete)
                    onComplete(task);
            });
        }

        // Both "edit" and "add subtask" open an inline form directly under this row.
        // Only one such form (of either kind) is open per row at a time.
        let openForm: St.BoxLayout | null = null;
        const closeOpenForm = () => {
            if (openForm) {
                openForm.destroy();
                openForm = null;
                if (this._activeFormSnapshot?.taskId === task.id)
                    this._activeFormSnapshot = null;
                if (this._activeFormCloser === closeOpenForm)
                    this._activeFormCloser = null;
            }
        };

        const openInlineForm = (options: {
            kind: 'edit' | 'subtask';
            parentLabel?: string;
            titleHint: string;
            initialTitle: string;
            initialNotes: string;
            colored: boolean;
            restore?: FormRestoreState;
            onCommit: (title: string, notes: string) => void;
        }) => {
            if (openForm) {
                closeOpenForm();
                return;
            }

            const parent = box.get_parent();
            if (!parent)
                return;

            const titleEntry = new St.Entry({
                style_class: 'google-tasks-dialog-entry google-tasks-inline-entry',
                hint_text: options.titleHint,
                text: options.initialTitle,
                can_focus: true,
                x_expand: true,
            });
            const descEntry = new St.Entry({
                style_class: 'google-tasks-dialog-entry google-tasks-inline-entry',
                hint_text: t(this._lang, 'descriptionHint'),
                text: options.initialNotes,
                can_focus: true,
                x_expand: true,
            });

            const formButtons = new St.BoxLayout({ style_class: 'google-tasks-form-buttons' });
            const cancelButton = new St.Button({
                style_class: 'google-tasks-form-button',
                label: t(this._lang, 'cancel'),
                can_focus: true,
                x_expand: true,
            });
            const saveButton = new St.Button({
                style_class: 'google-tasks-form-button google-tasks-form-button-save',
                label: t(this._lang, 'save'),
                can_focus: true,
                x_expand: true,
            });

            const commit = () => {
                const newTitle = titleEntry.get_text().trim();
                if (newTitle.length === 0)
                    return;
                const newNotes = descEntry.get_text().trim();
                closeOpenForm();
                options.onCommit(newTitle, newNotes);
            };

            enableEntryClipboard(titleEntry, { getStrings: () => textStrings(this._lang), onEscape: () => closeOpenForm() });
            enableEntryClipboard(descEntry, { getStrings: () => textStrings(this._lang), onEscape: () => closeOpenForm() });

            cancelButton.connect('clicked', () => closeOpenForm());
            saveButton.connect('clicked', () => commit());
            titleEntry.clutter_text.connect('activate', () => commit());
            descEntry.clutter_text.connect('activate', () => commit());

            formButtons.add_child(cancelButton);
            formButtons.add_child(saveButton);

            const formStyleClass = depth > 0
                ? 'google-tasks-add-form google-tasks-edit-form-nested'
                : 'google-tasks-add-form';

            const form = new St.BoxLayout({ style_class: formStyleClass, vertical: true });
            if (options.colored && effectiveColor && effectiveColor !== 'none') {
                const hex = TASK_COLOR_HEX[effectiveColor];
                if (hex) {
                    const isOwnColor = currentColor === effectiveColor;
                    form.set_style([
                        `border-radius: ${this._cornerRadiusPx}px`,
                        `background-color: ${hexToRgba(hex, isOwnColor ? 0.08 : 0.04)}`,
                        `border-left: 3px solid ${hexToRgba(hex, isOwnColor ? 0.5 : 0.3)}`,
                    ].join('; '));
                }
            }

            if (options.parentLabel) {
                const parentLabel = new St.Label({
                    text: options.parentLabel,
                    style_class: 'google-tasks-subtask-label',
                    x_expand: true,
                });
                setupRichLabel(parentLabel, {
                    getStrings: () => textStrings(this._lang),
                    text: options.parentLabel,
                    enableLinks: false,
                });
                form.add_child(parentLabel);
            }
            form.add_child(titleEntry);
            form.add_child(descEntry);
            form.add_child(formButtons);

            parent.insert_child_above(form, box);

            // A fresh form starts on the title; a restored one goes back to the
            // field the user was in, caret included.
            const restore = options.restore;
            const focusEntry = restore?.focusField === 'notes' ? descEntry : titleEntry;
            focusEntry.grab_key_focus();
            if (!restore) {
                const caret = focusEntry.clutter_text.get_cursor_position();
                focusEntry.clutter_text.set_selection(caret, caret);
            }
            if (restore) {
                // set_selection, not set_cursor_position: the latter moves only
                // the caret and leaves the selection bound behind, which
                // silently selects everything in between. The same value twice
                // collapses the selection onto the caret.
                titleEntry.clutter_text.set_selection(restore.titleBound, restore.titleCursor);
                descEntry.clutter_text.set_selection(restore.notesBound, restore.notesCursor);
            }
            openForm = form;
            this._activeFormCloser = closeOpenForm;

            // Record enough to reopen this exact form (with whatever's typed) if
            // a render tears this row down while it's still open — see
            // clearTasks() (captures the live text) and the reopen check below.
            this._activeFormSnapshot = {
                taskId: task.id,
                kind: options.kind,
                title: options.initialTitle,
                notes: options.initialNotes,
                focusField: restore?.focusField ?? 'title',
                titleCursor: restore?.titleCursor ?? -1,
                notesCursor: restore?.notesCursor ?? -1,
                titleBound: restore?.titleBound ?? -1,
                notesBound: restore?.notesBound ?? -1,
                liveTitleEntry: titleEntry,
                liveDescEntry: descEntry,
            };
        };

        const addSubtaskButton = new St.Button({
            style_class: 'task-subtask-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'list-add-symbolic',
                icon_size: 12,
            }),
        });
        addSubtaskButton.opacity = 0;

        const openEditForm = (
            presetTitle?: string,
            presetNotes?: string,
            restore?: FormRestoreState,
        ) => {
            if (!onEdit)
                return;
            openInlineForm({
                kind: 'edit',
                titleHint: t(this._lang, 'taskTitleHint'),
                initialTitle: presetTitle ?? task.title,
                initialNotes: presetNotes ?? (task.notes || ''),
                colored: true,
                restore,
                onCommit: (title, notes) => onEdit(task, title, notes),
            });
        };

        const openSubtaskForm = (
            presetTitle?: string,
            presetNotes?: string,
            restore?: FormRestoreState,
        ) => {
            if (!onAddSubtask)
                return;
            openInlineForm({
                kind: 'subtask',
                parentLabel: `${t(this._lang, 'subtaskForPrefix')}: ${task.title}`,
                titleHint: t(this._lang, 'subtaskTitleHint'),
                initialTitle: presetTitle ?? '',
                initialNotes: presetNotes ?? '',
                colored: true,
                restore,
                onCommit: (title, notes) => onAddSubtask(task, title, notes),
            });
        };

        if (!isCompleted && !isPending && onAddSubtask && depth <= MAX_DEPTH_THAT_CAN_ADD_SUBTASKS) {
            addSubtaskButton.connect('clicked', () => {
                openSubtaskForm();
                return Clutter.EVENT_STOP;
            });
            hoverButtons.push(addSubtaskButton);
        }

        const editButton = new St.Button({
            style_class: 'task-edit-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'document-edit-symbolic',
                icon_size: 12,
            }),
        });
        editButton.opacity = 0;

        if (onEdit && !isPending) {
            editButton.connect('clicked', () => {
                openEditForm();
                return Clutter.EVENT_STOP;
            });
            hoverButtons.push(editButton);
        }

        let expandButton: St.Button | null = null;
        if (hasChildren && onToggleExpand) {
            expandButton = new St.Button({
                style_class: 'task-expand-button',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    icon_name: isExpanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
                    icon_size: 12,
                }),
            });
            expandButton.connect('clicked', () => {
                onToggleExpand(task);
                return Clutter.EVENT_STOP;
            });
        }
        // No else branch: when this row has no children, nothing is added in its
        // place — content shifts left instead of reserving a fixed-width gap.

        const colorButton = new St.Button({
            style_class: 'task-color-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Widget({
                style_class: `task-color-dot task-color-dot-${currentColor ?? 'none'}`,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        });
        colorButton.opacity = 0;

        if (onColorChange && task.id && !isPending) {
            const colorMenu = new PopupMenu.PopupMenu(colorButton, 0.0, St.Side.TOP);
            Main.uiGroup.add_child(colorMenu.actor);
            colorMenu.actor.hide();
            this._colorMenuManager.addMenu(colorMenu);

            // Build the 7 swatch items lazily, on first click, rather than eagerly
            // for every row on every render — most rows' color pickers are never
            // opened, and rows get fully rebuilt on almost every action.
            let menuItemsBuilt = false;
            const buildMenuItems = () => {
                if (menuItemsBuilt)
                    return;
                menuItemsBuilt = true;
                for (const swatch of TASK_COLOR_PALETTE) {
                    const item = new PopupMenu.PopupBaseMenuItem();
                    const itemBox = new St.BoxLayout({ style_class: 'google-tasks-box' });
                    itemBox.add_child(new St.Widget({
                        style_class: `task-color-dot task-color-dot-${swatch.id}`,
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                    itemBox.add_child(new St.Label({ text: t(this._lang, `color_${swatch.id}`), y_align: Clutter.ActorAlign.CENTER }));
                    item.add_child(itemBox);
                    item.connect('activate', () => {
                        onColorChange(task, swatch.id);
                    });
                    colorMenu.addMenuItem(item);
                }
            };

            colorButton.connect('clicked', () => {
                buildMenuItems();
                colorMenu.toggle();
                return Clutter.EVENT_STOP;
            });
            colorMenu.connect('open-state-changed', (_menu: any, isOpen: boolean) => {
                colorMenuOpen = isOpen;
                updateHoverButtons();

                // A re-render destroys this row, and with it the actor the menu
                // is anchored to — which closed the picker on its own every
                // refresh tick. The section reports the menu as open so the
                // render can wait for it.
                this._openMenuCount += isOpen ? 1 : -1;
                if (this._openMenuCount < 0)
                    this._openMenuCount = 0;
                if (!isOpen && this._openMenuCount === 0)
                    this._onMenusClosed?.();
                return false;
            });
            box.connect('destroy', () => {
                // Close (without animation) before destroying: destroying a menu
                // while it's mid-open/close animation is what triggered the
                // "PopupBaseMenuItem has been already disposed" crash when a
                // re-render tore this row down while the picker was in use.
                colorMenu.close(BoxPointer.PopupAnimation.NONE);
                colorMenu.destroy();
            });
            hoverButtons.push(colorButton);
        }

        const deleteButton = new St.Button({
            style_class: 'task-delete-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: 'user-trash-symbolic',
                icon_size: 12,
            }),
        });
        deleteButton.opacity = 0;

        if (onDelete && task.id && !isPending) {
            deleteButton.connect('clicked', () => {
                closeOpenForm();
                onDelete(task);
                return Clutter.EVENT_STOP;
            });
            hoverButtons.push(deleteButton);
        }

        if (expandButton)
            box.add_child(expandButton);
        if (showRadio)
            box.add_child(radio);
        box.add_child(textBox);

        // The action buttons and the timestamp occupy the same strip at the end
        // of the row, stacked on top of each other rather than side by side:
        // the buttons under the pointer, the timestamp at rest. A BinLayout
        // makes the strip as wide as the wider of the two, so swapping them
        // doesn't resize the title beside it.
        const actionsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            y_align: Clutter.ActorAlign.CENTER,
            // Right-aligned inside the strip, exactly like the timestamp it
            // shares that space with. Without this the buttons sat centered in
            // the strip and ended up short of the row's edge whenever the strip
            // was wider than they are.
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            style_class: 'task-actions',
        });
        if (onColorChange && task.id && !isPending)
            actionsBox.add_child(colorButton);
        if (!isCompleted && !isPending && onAddSubtask && depth <= MAX_DEPTH_THAT_CAN_ADD_SUBTASKS)
            actionsBox.add_child(addSubtaskButton);
        if (onEdit && !isPending)
            actionsBox.add_child(editButton);
        if (onDelete && task.id && !isPending)
            actionsBox.add_child(deleteButton);

        const stampMs = !this._showTaskDate
            ? undefined
            : isCompleted
                ? (task.completed ? Date.parse(task.completed) : undefined)
                : this._taskCreationTimes.get(task.id);

        if (stampMs === undefined || Number.isNaN(stampMs)) {
            // No strip to share, so the buttons keep their natural width.
            actionsBox.x_expand = false;
            box.add_child(actionsBox);
        }
        else {
            // FILL, not CENTER: the strip has to span the row's height so the
            // timestamp inside it can align to the top — centered, it landed
            // halfway between the title and the description.
            const trailing = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                style_class: 'task-trailing',
                // Its children expand to fill the strip, but the strip itself
                // must not: set explicitly, this stops the children's expand
                // flag from propagating up and stealing width from the title.
                x_expand: false,
                y_expand: true,
                y_align: Clutter.ActorAlign.FILL,
            });

            const prefix = t(this._lang, isCompleted ? 'completedPrefix' : 'createdPrefix');
            const stampLabel = new St.Label({
                text: `${prefix}${formatTimestamp(stampMs)}`,
                style_class: 'task-date',
                // Expanding to the full width of the strip, with the text itself
                // right-aligned in CSS: the strip is as wide as the action
                // buttons, which differ per row (a leaf task has no "add
                // subtask" button), and a non-expanding label ends up centered
                // in it — so the date sat at a different distance from the edge
                // depending on the row's depth.
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
            });
            // The timestamp is set in a smaller face than the title, so its top
            // edge sits higher. Nudging it down by the difference in ascent puts
            // the two on a common baseline.
            const stampFontSizePx = Math.max(8, this._titleFontSizePx - 3);
            const baselineNudgePx = Math.max(0, Math.round((this._titleFontSizePx - stampFontSizePx) * 0.75));
            stampLabel.set_style(`font-size: ${stampFontSizePx}px; padding-top: ${baselineNudgePx}px;`);

            trailing.add_child(stampLabel);
            trailing.add_child(actionsBox);
            box.add_child(trailing);

            setStampVisible = (visible: boolean) => {
                // Opacity, not visibility: hiding the label would resize the
                // strip, the row would relayout under the pointer, hover would
                // flip, and the buttons would flicker between the two states.
                stampLabel.opacity = visible ? 255 : 0;
            };
        }

        updateHoverButtons();

        if (this._activeFormSnapshot && this._activeFormSnapshot.taskId === task.id) {
            const snapshot = this._activeFormSnapshot;
            this._pendingFormReopen = () => {
                const restore: FormRestoreState = {
                    focusField: snapshot.focusField,
                    titleCursor: snapshot.titleCursor,
                    notesCursor: snapshot.notesCursor,
                    titleBound: snapshot.titleBound,
                    notesBound: snapshot.notesBound,
                };
                if (snapshot.kind === 'edit')
                    openEditForm(snapshot.title, snapshot.notes, restore);
                else
                    openSubtaskForm(snapshot.title, snapshot.notes, restore);
            };
        }

        return box;
    }

    addTask(
        task: GoogleTask,
        isExpanded: boolean,
        onToggleExpand: (task: GoogleTask) => void,
        onComplete?: (task: GoogleTask) => void,
        onEdit?: (task: GoogleTask, title: string, notes: string) => void,
        onAddSubtask?: (task: GoogleTask, title: string, notes: string) => void,
        onDelete?: (task: GoogleTask) => void,
        onColorChange?: (task: GoogleTask, colorId: string) => void,
        depth: number = 0,
    ) {
        const row = this._createTaskRow(task, false, isExpanded, onComplete, undefined, onEdit, onAddSubtask, onDelete, onColorChange, onToggleExpand, depth);
        this._activeTasksList.add_child(row);
    }

    addCompletedTask(
        task: GoogleTask,
        isExpanded: boolean,
        canUncomplete: boolean,
        onToggleExpand: (task: GoogleTask) => void,
        onUncomplete?: (task: GoogleTask) => void,
        onEdit?: (task: GoogleTask, title: string, notes: string) => void,
        onDelete?: (task: GoogleTask) => void,
        onColorChange?: (task: GoogleTask, colorId: string) => void,
        depth: number = 0,
    ) {
        const row = this._createTaskRow(task, true, isExpanded, undefined, onUncomplete, onEdit, undefined, onDelete, onColorChange, onToggleExpand, depth, canUncomplete);
        this._completedTasksList.add_child(row);
    }

    setCompletedTasks(
        tasks: GoogleTask[],
        isTaskExpanded: (taskId: string) => boolean,
        canUncomplete: (task: GoogleTask) => boolean,
        onToggleExpand: (task: GoogleTask) => void,
        onUncomplete?: (task: GoogleTask) => void,
        onEdit?: (task: GoogleTask, title: string, notes: string) => void,
        onDelete?: (task: GoogleTask) => void,
        onColorChange?: (task: GoogleTask, colorId: string) => void,
    ) {
        this._completedTasksList.destroy_all_children();

        if (tasks.length === 0) {
            this._completedHeaderButton.visible = false;
            this._completedTasksList.visible = false;
            return;
        }

        this._completedHeaderButton.visible = true;
        this._addCompletedTaskTree(tasks, isTaskExpanded, canUncomplete, onToggleExpand, onUncomplete, onEdit, onDelete, onColorChange);
        this._setCompletedExpanded(this._completedExpanded);
    }

    private _addCompletedTaskTree(
        tasks: GoogleTask[],
        isTaskExpanded: (taskId: string) => boolean,
        canUncomplete: (task: GoogleTask) => boolean,
        onToggleExpand: (task: GoogleTask) => void,
        onUncomplete?: (task: GoogleTask) => void,
        onEdit?: (task: GoogleTask, title: string, notes: string) => void,
        onDelete?: (task: GoogleTask) => void,
        onColorChange?: (task: GoogleTask, colorId: string) => void,
        depth: number = 0,
    ) {
        for (const task of tasks) {
            const expanded = isTaskExpanded(task.id);
            if (task.title)
                this.addCompletedTask(task, expanded, canUncomplete(task), onToggleExpand, onUncomplete, onEdit, onDelete, onColorChange, depth);
            if (task.children && task.children.length > 0 && expanded)
                this._addCompletedTaskTree(task.children, isTaskExpanded, canUncomplete, onToggleExpand, onUncomplete, onEdit, onDelete, onColorChange, depth + 1);
        }
    }

    private _setCompletedExpanded(expanded: boolean) {
        this._completedExpanded = expanded;
        this._completedTasksList.visible = this._completedExpanded;
        this._completedChevronIcon.icon_name = this._completedExpanded
            ? 'pan-down-symbolic'
            : 'pan-end-symbolic';
    }

    clearTasks() {
        if (this._activeFormSnapshot) {
            const snapshot = this._activeFormSnapshot;
            const focused = (globalThis as any).global?.stage?.get_key_focus?.() ?? null;

            if (snapshot.liveTitleEntry) {
                snapshot.title = snapshot.liveTitleEntry.get_text();
                snapshot.titleCursor = snapshot.liveTitleEntry.clutter_text.get_cursor_position();
                snapshot.titleBound = snapshot.liveTitleEntry.clutter_text.get_selection_bound();
                if (focused && focused === snapshot.liveTitleEntry.clutter_text)
                    snapshot.focusField = 'title';
            }
            if (snapshot.liveDescEntry) {
                snapshot.notes = snapshot.liveDescEntry.get_text();
                snapshot.notesCursor = snapshot.liveDescEntry.clutter_text.get_cursor_position();
                snapshot.notesBound = snapshot.liveDescEntry.clutter_text.get_selection_bound();
                if (focused && focused === snapshot.liveDescEntry.clutter_text)
                    snapshot.focusField = 'notes';
            }

            snapshot.liveTitleEntry = null;
            snapshot.liveDescEntry = null;
        }

        this._activeTasksList.destroy_all_children();
        this._completedTasksList.destroy_all_children();
        this._completedHeaderButton.visible = false;
        // Only hide the container here — do NOT touch this._completedExpanded.
        // clearTasks() runs at the start of every re-render (which now happens
        // after almost every action thanks to optimistic updates), so resetting
        // the persisted flag here was collapsing an open "Completed" section on
        // every single click. setCompletedTasks(), called right after this,
        // restores the real state via _setCompletedExpanded(this._completedExpanded).
        this._completedTasksList.visible = false;
    }

    // Shows a large centered placeholder in place of the task list — used for
    // "no tasks" / "no task lists" instead of faking it as a task row (which
    // rendered with a checkbox and strikethrough, since the row styling assumes
    // a real task).
    showEmptyState(message: string) {
        this.clearTasks();

        const container = new St.BoxLayout({
            style_class: 'google-tasks-empty-state-container',
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const opacity = Math.round(Math.min(100, Math.max(0, this._emptyStateOpacityPercent)) * 2.55);

        const icon = new St.Icon({
            icon_name: this._emptyStateIcon,
            icon_size: this._emptyStateIconSizePx,
            style_class: 'google-tasks-empty-state-icon',
            x_align: Clutter.ActorAlign.CENTER,
        });
        icon.opacity = opacity;

        const label = new St.Label({
            text: message,
            style_class: 'google-tasks-empty-state',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.set_style(`font-size: ${this._emptyStateFontSizePx}px;`);
        label.opacity = opacity;
        label.clutter_text.set_line_wrap(false);
        label.clutter_text.set_ellipsize(0);
        setupRichLabel(label, {
            getStrings: () => textStrings(this._lang),
            text: message,
            enableLinks: false,
        });

        container.add_child(icon);
        container.add_child(label);
        this._activeTasksList.add_child(container);
    }
});

type TasksSectionInstance = InstanceType<typeof TasksSection>;

const REFRESH_INTERVAL_SECONDS = 20;
const DEFAULT_COLUMN_WIDTH_PX = 520;
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

type TaskSortOrder = 'my-order' | 'date' | 'deadline' | 'starred-recently' | 'title';
type TaskTimeframe = 'all' | 'today' | 'this-week' | 'this-month';

const VALID_TASK_SORT_ORDERS = new Set<TaskSortOrder>(['my-order', 'date', 'deadline', 'starred-recently', 'title']);
const VALID_TASK_TIMEFRAMES = new Set<TaskTimeframe>(['all', 'today', 'this-week', 'this-month']);

export default class GoogleTasksExtension extends Extension {
    private _tasksSection: TasksSectionInstance | null = null;
    private _tasksManager: GoogleTasksManager | null = null;
    private _settings: Gio.Settings | null = null;
    private _settingsChangedId: number | null = null;
    private _sortOrderChangedId: number | null = null;
    private _showCompletedChangedId: number | null = null;
    private _showTaskDateChangedId: number | null = null;
    private _timeframeChangedId: number | null = null;
    private _languageChangedId: number | null = null;
    private _columnWidthChangedId: number | null = null;
    private _cornerRadiusChangedId: number | null = null;
    private _titleFontSizeChangedId: number | null = null;
    private _descriptionFontSizeChangedId: number | null = null;
    private _taskBlockSizeChangedId: number | null = null;
    private _subtaskBlockSizeChangedId: number | null = null;
    private _radioSizeChangedId: number | null = null;
    private _emptyStateIconChangedId: number | null = null;
    private _emptyStateIconSizeChangedId: number | null = null;
    private _emptyStateFontSizeChangedId: number | null = null;
    private _emptyStateOpacityChangedId: number | null = null;
    private _refreshTimerId: number | null = null;
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
    private _taskMutationQueues: Map<string, Promise<unknown>> = new Map();
    private _pendingStatusOverrides: Map<string, { status: string; expiresAt: number }> = new Map();

    // Ids deleted locally that the server may still hand back: Google's read
    // replicas lag behind writes, so a refresh landing right after a delete
    // resurrects the row and the next one removes it again. An entry is dropped
    // as soon as a fetch stops mentioning the id, or after the TTL.
    private _pendingDeletions: Map<string, number> = new Map();

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
                return false;
            });
            this._dateMenu = dateMenu.menu;
        }

        const menuBox = dateMenu._box || dateMenu.menu?.box;
        if (menuBox) {
            this._columnContainer = new St.BoxLayout({
                vertical: true,
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
                if (child.constructor.name.includes('Calendar') ||
                    child.style_class?.includes('calendar')) {
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
            this._settingsChangedId = this._settings.connect(`changed::${REFRESH_INTERVAL_KEY}`, () => {
                this._startRefreshTimer();
            });
            this._sortOrderChangedId = this._settings.connect(`changed::${TASK_SORT_ORDER_KEY}`, () => {
                this._renderCurrentTaskList();
            });
            this._showCompletedChangedId = this._settings.connect(`changed::${SHOW_COMPLETED_TASKS_KEY}`, () => {
                this._refreshTasks();
            });
            this._showTaskDateChangedId = this._settings.connect(`changed::${SHOW_TASK_DATE_KEY}`, () => {
                this._tasksSection?.setShowTaskDate(this._getShowTaskDate());
                this._renderCurrentTaskList();
            });
            this._timeframeChangedId = this._settings.connect(`changed::${TASK_TIMEFRAME_KEY}`, () => {
                this._renderCurrentTaskList();
            });
            this._languageChangedId = this._settings.connect(`changed::${LANGUAGE_KEY}`, () => {
                this._applyLanguage();
            });
            this._columnWidthChangedId = this._settings.connect(`changed::${COLUMN_WIDTH_KEY}`, () => {
                this._applyColumnWidth();
            });
            this._cornerRadiusChangedId = this._settings.connect(`changed::${CORNER_RADIUS_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._titleFontSizeChangedId = this._settings.connect(`changed::${TITLE_FONT_SIZE_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._descriptionFontSizeChangedId = this._settings.connect(`changed::${DESCRIPTION_FONT_SIZE_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._taskBlockSizeChangedId = this._settings.connect(`changed::${TASK_BLOCK_SIZE_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._subtaskBlockSizeChangedId = this._settings.connect(`changed::${SUBTASK_BLOCK_SIZE_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._radioSizeChangedId = this._settings.connect(`changed::${RADIO_SIZE_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._emptyStateIconChangedId = this._settings.connect(`changed::${EMPTY_STATE_ICON_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._emptyStateIconSizeChangedId = this._settings.connect(`changed::${EMPTY_STATE_ICON_SIZE_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._emptyStateFontSizeChangedId = this._settings.connect(`changed::${EMPTY_STATE_FONT_SIZE_KEY}`, () => {
                this._scheduleRenderOnly();
            });
            this._emptyStateOpacityChangedId = this._settings.connect(`changed::${EMPTY_STATE_OPACITY_KEY}`, () => {
                this._scheduleRenderOnly();
            });
        }

        this._refreshTasks();
        this._startRefreshTimer();
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
        GLib.mkdir_with_parents(dir, 0o755);
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
            const parsed = JSON.parse(new TextDecoder().decode(contents)) as Record<string, number>;
            this._taskCreationTimes = new Map(Object.entries(parsed));
        }
        catch (e) {
            console.error(`Google Tasks: Failed to load task creation times: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    _saveTaskCreationTimes() {
        try {
            const file = this._getTaskCreationTimesFile();
            const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(this._taskCreationTimes)));
            file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        }
        catch (e) {
            console.error(`Google Tasks: Failed to save task creation times: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // Records a creation time for tasks not seen before and drops records of
    // tasks that no longer exist. Returns true when the map needs saving.
    _syncTaskCreationTimes(allTasks: GoogleTask[]): boolean {
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

        for (const id of [...this._taskCreationTimes.keys()]) {
            if (!liveIds.has(id) && !this._pendingDeletions.has(id)) {
                this._taskCreationTimes.delete(id);
                changed = true;
            }
        }

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
            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text) as Record<string, string>;
            this._taskColors = new Map(Object.entries(parsed));
        }
        catch (e) {
            console.error(`Google Tasks: Failed to load task colors: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    _saveTaskColors() {
        try {
            const file = this._getTaskColorsFile();
            const obj = Object.fromEntries(this._taskColors);
            const bytes = new TextEncoder().encode(JSON.stringify(obj));
            file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        }
        catch (e) {
            console.error(`Google Tasks: Failed to save task colors: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    _onTaskColorChange(task: GoogleTask, colorId: string) {
        if (!task.id)
            return;
        if (colorId === 'none')
            this._taskColors.delete(task.id);
        else
            this._taskColors.set(task.id, colorId);
        this._saveTaskColors();
        this._renderCurrentTaskList();
    }

    // Subtasks default to expanded (a task id not in the set is expanded).
    _isTaskExpanded(taskId: string): boolean {
        return !this._collapsedTaskIds.has(taskId);
    }

    // A subtask can't leave "completed" while its parent is still completed —
    // the parent must be uncompleted first.
    _canUncomplete(task: GoogleTask): boolean {
        if (!task.parent || !task.taskListId)
            return true;
        const completedTasks = this._completedTasksByListId.get(task.taskListId);
        if (!completedTasks)
            return true;
        return !completedTasks.some(t => t.id === task.parent);
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
        this._renderCurrentTaskList();

        this._pendingMutations++;
        try {
            const created = await withRetry(() => this._tasksManager!.createTask(title, description || undefined, resolvedListId, parentTaskId));

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
        this._refreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._getRefreshIntervalSeconds(), () => {
            if (this._pendingMutations === 0)
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
        this._tasksSection.setEmptyStateIcon(this._getEmptyStateIcon());
        this._tasksSection.setEmptyStateIconSize(this._getEmptyStateIconSizePx());
        this._tasksSection.setEmptyStateFontSize(this._getEmptyStateFontSizePx());
        this._tasksSection.setEmptyStateOpacity(this._getEmptyStateOpacityPercent());

        this._tasksSection.setTaskLists(this._taskLists, selectedTaskListId, (taskListId) => {
            this._selectedTaskListId = taskListId;
            this._renderCurrentTaskList();
        });

        const activeTasks = this._sortTaskTree(
            this._filterTaskTreeByTimeframe(this._buildTaskTree(this._activeTasksByListId.get(selectedTaskListId) ?? [])),
        );

        // Completed задачи НЕ фильтруем по timeframe — показываем ВСЕ.
        // ВАЖНО: не гейтить этот блок настройкой showCompletedTasks — секция сама
        // управляет видимостью через шеврон "Completed". Если здесь снова появится
        // условие `showCompletedTasks ? ... : []`, завершённые задачи опять
        // перестанут показываться независимо от того, что возвращает API.
        const completedTasks = this._sortTaskTree(
            this._buildTaskTree(this._completedTasksByListId.get(selectedTaskListId) ?? []),
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

    // Runs a network mutation for a given task id strictly after any earlier
    // still-in-flight mutation for that SAME task id has settled — never
    // concurrently. Without this, quickly flipping a task between active and
    // completed fires a completeTask and an uncompleteTask request in parallel;
    // if their responses arrive out of send-order, the server ends up in the
    // state opposite of the user's last click, and the next background
    // reconcile then visibly "rolls back" what looked like a successful action.
    // Each call also retries on failure (see withRetry) instead of giving up
    // after one attempt.
    _runTaskMutation<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
        const previous = this._taskMutationQueues.get(taskId) ?? Promise.resolve();
        const run = previous.then(() => withRetry(fn), () => withRetry(fn));
        // Keep the queue alive regardless of outcome, so a later action on this
        // same task still waits its turn instead of racing ahead of this one.
        this._taskMutationQueues.set(taskId, run.catch(() => undefined));
        return run;
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
                this._runTaskMutation(task.id, () => this._tasksManager!.deleteTask(listId, task.id))
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

        // Completed tasks are always fetched
        const includeCompletedTasks = true;
        const requestId = ++this._refreshRequestSeq;

        try {
            const { lists: taskLists, tasks: allTasks } = await this._tasksManager.getListsAndTasks(includeCompletedTasks);

            if (!this._tasksSection || !this._tasksManager)
                return;

            // A newer refresh (or an optimistic action started after this one) has
            // already been issued — this response is stale. Applying it now would
            // overwrite more-recent state with older data, which is what made
            // tasks flicker or land back in the wrong section.
            if (requestId !== this._refreshRequestSeq)
                return;

            this._taskLists = taskLists;
            this._activeTasksByListId = new Map(taskLists.map(list => [list.id, []] as [string, GoogleTask[]]));
            this._completedTasksByListId = new Map(taskLists.map(list => [list.id, []] as [string, GoogleTask[]]));

            const nowMs = Date.now();
            for (const [id, expiresAt] of this._pendingDeletions) {
                if (nowMs > expiresAt)
                    this._pendingDeletions.delete(id);
            }
            if (this._pendingDeletions.size > 0) {
                const seenIds = new Set<string>();
                for (const fetched of allTasks)
                    seenIds.add(fetched.id);
                for (const id of [...this._pendingDeletions.keys()]) {
                    if (!seenIds.has(id))
                        this._pendingDeletions.delete(id);
                }
            }

            if (this._syncTaskCreationTimes(allTasks))
                this._saveTaskCreationTimes();

            for (const task of allTasks) {
                if (!task.taskListId)
                    continue;
                if (this._pendingDeletions.has(task.id))
                    continue;

                let effectiveStatus = task.status;
                const override = this._pendingStatusOverrides.get(task.id);
                if (override) {
                    if (Date.now() > override.expiresAt) {
                        this._pendingStatusOverrides.delete(task.id);
                    }
                    else if (task.status !== override.status) {
                        // The fetch disagrees with what we just set — likely a
                        // stale (not-yet-replicated) read. Trust our own recent
                        // action instead of visibly flipping the row back.
                        effectiveStatus = override.status;
                    }
                    else {
                        // The fetch now agrees — the server has caught up.
                        this._pendingStatusOverrides.delete(task.id);
                    }
                }

                if (effectiveStatus === 'completed') {
                    const completedListTasks = this._completedTasksByListId.get(task.taskListId);
                    if (completedListTasks)
                        completedListTasks.push(effectiveStatus === task.status ? task : { ...task, status: effectiveStatus });
                }
                else {
                    const activeListTasks = this._activeTasksByListId.get(task.taskListId);
                    if (activeListTasks)
                        activeListTasks.push(effectiveStatus === task.status ? task : { ...task, status: effectiveStatus });
                }
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

    _buildTaskTree(tasks: GoogleTask[]): GoogleTask[] {
        const taskNodes = new Map<string, GoogleTask>();
        const rootTasks: GoogleTask[] = [];

        for (const task of tasks)
            taskNodes.set(task.id, { ...task, children: [] });

        for (const task of tasks) {
            const taskNode = taskNodes.get(task.id);
            if (!taskNode)
                continue;
            const parentNode = task.parent ? taskNodes.get(task.parent) : null;
            if (parentNode?.children)
                parentNode.children.push(taskNode);
            else
                rootTasks.push(taskNode);
        }

        return rootTasks;
    }

    // Resolves each task's "effective" color: its own explicit color if set,
    // otherwise inherited from the nearest ancestor that has one. Walks the
    // already-built tree, so a grandchild correctly inherits through its parent
    // subtask even when that parent itself has no explicit color of its own.
    // Resolves each task's "effective" color (own explicit color, or inherited
    // from the nearest colored ancestor) by walking the real .parent chain
    // against a combined active+completed lookup for the list — not the
    // per-status tree. That matters because a completed subtask's parent may
    // still be active (or otherwise outside the tree being rendered): the old
    // tree-walk version treated such a subtask as a colorless root, losing its
    // inherited tint. Looking the parent up directly by id fixes that.
    _computeEffectiveColors(taskListId: string): Map<string, string> {
        const allTasksById = new Map<string, GoogleTask>();
        for (const t of this._activeTasksByListId.get(taskListId) ?? [])
            allTasksById.set(t.id, t);
        for (const t of this._completedTasksByListId.get(taskListId) ?? [])
            allTasksById.set(t.id, t);

        const resolve = (taskId: string, visited: Set<string>): string | undefined => {
            if (visited.has(taskId))
                return undefined;
            visited.add(taskId);
            const ownColor = this._taskColors.get(taskId);
            if (ownColor && ownColor !== 'none')
                return ownColor;
            const parentId = allTasksById.get(taskId)?.parent;
            return parentId ? resolve(parentId, visited) : undefined;
        };

        const result = new Map<string, string>();
        for (const id of allTasksById.keys()) {
            const effective = resolve(id, new Set());
            if (effective)
                result.set(id, effective);
        }
        return result;
    }

    // Every descendant (children, grandchildren, ...) of rootId within a flat,
    // parent-linked task array. A subtask can't exist without its parent, so
    // completing or deleting a task cascades to all of these.
    _collectDescendantIds(rootId: string, tasks: GoogleTask[]): string[] {
        const result: string[] = [];
        const frontier = [rootId];
        while (frontier.length > 0) {
            const currentId = frontier.pop()!;
            for (const t of tasks) {
                if (t.parent === currentId) {
                    result.push(t.id);
                    frontier.push(t.id);
                }
            }
        }
        return result;
    }

    _filterTaskTreeByTimeframe(tasks: GoogleTask[]): GoogleTask[] {
        if (this._getTaskTimeframe() === 'all')
            return tasks;

        const filteredTasks: GoogleTask[] = [];
        for (const task of tasks) {
            const filteredChildren = task.children ? this._filterTaskTreeByTimeframe(task.children) : [];
            const taskMatches = this._filterTasksByTimeframe([task]).length > 0;
            if (taskMatches) {
                filteredTasks.push(task);
            }
            else if (filteredChildren.length > 0) {
                filteredTasks.push({ ...task, children: filteredChildren });
            }
        }
        return filteredTasks;
    }

    _sortTaskTree(tasks: GoogleTask[]): GoogleTask[] {
        return this._sortTasks(tasks).map(task => ({
            ...task,
            children: task.children ? this._sortTaskTree(task.children) : [],
        }));
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

    _filterTasksByTimeframe(tasks: GoogleTask[]): GoogleTask[] {
        const timeframe = this._getTaskTimeframe();
        if (timeframe === 'all')
            return tasks;

        const today = this._formatLocalDate(new Date());

        if (timeframe === 'today') {
            return tasks.filter((task) => {
                const dueDate = this._getTaskDueDate(task);
                return dueDate === null || dueDate === today;
            });
        }

        if (timeframe === 'this-week') {
            const now = new Date();
            const dayOfWeek = now.getDay();
            const daysSinceMonday = (dayOfWeek + 6) % 7;
            const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
            const endOfWeek = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate() + 6);
            const startDate = this._formatLocalDate(startOfWeek);
            const endDate = this._formatLocalDate(endOfWeek);
            return tasks.filter((task) => {
                const dueDate = this._getTaskDueDate(task);
                return dueDate === null || (dueDate >= startDate && dueDate <= endDate);
            });
        }

        if (timeframe === 'this-month') {
            const now = new Date();
            const currentYear = now.getFullYear();
            const currentMonth = now.getMonth();
            return tasks.filter((task) => {
                const dueDate = this._getTaskDueDate(task);
                if (!dueDate)
                    return true;
                const dueDateParts = dueDate.split('-');
                if (dueDateParts.length !== 3)
                    return false;
                const dueYear = Number.parseInt(dueDateParts[0], 10);
                const dueMonth = Number.parseInt(dueDateParts[1], 10) - 1;
                return dueYear === currentYear && dueMonth === currentMonth;
            });
        }

        return tasks;
    }

    _getTaskDueDate(task: GoogleTask): string | null {
        if (!task.due)
            return null;

        const dueDatePrefix = task.due.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(dueDatePrefix)) {
            const parsedDate = new Date(`${dueDatePrefix}T00:00:00`);
            if (!Number.isNaN(parsedDate.getTime()) && this._formatLocalDate(parsedDate) === dueDatePrefix)
                return dueDatePrefix;
        }

        const parsedTime = Date.parse(task.due);
        if (Number.isNaN(parsedTime))
            return null;

        return this._formatLocalDate(new Date(parsedTime));
    }

    _formatLocalDate(date: Date): string {
        const year = date.getFullYear();
        const month = `${date.getMonth() + 1}`.padStart(2, '0');
        const day = `${date.getDate()}`.padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    _sortTasks(tasks: GoogleTask[]): GoogleTask[] {
        const sortedTasks = [...tasks];
        const sortOrder = this._getTaskSortOrder();

        switch (sortOrder) {
            case 'title':
                sortedTasks.sort((a, b) => a.title.localeCompare(b.title));
                break;
            case 'date':
            case 'starred-recently':
                sortedTasks.sort((a, b) => this._parseTimestamp(b.updated) - this._parseTimestamp(a.updated));
                break;
            case 'deadline':
                sortedTasks.sort((a, b) => this._compareDeadline(a.due, b.due));
                break;
            case 'my-order':
            default:
                sortedTasks.sort((a, b) => this._comparePosition(a.position, b.position));
                break;
        }

        return sortedTasks;
    }

    _parseTimestamp(value?: string): number {
        if (!value)
            return 0;
        const timestamp = Date.parse(value);
        return Number.isNaN(timestamp) ? 0 : timestamp;
    }

    _compareDeadline(left?: string, right?: string): number {
        const leftTimestamp = this._parseTimestamp(left);
        const rightTimestamp = this._parseTimestamp(right);
        if (leftTimestamp === 0 && rightTimestamp === 0)
            return 0;
        if (leftTimestamp === 0)
            return 1;
        if (rightTimestamp === 0)
            return -1;
        return leftTimestamp - rightTimestamp;
    }

    _comparePosition(left?: string, right?: string): number {
        if (!left && !right)
            return 0;
        if (!left)
            return 1;
        if (!right)
            return -1;
        return left.localeCompare(right);
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
        this._renderCurrentTaskList();

        this._pendingMutations++;
        this._runTaskMutation(task.id, () => this._tasksManager!.updateTask(taskListId, task.id, title, notes))
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
        const idsToComplete = [task.id, ...this._collectDescendantIds(task.id, activeTasks)];

        // Move it locally and re-render right away — the previous version waited
        // for the completeTask() network round trip, then a *second* full
        // getTaskLists+getTasks refetch on a 50ms delay, which is what made
        // completing a task feel slow.
        const expiresAt = Date.now() + STATUS_OVERRIDE_TTL_MS;
        for (const id of idsToComplete) {
            this._pendingStatusOverrides.set(id, { status: 'completed', expiresAt });
            const index = activeTasks.findIndex(t => t.id === id);
            if (index >= 0) {
                const [moved] = activeTasks.splice(index, 1);
                completedTasks.push({ ...moved, status: 'completed' });
            }
        }

        this._renderCurrentTaskList();

        this._pendingMutations++;
        Promise.all(idsToComplete.map(id => this._runTaskMutation(id, () => this._tasksManager!.completeTask(taskListId, id))))
            .then(() => this._scheduleReconcile())
            .catch((e) => {
                if (isCancelledError(e))
                    return;
                console.error(`Google Tasks: Failed to mark task completed: ${e instanceof Error ? e.message : String(e)}`);
                // Drop the optimistic state instead of letting it stand until
                // its TTL: otherwise a failed move looks like it worked, then
                // silently undoes itself half a minute later.
                for (const id of idsToComplete)
                    this._pendingStatusOverrides.delete(id);
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

        this._pendingStatusOverrides.set(task.id, { status: 'needsAction', expiresAt: Date.now() + STATUS_OVERRIDE_TTL_MS });

        const activeTasks = this._activeTasksByListId.get(taskListId);
        if (activeTasks)
            activeTasks.push({ ...task, status: 'needsAction' });

        this._renderCurrentTaskList();

        if (!this._tasksManager)
            return;

        try {
            this._pendingMutations++;
            await this._runTaskMutation(task.id, () => this._tasksManager!.uncompleteTask(taskListId, task.id));
            this._scheduleReconcile();
        }
        catch (e) {
            if (isCancelledError(e))
                return;
            console.error(`Google Tasks: Failed to mark task unfinished: ${e instanceof Error ? e.message : String(e)}`);
            this._pendingStatusOverrides.delete(task.id);
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
        const idsToDelete = new Set([task.id, ...this._collectDescendantIds(task.id, allInList)]);

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
        const deletionExpiresAt = Date.now() + STATUS_OVERRIDE_TTL_MS;
        for (const id of idsToDelete) {
            this._pendingStatusOverrides.delete(id);
            this._pendingDeletions.set(id, deletionExpiresAt);
        }
        // Any refresh in flight predates this delete and still believes the
        // task exists — make its response stale.
        this._refreshRequestSeq++;
        this._renderCurrentTaskList();

        this._pendingMutations++;
        Promise.all(Array.from(idsToDelete).map(id => this._runTaskMutation(id, () => this._tasksManager!.deleteTask(taskListId, id))))
            .then(() => this._scheduleReconcile())
            .catch((e) => {
                if (isCancelledError(e))
                    return;
                console.error(`Google Tasks: Failed to delete task: ${e instanceof Error ? e.message : String(e)}`);
                for (const id of idsToDelete)
                    this._pendingDeletions.delete(id);
                this._refreshTasks();
            })
            .finally(() => {
                this._pendingMutations--;
            });
    }

    disable() {
        this._stopRefreshTimer();
        setOnContextMenuClosed(null);
        this._lastRenderSignature = null;
        this._renderDeferred = false;
        this._pendingDeletions.clear();
        this._pendingStatusOverrides.clear();
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
        this._taskMutationQueues.clear();

        if (this._settings && this._settingsChangedId !== null) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._settings && this._sortOrderChangedId !== null) {
            this._settings.disconnect(this._sortOrderChangedId);
            this._sortOrderChangedId = null;
        }
        if (this._settings && this._showCompletedChangedId !== null) {
            this._settings.disconnect(this._showCompletedChangedId);
            this._showCompletedChangedId = null;
        }
        if (this._settings && this._showTaskDateChangedId !== null) {
            this._settings.disconnect(this._showTaskDateChangedId);
            this._showTaskDateChangedId = null;
        }
        if (this._settings && this._timeframeChangedId !== null) {
            this._settings.disconnect(this._timeframeChangedId);
            this._timeframeChangedId = null;
        }
        if (this._settings && this._languageChangedId !== null) {
            this._settings.disconnect(this._languageChangedId);
            this._languageChangedId = null;
        }
        if (this._settings && this._columnWidthChangedId !== null) {
            this._settings.disconnect(this._columnWidthChangedId);
            this._columnWidthChangedId = null;
        }
        if (this._settings && this._cornerRadiusChangedId !== null) {
            this._settings.disconnect(this._cornerRadiusChangedId);
            this._cornerRadiusChangedId = null;
        }
        if (this._settings && this._titleFontSizeChangedId !== null) {
            this._settings.disconnect(this._titleFontSizeChangedId);
            this._titleFontSizeChangedId = null;
        }
        if (this._settings && this._descriptionFontSizeChangedId !== null) {
            this._settings.disconnect(this._descriptionFontSizeChangedId);
            this._descriptionFontSizeChangedId = null;
        }
        if (this._settings && this._taskBlockSizeChangedId !== null) {
            this._settings.disconnect(this._taskBlockSizeChangedId);
            this._taskBlockSizeChangedId = null;
        }
        if (this._settings && this._subtaskBlockSizeChangedId !== null) {
            this._settings.disconnect(this._subtaskBlockSizeChangedId);
            this._subtaskBlockSizeChangedId = null;
        }
        if (this._settings && this._radioSizeChangedId !== null) {
            this._settings.disconnect(this._radioSizeChangedId);
            this._radioSizeChangedId = null;
        }
        if (this._settings && this._emptyStateIconChangedId !== null) {
            this._settings.disconnect(this._emptyStateIconChangedId);
            this._emptyStateIconChangedId = null;
        }
        if (this._settings && this._emptyStateIconSizeChangedId !== null) {
            this._settings.disconnect(this._emptyStateIconSizeChangedId);
            this._emptyStateIconSizeChangedId = null;
        }
        if (this._settings && this._emptyStateFontSizeChangedId !== null) {
            this._settings.disconnect(this._emptyStateFontSizeChangedId);
            this._emptyStateFontSizeChangedId = null;
        }
        if (this._settings && this._emptyStateOpacityChangedId !== null) {
            this._settings.disconnect(this._emptyStateOpacityChangedId);
            this._emptyStateOpacityChangedId = null;
        }

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