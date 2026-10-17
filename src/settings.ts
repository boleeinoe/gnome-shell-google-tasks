// GSettings keys and the code-side defaults used before settings are
// available. Pure, so prefs.ts, extension.ts and the tests share it; the
// defaults must match the schema (checked by tests/project.test.ts).

export const REFRESH_INTERVAL_SECONDS = 20;

// Task blocks: defaults for the on/off, opacity and edge-blur settings.
// Opacity is a percentage of the notification bubble's own alpha, so 100
// paints the blocks exactly like a notification.
export const DEFAULT_TASK_BLOCKS_ENABLED = true;
export const DEFAULT_TASK_BLOCKS_OPACITY_PERCENT = 100;
export const DEFAULT_TASK_BLOCKS_EDGE_BLUR_PX = 8;

// Corner rounding for a task row's colored background (and its matching inline
// edit form), used as a fallback before settings are available and as the
// GSettings default. The live value comes from the 'corner-radius' key via
// TasksSection.setCornerRadius() — see GoogleTasksExtension._getCornerRadiusPx().
export const DEFAULT_TASK_COLOR_CORNER_RADIUS_PX = 6;
export const DEFAULT_TITLE_FONT_SIZE_PX = 14;
export const DEFAULT_DESCRIPTION_FONT_SIZE_PX = 11;
export const DEFAULT_TASK_BLOCK_SIZE_PX = 4;
export const DEFAULT_SUBTASK_BLOCK_SIZE_PX = 4;
export const DEFAULT_EMPTY_STATE_ICON_SIZE_PX = 64;
export const DEFAULT_EMPTY_STATE_FONT_SIZE_PX = 14;
export const DEFAULT_EMPTY_STATE_OPACITY_PERCENT = 50;

export const DEFAULT_COLUMN_WIDTH_PX = 520;
// How many task lists the list picker shows before it starts scrolling.
export const DEFAULT_LIST_MENU_VISIBLE_LISTS = 8;
export const REFRESH_INTERVAL_KEY = 'refresh-interval';
export const TASK_SORT_ORDER_KEY = 'task-sort-order';
export const SHOW_COMPLETED_TASKS_KEY = 'show-completed-tasks';
export const SHOW_TASK_DATE_KEY = 'show-task-date';
export const TASK_TIMEFRAME_KEY = 'task-timeframe';
export const LANGUAGE_KEY = 'language';
export const COLUMN_WIDTH_KEY = 'column-width';
export const LIST_MENU_VISIBLE_LISTS_KEY = 'list-menu-visible-lists';
export const CORNER_RADIUS_KEY = 'corner-radius';
export const COMPLETED_RETENTION_MINUTES_KEY = 'completed-retention-minutes';
export const TITLE_FONT_SIZE_KEY = 'title-font-size';
export const DESCRIPTION_FONT_SIZE_KEY = 'description-font-size';
export const TASK_BLOCK_SIZE_KEY = 'task-block-size';
export const SUBTASK_BLOCK_SIZE_KEY = 'subtask-block-size';
export const RADIO_SIZE_KEY = 'radio-size';
export const SUBTASK_RADIO_SIZE_KEY = 'subtask-radio-size';
export const SUBTASK_LEVELS_KEY = 'subtask-levels';
// Lowering subtask-levels goes through the extension, which checks every
// task list first (see nestingCheck.ts): the preferences write a request,
// the extension answers in the result key.
export const SUBTASK_LEVELS_REQUEST_KEY = 'subtask-levels-request';
export const SUBTASK_LEVELS_RESULT_KEY = 'subtask-levels-result';
export const EMPTY_STATE_ICON_SIZE_KEY = 'empty-state-icon-size';
export const EMPTY_STATE_FONT_SIZE_KEY = 'empty-state-font-size';
export const EMPTY_STATE_OPACITY_KEY = 'empty-state-opacity';
export const TASK_BLOCKS_ENABLED_KEY = 'task-blocks-enabled';
export const TASK_BLOCKS_OPACITY_KEY = 'task-blocks-opacity';
export const TASK_BLOCKS_EDGE_BLUR_KEY = 'task-blocks-edge-blur';
