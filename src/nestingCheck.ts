// Lowering the "task nesting levels" setting is checked against every task
// list first: if some subtask already sits deeper than the new limit, the
// setting is left alone and the user is told which tasks to fix.
//
// The check needs the tasks, and only the extension (inside the shell) can
// fetch them; the preferences window is a separate process. So the two talk
// through GSettings: the preferences write a request, the extension checks
// every list and writes back a result. This module holds the pure parts —
// the depth check and both messages — so the tests can run them.
import type { GoogleTask, GoogleTaskList } from './tasksManager.js';

// How many offending tasks a rejection lists; the rest are only counted.
export const MAX_REPORTED_OFFENDERS = 8;

// How long the preferences wait for the extension's answer before giving up.
export const LEVELS_CHECK_TIMEOUT_SECONDS = 30;

export interface NestingOffender {
  listTitle: string;
  // Titles from the top-level task down to the offending task.
  path: string[];
  // The task's own level: 1 for a task, 2 for a subtask, 3 for its subtask.
  level: number;
}

export interface LevelsRequest {
  id: string;
  levels: number;
}

export type LevelsResult
  = | { id: string; status: 'applied'; levels: number }
    | { id: string; status: 'rejected'; levels: number; deepest: number; total: number; offenders: NestingOffender[] }
    | { id: string; status: 'failed'; levels: number; failedLists: string[]; detail?: string };

const UNTITLED = '(untitled)';

// Level of every task, per list: 1 + its parent's level, where a task whose
// parent isn't in the same list counts as top-level — the same rule the
// panel's tree uses. A parent cycle (bad data) is cut where it closes.
export function taskLevels(tasks: GoogleTask[]): Map<string, number> {
  const byKey = new Map<string, GoogleTask>();
  const key = (listId: string | undefined, id: string) => `${listId ?? ''}\u0000${id}`;
  for (const task of tasks)
    byKey.set(key(task.taskListId, task.id), task);

  const levels = new Map<string, number>();
  const levelOf = (task: GoogleTask, seen: Set<string>): number => {
    const own = key(task.taskListId, task.id);
    const known = levels.get(own);
    if (known !== undefined)
      return known;
    const parent = task.parent ? byKey.get(key(task.taskListId, task.parent)) : undefined;
    const parentKey = parent ? key(parent.taskListId, parent.id) : undefined;
    let level = 1;
    if (parent && parentKey && !seen.has(parentKey)) {
      seen.add(own);
      level = levelOf(parent, seen) + 1;
    }
    levels.set(own, level);
    return level;
  };
  for (const task of tasks)
    levelOf(task, new Set());

  const result = new Map<string, number>();
  for (const task of tasks)
    result.set(task.id, levels.get(key(task.taskListId, task.id))!);
  return result;
}

// Every task nested deeper than `maxLevels`, deepest first, across all lists.
export function findNestingOffenders(lists: GoogleTaskList[], tasks: GoogleTask[], maxLevels: number): NestingOffender[] {
  const listTitles = new Map(lists.map(list => [list.id, list.title || UNTITLED]));
  const byKey = new Map(tasks.map(task => [`${task.taskListId ?? ''}\u0000${task.id}`, task]));
  const levels = taskLevels(tasks);

  const offenders: NestingOffender[] = [];
  for (const task of tasks) {
    const level = levels.get(task.id) ?? 1;
    if (level <= maxLevels)
      continue;
    const path: string[] = [];
    let current: GoogleTask | undefined = task;
    while (current && path.length < level) {
      path.unshift(current.title?.trim() || UNTITLED);
      current = current.parent ? byKey.get(`${current.taskListId ?? ''}\u0000${current.parent}`) : undefined;
    }
    offenders.push({ listTitle: listTitles.get(task.taskListId ?? '') ?? UNTITLED, path, level });
  }
  return offenders.sort((a, b) => b.level - a.level || a.listTitle.localeCompare(b.listTitle) || a.path.join('\u0000').localeCompare(b.path.join('\u0000')));
}

export function buildRejection(id: string, levels: number, offenders: NestingOffender[]): LevelsResult {
  return {
    id,
    status: 'rejected',
    levels,
    deepest: offenders.reduce((max, o) => Math.max(max, o.level), 0),
    total: offenders.length,
    offenders: offenders.slice(0, MAX_REPORTED_OFFENDERS),
  };
}

export function serializeLevelsRequest(request: LevelsRequest): string {
  return JSON.stringify(request);
}

export function parseLevelsRequest(text: string): LevelsRequest | null {
  try {
    const value = JSON.parse(text);
    if (typeof value?.id === 'string' && value.id.length > 0 && Number.isInteger(value.levels))
      return { id: value.id, levels: value.levels };
  }
  catch {}
  return null;
}

export function serializeLevelsResult(result: LevelsResult): string {
  return JSON.stringify(result);
}

export function parseLevelsResult(text: string): LevelsResult | null {
  try {
    const value = JSON.parse(text);
    if (typeof value?.id !== 'string' || !Number.isInteger(value.levels))
      return null;
    if (value.status === 'applied')
      return { id: value.id, status: 'applied', levels: value.levels };
    if (value.status === 'rejected' && Array.isArray(value.offenders)) {
      const offenders = value.offenders.filter((o: any) =>
        typeof o?.listTitle === 'string' && Array.isArray(o.path) && o.path.every((p: unknown) => typeof p === 'string') && Number.isInteger(o.level));
      return {
        id: value.id,
        status: 'rejected',
        levels: value.levels,
        deepest: Number.isInteger(value.deepest) ? value.deepest : 0,
        total: Number.isInteger(value.total) ? value.total : offenders.length,
        offenders,
      };
    }
    if (value.status === 'failed') {
      return {
        id: value.id,
        status: 'failed',
        levels: value.levels,
        failedLists: Array.isArray(value.failedLists) ? value.failedLists.filter((l: unknown) => typeof l === 'string') : [],
        detail: typeof value.detail === 'string' ? value.detail : undefined,
      };
    }
  }
  catch {}
  return null;
}

export interface LevelsMessage {
  heading: string;
  body: string;
}

// What the preferences window shows when a change isn't applied. `current`
// is the limit that stays in effect.
export function describeLevelsProblem(result: LevelsResult, current: number): LevelsMessage | null {
  if (result.status === 'rejected') {
    const lines = result.offenders.map(o => `• ${o.listTitle}: ${o.path.join(' › ')}`);
    const more = result.total - result.offenders.length;
    if (more > 0)
      lines.push(`…and ${more} more`);
    return {
      heading: 'Subtasks are nested too deep',
      body: `Some tasks are nested ${result.deepest} levels deep, so the limit can't be lowered to ${result.levels}. `
        + `Move these subtasks up a level or delete them first, then try again. The limit stays at ${current}.\n\n${lines.join('\n')}`,
    };
  }
  if (result.status === 'failed') {
    const reason = result.failedLists.length > 0
      ? `These task lists didn't load: ${result.failedLists.join(', ')}.`
      : `Google Tasks couldn't be reached${result.detail ? ` (${result.detail})` : ''}.`;
    return {
      heading: 'Couldn\'t check every task list',
      body: `${reason} Every list has to be checked before the limit can be lowered, so it stays at ${current}. Try again in a moment.`,
    };
  }
  return null;
}

export function describeLevelsTimeout(current: number): LevelsMessage {
  return {
    heading: 'No answer from the extension',
    body: `Task lists are checked by the extension itself. Make sure it's enabled and online, then try again. The limit stays at ${current}.`,
  };
}
