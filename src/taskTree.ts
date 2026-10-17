// Pure task-list logic: tree building, color inheritance, nesting limits,
// sorting and timeframe filtering. No GNOME imports, so it runs under
// `bun test` as well as in the shell.
import type { GoogleTask } from './tasksManager.js';

export type TaskSortOrder = 'my-order' | 'date' | 'deadline' | 'starred-recently' | 'title';
export type TaskTimeframe = 'all' | 'today' | 'this-week' | 'this-month';

export const VALID_TASK_SORT_ORDERS = new Set<TaskSortOrder>(['my-order', 'date', 'deadline', 'starred-recently', 'title']);
export const VALID_TASK_TIMEFRAMES = new Set<TaskTimeframe>(['all', 'today', 'this-week', 'this-month']);

// Levels of nesting: 2 = task -> subtask (what Google Tasks itself supports),
// 3 = task -> subtask -> sub-subtask. Must match the 'subtask-levels' default
// in the GSettings schema.
export const DEFAULT_SUBTASK_LEVELS = 3;
export const MIN_SUBTASK_LEVELS = 2;
export const MAX_SUBTASK_LEVELS = 3;

export function normalizeSubtaskLevels(levels: number): number {
  if (!Number.isFinite(levels))
    return DEFAULT_SUBTASK_LEVELS;
  return Math.min(MAX_SUBTASK_LEVELS, Math.max(MIN_SUBTASK_LEVELS, Math.round(levels)));
}

// Tasks nested deeper than the allowed number of levels (created elsewhere,
// or before the limit was lowered) are shown on the last allowed level.
export function clampTaskDepth(depth: number, levels: number): number {
  return Math.max(0, Math.min(depth, normalizeSubtaskLevels(levels) - 1));
}

// Whether a row at this (already clamped) depth may get an "add subtask"
// button: only if a child would still fit within the allowed levels.
export function canAddSubtaskAt(depth: number, levels: number): boolean {
  return depth < normalizeSubtaskLevels(levels) - 1;
}

// Flat, parent-linked tasks -> tree. A task whose parent isn't in the list
// becomes a root. Input tasks are not mutated.
export function buildTaskTree(tasks: GoogleTask[]): GoogleTask[] {
  const taskNodes = new Map<string, GoogleTask>();
  const rootTasks: GoogleTask[] = [];

  for (const task of tasks)
    taskNodes.set(task.id, { ...task, children: [] });

  for (const task of tasks) {
    const taskNode = taskNodes.get(task.id);
    if (!taskNode)
      continue;
    const parentNode = task.parent ? taskNodes.get(task.parent) : null;
    if (parentNode?.children && parentNode !== taskNode)
      parentNode.children.push(taskNode);
    else
      rootTasks.push(taskNode);
  }

  return rootTasks;
}

// Each task's "effective" color: its own explicit color if set, otherwise the
// one inherited from the nearest colored ancestor. Walks the real .parent
// chain over every task of the list (active and completed together), so a
// completed subtask of a still-active parent keeps the inherited color.
// 'none' counts as no color. Cycles in the parent chain are tolerated.
export function resolveEffectiveColors(tasks: GoogleTask[], colors: ReadonlyMap<string, string>): Map<string, string> {
  const allTasksById = new Map<string, GoogleTask>();
  for (const t of tasks)
    allTasksById.set(t.id, t);

  const resolve = (taskId: string, visited: Set<string>): string | undefined => {
    if (visited.has(taskId))
      return undefined;
    visited.add(taskId);
    const ownColor = colors.get(taskId);
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
export function collectDescendantIds(rootId: string, tasks: GoogleTask[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>([rootId]);
  const frontier = [rootId];
  while (frontier.length > 0) {
    const currentId = frontier.pop()!;
    for (const t of tasks) {
      if (t.parent === currentId && !seen.has(t.id)) {
        seen.add(t.id);
        result.push(t.id);
        frontier.push(t.id);
      }
    }
  }
  return result;
}

// A subtask can't leave "completed" while its parent is still completed —
// the parent must be uncompleted first.
export function canUncompleteTask(task: GoogleTask, completedTasksInList: GoogleTask[] | undefined): boolean {
  if (!task.parent || !completedTasksInList)
    return true;
  return !completedTasksInList.some(t => t.id === task.parent);
}

export function parseTimestamp(value?: string): number {
  if (!value)
    return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

// Earliest deadline first; tasks without a deadline go last.
export function compareDeadline(left?: string, right?: string): number {
  const leftTimestamp = parseTimestamp(left);
  const rightTimestamp = parseTimestamp(right);
  if (leftTimestamp === 0 && rightTimestamp === 0)
    return 0;
  if (leftTimestamp === 0)
    return 1;
  if (rightTimestamp === 0)
    return -1;
  return leftTimestamp - rightTimestamp;
}

// Google's position strings sort lexicographically; tasks without one go last.
export function comparePosition(left?: string, right?: string): number {
  if (!left && !right)
    return 0;
  if (!left)
    return 1;
  if (!right)
    return -1;
  return left.localeCompare(right);
}

export function sortTasks(tasks: GoogleTask[], sortOrder: TaskSortOrder): GoogleTask[] {
  const sortedTasks = [...tasks];
  switch (sortOrder) {
    case 'title':
      sortedTasks.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'date':
    case 'starred-recently':
      sortedTasks.sort((a, b) => parseTimestamp(b.updated) - parseTimestamp(a.updated));
      break;
    case 'deadline':
      sortedTasks.sort((a, b) => compareDeadline(a.due, b.due));
      break;
    case 'my-order':
    default:
      sortedTasks.sort((a, b) => comparePosition(a.position, b.position));
      break;
  }
  return sortedTasks;
}

export function sortTaskTree(tasks: GoogleTask[], sortOrder: TaskSortOrder): GoogleTask[] {
  return sortTasks(tasks, sortOrder).map(task => ({
    ...task,
    children: task.children ? sortTaskTree(task.children, sortOrder) : [],
  }));
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The task's due date as a local YYYY-MM-DD, or null without a (valid) one.
// Google sends the date part at midnight UTC; it's taken as is rather than
// shifted into the local zone, which would move it a day back west of UTC.
export function getTaskDueDate(task: GoogleTask): string | null {
  if (!task.due)
    return null;

  const dueDatePrefix = task.due.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dueDatePrefix)) {
    const parsedDate = new Date(`${dueDatePrefix}T00:00:00`);
    if (!Number.isNaN(parsedDate.getTime()) && formatLocalDate(parsedDate) === dueDatePrefix)
      return dueDatePrefix;
  }

  const parsedTime = Date.parse(task.due);
  if (Number.isNaN(parsedTime))
    return null;

  return formatLocalDate(new Date(parsedTime));
}

// Keeps tasks due within the timeframe around `now`; tasks without a due
// date always stay.
export function filterTasksByTimeframe(tasks: GoogleTask[], timeframe: TaskTimeframe, now: Date): GoogleTask[] {
  if (timeframe === 'all')
    return tasks;

  if (timeframe === 'today') {
    const today = formatLocalDate(now);
    return tasks.filter((task) => {
      const dueDate = getTaskDueDate(task);
      return dueDate === null || dueDate === today;
    });
  }

  if (timeframe === 'this-week') {
    const daysSinceMonday = (now.getDay() + 6) % 7;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
    const endOfWeek = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate() + 6);
    const startDate = formatLocalDate(startOfWeek);
    const endDate = formatLocalDate(endOfWeek);
    return tasks.filter((task) => {
      const dueDate = getTaskDueDate(task);
      return dueDate === null || (dueDate >= startDate && dueDate <= endDate);
    });
  }

  if (timeframe === 'this-month') {
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    return tasks.filter((task) => {
      const dueDate = getTaskDueDate(task);
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

// Tree version: a task that doesn't match stays (with only its matching
// children) when any descendant matches, so a matching subtask keeps its
// parent visible.
export function filterTaskTreeByTimeframe(tasks: GoogleTask[], timeframe: TaskTimeframe, now: Date): GoogleTask[] {
  if (timeframe === 'all')
    return tasks;

  const filteredTasks: GoogleTask[] = [];
  for (const task of tasks) {
    const filteredChildren = task.children ? filterTaskTreeByTimeframe(task.children, timeframe, now) : [];
    const taskMatches = filterTasksByTimeframe([task], timeframe, now).length > 0;
    if (taskMatches)
      filteredTasks.push(task);
    else if (filteredChildren.length > 0)
      filteredTasks.push({ ...task, children: filteredChildren });
  }
  return filteredTasks;
}
