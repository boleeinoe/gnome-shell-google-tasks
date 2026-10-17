// The task panel itself: the list picker, the "my tasks" and "completed"
// blocks, task rows with their inline forms and color pickers. Knows
// nothing about Google or settings storage; GoogleTasksExtension feeds it.
import type { Lang } from './i18n.js';
import type { GoogleTask, GoogleTaskList } from './tasksManager.js';
import type { Rgb } from './taskStyle.js';
import type { ContextMenuItem } from './textInteraction.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
  t,
  textStrings,
} from './i18n.js';
import {
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
} from './settings.js';
import {
  BLOCK_HEADING_ICON_SIZE_PX,
  blockHeadingFontSizePx,
  buildBlockStyle,
  buildMenuStyles,
  buildTaskFormStyle,
  buildTaskRowStyle,
  DEFAULT_RADIO_SIZE_PX,
  DEFAULT_SUBTASK_RADIO_SIZE_PX,
  pickTaskColorBase,
  subtaskIndentPx,
  TASK_COLOR_BASE_DARK,
  TASK_COLOR_HEX,
  themeColorToRgba,
} from './taskStyle.js';
import {
  canAddSubtaskAt,
  clampTaskDepth,
  DEFAULT_SUBTASK_LEVELS,
  normalizeSubtaskLevels,
} from './taskTree.js';
import {
  copyToClipboard,
  enableEntryClipboard,
  isContextMenuOpen,
  setupRichLabel,
} from './textInteraction.js';

// Task blocks: extra alpha for their outline lives in taskStyle.ts; the
// corner radius is read from the theme's notification bubble, capped.
// Used when the notification color can't be read (popup not on stage yet):
// roughly what the default theme gives `.message`.
const BLOCK_FALLBACK_COLOR = { r: 255, g: 255, b: 255, a: 0.08 };
// Background blur behind the task-list picker, so it can carry the same
// translucent notification tint without the task rows showing through.
const DROPDOWN_BLUR_RADIUS_PX = 40;
const BLOCK_FALLBACK_RADIUS_PX = 12;
const BLOCK_MAX_RADIUS_PX = 16;

export const TASK_COLOR_PALETTE: { id: string; label: string }[] = [
  { id: 'none', label: 'No color' },
  { id: 'red', label: 'Red' },
  { id: 'orange', label: 'Orange' },
  { id: 'yellow', label: 'Yellow' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
];

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

// Prefix for the temporary id given to an optimistically-added task, before the
// server has confirmed it and assigned a real id. Rows for such a task hide
// edit/delete/color/complete controls, since those would need a real task id.
export const PENDING_TASK_ID_PREFIX = '__pending_';

export const TasksSection = GObject.registerClass({
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
  // The two styled blocks: "my tasks" (list picker, add form, active tasks
  // with their subtasks) and "completed" (toggle + completed list).
  private _mainBlock!: St.BoxLayout;
  private _completedBlock!: St.BoxLayout;
  // Fills the height between the two blocks. Normally empty (it just keeps
  // "Completed" at the bottom); holds the "no tasks" placeholder, centered,
  // so the main block never has to stretch to center it.
  private _blockSpacer!: St.BoxLayout;
  private _blocksEnabled!: boolean;
  private _blocksOpacityPercent!: number;
  private _blocksEdgeBlurPx!: number;
  // Whether the background blur behind the task-list picker could be set
  // up; without it the picker gets an opaque fill instead.
  private _dropdownBlurred = false;
  // Hidden widget carrying GNOME Shell's own `.message` class — the
  // notification bubble. Its theme node is read back so the blocks follow
  // whatever color the active shell theme gives notifications.
  private _blockColorProbe!: St.Widget;
  private _themeChangedId!: number;

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
  private _subtaskRadioSizePx!: number;
  private _subtaskLevels!: number;
  // Inline styles for popup menus (task-list picker, color pickers), built
  // in _updateBlockStyle(): one for a menu with a background blur, one
  // flattened onto a solid base for when the blur isn't available.
  private _menuStyleBlurred: string | null = null;
  private _taskListsSignature: string | null = null;
  private _menuStyleSolid: string | null = null;
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

  // Explicit, so TypeScript doesn't synthesise `super(...arguments)` for the
  // field initializers above (eslint's prefer-rest-params flags it in dist/).
  // The tuple keeps the call identical: no argument is passed on when none
  // was given, and GObject's constructor still runs _init() as before.
  constructor(...args: [properties?: Partial<St.BoxLayout.ConstructorProps>]) {
    super(...args);
  }

  _init() {
    super._init({
      style_class: 'google-tasks-section',
      orientation: Clutter.Orientation.VERTICAL,
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
    this._subtaskRadioSizePx = DEFAULT_SUBTASK_RADIO_SIZE_PX;
    this._subtaskLevels = DEFAULT_SUBTASK_LEVELS;
    this._emptyStateIcon = DEFAULT_EMPTY_STATE_ICON;
    this._emptyStateIconSizePx = DEFAULT_EMPTY_STATE_ICON_SIZE_PX;
    this._emptyStateFontSizePx = DEFAULT_EMPTY_STATE_FONT_SIZE_PX;
    this._emptyStateOpacityPercent = DEFAULT_EMPTY_STATE_OPACITY_PERCENT;
    this._lang = 'en';
    this._activeFormSnapshot = null;
    this._pendingFormReopen = null;
    this._activeFormCloser = null;
    this._blocksEnabled = DEFAULT_TASK_BLOCKS_ENABLED;
    this._blocksOpacityPercent = DEFAULT_TASK_BLOCKS_OPACITY_PERCENT;
    this._blocksEdgeBlurPx = DEFAULT_TASK_BLOCKS_EDGE_BLUR_PX;

    const box = new St.BoxLayout({
      style_class: 'google-tasks-box',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_expand: true,
    });
    this.add_child(box);

    const titleBox = new St.BoxLayout({ style_class: 'weather-header-box google-tasks-block-header' });

    // Block headings: this label and "Completed" below are the same rank and
    // share the google-tasks-block-heading style and icon size.
    this._taskListDropdownLabel = new St.Label({
      text: t(this._lang, 'taskListsLabel'),
      style_class: 'google-tasks-block-heading',
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
    });
    this._taskListDropdownLabel.clutter_text.set_ellipsize(3);

    const dropdownIcon = new St.Icon({
      icon_name: 'pan-down-symbolic',
      icon_size: BLOCK_HEADING_ICON_SIZE_PX,
      style_class: 'google-tasks-block-heading-icon',
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
    // Painted with the notification bubble's color (see _updateBlockStyle())
    // over a background blur, so it matches the blocks without the task
    // rows under it showing through.
    this._dropdownBlurred = this._decorateMenu(this._taskListDropdownMenu);
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
        icon_size: BLOCK_HEADING_ICON_SIZE_PX,
      }),
    });
    addButton.connect('clicked', () => {
      this._showAddTaskForm();
      return Clutter.EVENT_STOP;
    });

    titleBox.add_child(this._taskListDropdownButton);
    titleBox.add_child(addButton);

    // y_expand is set explicitly so the block hugs its content instead of
    // inheriting the expand flag from the task list inside it; the spacer
    // below takes the leftover height and keeps "Completed" at the bottom.
    this._mainBlock = new St.BoxLayout({
      style_class: 'google-tasks-block google-tasks-block-main',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_expand: false,
    });
    box.add_child(this._mainBlock);
    this._mainBlock.add_child(titleBox);

    this._addTaskForm = new St.BoxLayout({
      style_class: 'google-tasks-add-form',
      orientation: Clutter.Orientation.VERTICAL,
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
    this._mainBlock.add_child(this._addTaskForm);

    this._activeTasksList = new St.BoxLayout({
      style_class: 'tasks-list',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_expand: false,
    });
    this._mainBlock.add_child(this._activeTasksList);

    this._blockSpacer = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_expand: true,
    });
    box.add_child(this._blockSpacer);

    const completedHeaderContent = new St.BoxLayout({
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._completedLabel = new St.Label({
      text: t(this._lang, 'completed'),
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
      style_class: 'google-tasks-block-heading',
    });
    this._completedLabel.clutter_text.set_ellipsize(3);

    this._completedChevronIcon = new St.Icon({
      icon_name: 'pan-end-symbolic',
      icon_size: BLOCK_HEADING_ICON_SIZE_PX,
      style_class: 'google-tasks-block-heading-icon',
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
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      visible: false,
    });

    this._completedBlock = new St.BoxLayout({
      style_class: 'google-tasks-block google-tasks-block-completed',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      visible: false,
    });
    this._completedBlock.add_child(this._completedHeaderButton);
    this._applyHeadingTypography();
    this._completedBlock.add_child(this._completedTasksList);
    box.add_child(this._completedBlock);

    this._blockColorProbe = new St.Widget({ style_class: 'message', visible: false });
    this.add_child(this._blockColorProbe);

    // Re-read the color whenever the popup opens (cheap, and catches a
    // theme switched while it was closed) and live on theme changes.
    this.connect('notify::mapped', () => {
      if (this.mapped)
        this._updateBlockStyle();
    });
    const themeContext = St.ThemeContext.get_for_stage((globalThis as any).global.stage);
    this._themeChangedId = themeContext.connect('changed', () => this._updateBlockStyle());

    this.connect('destroy', () => {
      themeContext.disconnect(this._themeChangedId);
      this._taskListDropdownMenu.close(BoxPointer.PopupAnimation.NONE);
      this._taskListDropdownMenuManager.removeMenu(this._taskListDropdownMenu);
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
    this._applyHeadingTypography();
  }

  // Block headings follow the title size, one step up, so the hierarchy
  // holds whatever size the user picks — and both headings always match.
  private _applyHeadingTypography() {
    const style = `font-size: ${blockHeadingFontSizePx(this._titleFontSizePx)}px;`;
    this._taskListDropdownLabel?.set_style(style);
    this._completedLabel?.set_style(style);
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

  setSubtaskRadioSize(px: number) {
    this._subtaskRadioSizePx = px;
  }

  setSubtaskLevels(levels: number) {
    this._subtaskLevels = normalizeSubtaskLevels(levels);
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

  // Turns the two blocks on/off and sets their opacity (as a percentage of
  // the notification bubble's) and how soft their edges are. Applied
  // immediately — no re-render needed.
  setTaskBlocks(enabled: boolean, opacityPercent: number, edgeBlurPx: number) {
    this._blocksEnabled = enabled;
    this._blocksOpacityPercent = opacityPercent;
    this._blocksEdgeBlurPx = edgeBlurPx;
    this._updateBlockStyle();
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
    }
    else {
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

    // Called on every render (every refresh tick); the menu items only
    // need rebuilding when the lists, their titles or the selection change.
    const signature = [selectedTaskListId, ...taskLists.map(list => `${list.id}\u0001${list.title}`)].join('\u0002');
    if (signature === this._taskListsSignature)
      return;
    this._taskListsSignature = signature;
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
    // Tasks nested deeper than the allowed number of levels (created
    // elsewhere, or before the limit was lowered) sit on the last level.
    depth = clampTaskDepth(depth, this._subtaskLevels);
    const canAddSubtasks = canAddSubtaskAt(depth, this._subtaskLevels);

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

    // The row is the box itself, laid out like any other child of the task
    // list (full width, natural height). Inside it: the accent stripe of a
    // colored task, then everything else in `content`. The stripe is its own
    // actor rather than a left border: St can't draw a one-sided border on
    // a rounded box — the stripe went missing and the corner showed a light
    // crescent where the left and bottom borders met.
    //
    // It used to be overlaid on the box through a BinLayout wrapper, with
    // y_expand on the stripe. Expand flags propagate up the actor tree, so
    // the whole row claimed spare height (a lone completed task filled its
    // block, stripe included) and the wrapper got centered at its natural
    // width instead of spanning the list. Keeping the stripe a plain child
    // that fills the box's height (y_align FILL, no expand) avoids both.
    const content = new St.BoxLayout({
      style_class: 'task-row-content',
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
    });

    // Own explicit color: full strength. Inherited from the parent task:
    // lighter, so it reads as a grouping hint rather than the task's own
    // setting.
    const rowHex = effectiveColor && effectiveColor !== 'none' ? TASK_COLOR_HEX[effectiveColor] : undefined;
    const rowStyle = buildTaskRowStyle({
      blockSizePx: depth > 0 ? this._subtaskBlockSizePx : this._taskBlockSizePx,
      cornerRadiusPx: this._cornerRadiusPx,
      colorHex: rowHex,
      isOwnColor: currentColor === effectiveColor,
      base: rowHex ? this._taskColorBase() : undefined,
      depth,
    });
    box.set_style(rowStyle.style);
    if (rowStyle.stripeStyle) {
      const stripe = new St.Widget({
        style_class: 'task-color-stripe',
        x_expand: false,
        y_expand: false,
        y_align: Clutter.ActorAlign.FILL,
      });
      stripe.set_style(rowStyle.stripeStyle);
      box.add_child(stripe);
    }
    box.add_child(content);

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
    const radioSizePx = depth > 0 ? this._subtaskRadioSizePx : this._radioSizePx;
    radio.set_style(`width: ${radioSizePx}px; height: ${radioSizePx}px;`);

    const checkIcon = new St.Icon({
      icon_name: 'object-select-symbolic',
      style_class: 'task-radio-check',
      icon_size: Math.round(radioSizePx * 1.25),
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
    }
    else {
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

      const form = new St.BoxLayout({ style_class: 'google-tasks-add-form', orientation: Clutter.Orientation.VERTICAL });
      // An edit form lines up with its row; a new subtask's form sits one
      // level further right, where the subtask will appear.
      const formIndentPx = subtaskIndentPx(options.kind === 'subtask' ? depth + 1 : depth);
      const formStyle = [`margin-left: ${formIndentPx}px`];
      if (options.colored && rowHex) {
        // Same treatment as the row (no one-sided border on a rounded
        // box), a shade lighter so the form reads as part of it.
        formStyle.push(buildTaskFormStyle(rowHex, this._cornerRadiusPx, this._taskColorBase()));
      }
      form.set_style(`${formStyle.join('; ')};`);

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

    if (!isCompleted && !isPending && onAddSubtask && canAddSubtasks) {
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
      // The whole picker — menu actor, manager registration, blur, swatch
      // items — is built on the first click, not for every row on every
      // render: most rows' pickers are never opened, and rows get rebuilt
      // on almost every action.
      let colorMenu: PopupMenu.PopupMenu | null = null;
      const ensureColorMenu = (): PopupMenu.PopupMenu => {
        if (colorMenu)
          return colorMenu;
        const menu = new PopupMenu.PopupMenu(colorButton, 0.0, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._colorMenuManager.addMenu(menu);

        // Styled like the task-list picker — without it the menu was
        // see-through and the task rows showed through the swatches.
        const blurred = this._decorateMenu(menu);
        const style = blurred ? this._menuStyleBlurred : this._menuStyleSolid;
        if (style)
          menu.box.set_style(style);

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
          menu.addMenuItem(item);
        }

        menu.connect('open-state-changed', (_menu: any, isOpen: boolean) => {
          colorMenuOpen = isOpen;
          updateHoverButtons();

          // A re-render destroys this row, and with it the actor the
          // menu is anchored to — which closed the picker on its own
          // every refresh tick. The section reports the menu as open
          // so the render can wait for it.
          this._openMenuCount += isOpen ? 1 : -1;
          if (this._openMenuCount < 0)
            this._openMenuCount = 0;
          if (!isOpen && this._openMenuCount === 0)
            this._onMenusClosed?.();
          return false;
        });
        colorMenu = menu;
        return menu;
      };

      colorButton.connect('clicked', () => {
        ensureColorMenu().toggle();
        return Clutter.EVENT_STOP;
      });
      box.connect('destroy', () => {
        if (!colorMenu)
          return;
        const menu = colorMenu;
        colorMenu = null;
        // Close (without animation) before destroying: destroying a menu
        // while it's mid-open/close animation is what triggered the
        // "PopupBaseMenuItem has been already disposed" crash when a
        // re-render tore this row down while the picker was in use.
        menu.close(BoxPointer.PopupAnimation.NONE);
        // Detach from the manager first: it installs a grab helper on
        // colorButton, and dropping the menu without telling it leaves
        // that behind — the shared _colorMenuManager would accumulate
        // one stale registration per past render.
        this._colorMenuManager.removeMenu(menu);
        menu.destroy();
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
      content.add_child(expandButton);
    if (showRadio)
      content.add_child(radio);
    content.add_child(textBox);

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
    if (!isCompleted && !isPending && onAddSubtask && canAddSubtasks)
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
      content.add_child(actionsBox);
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
      content.add_child(trailing);

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

  // Neutral base the task colors are mixed into: dark under light text,
  // light under dark text, so it follows the shell theme.
  private _taskColorBase(): Rgb {
    try {
      if (this.get_stage()) {
        return pickTaskColorBase(themeColorToRgba(this.get_theme_node().get_foreground_color() as any));
      }
    }
    catch (e) {
      console.warn(`[google-tasks] could not read theme foreground color: ${e}`);
    }
    return TASK_COLOR_BASE_DARK;
  }

  // Gives a popup menu the picker look: the shared class (CSS fallback
  // until _updateBlockStyle() runs) and a background blur so a translucent
  // fill doesn't let the task rows show through. Returns whether the blur
  // could be set up.
  private _decorateMenu(menu: PopupMenu.PopupMenu): boolean {
    menu.actor.add_style_class_name('google-tasks-dropdown-menu');
    try {
      const scale = St.ThemeContext.get_for_stage((globalThis as any).global.stage).scale_factor;
      menu.box.add_effect_with_name('google-tasks-dropdown-blur', new Shell.BlurEffect({
        mode: Shell.BlurMode.BACKGROUND,
        radius: DROPDOWN_BLUR_RADIUS_PX * scale,
        brightness: 1.0,
      }));
      return true;
    }
    catch (e) {
      console.warn(`[google-tasks] could not blur a popup menu: ${e}`);
      return false;
    }
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
      this._completedBlock.visible = false;
      return;
    }

    this._completedHeaderButton.visible = true;
    this._completedBlock.visible = true;
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
    this._completedBlock.visible = false;
    this._setEmptyStateLayout(false);
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
      orientation: Clutter.Orientation.VERTICAL,
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
    this._blockSpacer.add_child(container);
    this._setEmptyStateLayout(true);
  }

  // The placeholder sits in the spacer below the main block, centered in the
  // free height; the block itself keeps hugging its content (just the list
  // picker), and the empty task list is hidden so it adds no padding.
  private _setEmptyStateLayout(empty: boolean) {
    if (!empty)
      this._blockSpacer.destroy_all_children();
    this._activeTasksList.visible = !empty;
  }

  // Paints both blocks, and the task-list picker, in GNOME Shell's own
  // notification-bubble color (read from a hidden `.message` probe), so they
  // follow the theme: opaque themes give solid cards, translucent ones keep
  // the blocks translucent. The blocks' alpha is scaled by the opacity
  // setting; the picker always uses the bubble's color as is, over a
  // background blur. Edges are either a 1px outline (edge blur 0) or a soft
  // inner glow of the given width. With blocks turned off, both go back to
  // plain, unpadded boxes; the picker keeps its styling.
  private _updateBlockStyle() {
    let { r, g, b, a } = BLOCK_FALLBACK_COLOR;
    let radius = BLOCK_FALLBACK_RADIUS_PX;
    if (this._blockColorProbe.get_stage()) {
      try {
        const node = this._blockColorProbe.get_theme_node();
        const color = themeColorToRgba(node.get_background_color() as any);
        if (color.a > 0)
          ({ r, g, b, a } = color);
        radius = Math.min(BLOCK_MAX_RADIUS_PX, node.get_border_radius(St.Corner.TOPLEFT));
      }
      catch (e) {
        console.warn(`[google-tasks] could not read notification color: ${e}`);
      }
    }

    // Picker: the bubble's color over a blur of whatever is behind it; if
    // the blur isn't available, flatten the tint onto a solid base.
    const color = { r, g, b, a };
    const menuStyles = buildMenuStyles(color, radius, this._blocksEdgeBlurPx);
    this._menuStyleBlurred = menuStyles.blurred;
    this._menuStyleSolid = menuStyles.solid;
    this._taskListDropdownMenu.box.set_style(this._dropdownBlurred ? this._menuStyleBlurred : this._menuStyleSolid);

    if (!this._blocksEnabled) {
      this._mainBlock.style_class = '';
      this._completedBlock.style_class = '';
      this._mainBlock.set_style(null);
      this._completedBlock.set_style(null);
      return;
    }

    this._mainBlock.style_class = 'google-tasks-block google-tasks-block-main';
    this._completedBlock.style_class = 'google-tasks-block google-tasks-block-completed';

    const style = buildBlockStyle(color, this._blocksOpacityPercent, radius, this._blocksEdgeBlurPx);

    this._mainBlock.set_style(style);
    this._completedBlock.set_style(style);
  }
});

export type TasksSectionInstance = InstanceType<typeof TasksSection>;
