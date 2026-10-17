import type { GoogleTask } from '../src/tasksManager.js';
import { describe, expect, it } from 'bun:test';
import {
  buildTaskTree,
  canAddSubtaskAt,
  canUncompleteTask,
  clampTaskDepth,
  collectDescendantIds,
  compareDeadline,
  comparePosition,
  DEFAULT_SUBTASK_LEVELS,
  filterTasksByTimeframe,
  filterTaskTreeByTimeframe,
  formatLocalDate,
  getTaskDueDate,
  normalizeSubtaskLevels,
  resolveEffectiveColors,
  sortTasks,
  sortTaskTree,
} from '../src/taskTree.js';

function task(id: string, extra: Partial<GoogleTask> = {}): GoogleTask {
  return { id, title: id, status: 'needsAction', ...extra };
}

// Google sends due dates as midnight UTC of the chosen day.
function due(date: Date): string {
  return `${formatLocalDate(date)}T00:00:00.000Z`;
}

describe('nesting levels', () => {
  it('defaults to task -> subtask (2 levels)', () => {
    expect(DEFAULT_SUBTASK_LEVELS).toBe(3);
  });

  it('normalizes the setting into 2..3', () => {
    expect(normalizeSubtaskLevels(1)).toBe(2);
    expect(normalizeSubtaskLevels(2)).toBe(2);
    expect(normalizeSubtaskLevels(3)).toBe(3);
    expect(normalizeSubtaskLevels(10)).toBe(3);
    expect(normalizeSubtaskLevels(Number.NaN)).toBe(DEFAULT_SUBTASK_LEVELS);
  });

  it('with 2 levels only a top-level task can get subtasks', () => {
    expect(canAddSubtaskAt(0, 2)).toBe(true);
    expect(canAddSubtaskAt(1, 2)).toBe(false);
  });

  it('with 3 levels a subtask can get subtasks too, a sub-subtask cannot', () => {
    expect(canAddSubtaskAt(0, 3)).toBe(true);
    expect(canAddSubtaskAt(1, 3)).toBe(true);
    expect(canAddSubtaskAt(2, 3)).toBe(false);
  });

  it('shows tasks nested deeper than allowed on the last level', () => {
    expect(clampTaskDepth(0, 2)).toBe(0);
    expect(clampTaskDepth(1, 2)).toBe(1);
    expect(clampTaskDepth(2, 2)).toBe(1);
    expect(clampTaskDepth(5, 3)).toBe(2);
    expect(clampTaskDepth(-1, 2)).toBe(0);
  });

  it('never offers "add subtask" on a clamped row', () => {
    for (const levels of [2, 3]) {
      for (let depth = 0; depth < 6; depth++)
        expect(canAddSubtaskAt(clampTaskDepth(depth, levels), levels)).toBe(clampTaskDepth(depth, levels) < levels - 1);
    }
  });
});

describe('buildTaskTree', () => {
  it('nests children under their parent and keeps order', () => {
    const tree = buildTaskTree([task('a'), task('b', { parent: 'a' }), task('c'), task('d', { parent: 'a' })]);
    expect(tree.map(t => t.id)).toEqual(['a', 'c']);
    expect(tree[0].children?.map(t => t.id)).toEqual(['b', 'd']);
    expect(tree[1].children).toEqual([]);
  });

  it('turns a task whose parent is missing into a root', () => {
    const tree = buildTaskTree([task('orphan', { parent: 'gone' })]);
    expect(tree.map(t => t.id)).toEqual(['orphan']);
  });

  it('does not mutate its input', () => {
    const input = [task('a'), task('b', { parent: 'a' })];
    buildTaskTree(input);
    expect(input[0].children).toBeUndefined();
  });

  it('does not lose a task that is its own parent', () => {
    const tree = buildTaskTree([task('self', { parent: 'self' })]);
    expect(tree.map(t => t.id)).toEqual(['self']);
  });
});

describe('resolveEffectiveColors', () => {
  const tasks = [
    task('root'),
    task('child', { parent: 'root' }),
    task('grandchild', { parent: 'child' }),
    task('plain'),
  ];

  it('inherits the nearest ancestor color', () => {
    const colors = resolveEffectiveColors(tasks, new Map([['root', 'green']]));
    expect(colors.get('root')).toBe('green');
    expect(colors.get('child')).toBe('green');
    expect(colors.get('grandchild')).toBe('green');
    expect(colors.has('plain')).toBe(false);
  });

  it('lets a task\'s own color win over the inherited one', () => {
    const colors = resolveEffectiveColors(tasks, new Map([['root', 'green'], ['child', 'red']]));
    expect(colors.get('child')).toBe('red');
    expect(colors.get('grandchild')).toBe('red');
  });

  it('treats "none" as no color, so the parent color shows through', () => {
    const colors = resolveEffectiveColors(tasks, new Map([['root', 'blue'], ['child', 'none']]));
    expect(colors.get('child')).toBe('blue');
  });

  it('keeps the inherited color of a completed subtask whose parent is active', () => {
    const active = [task('parent')];
    const completed = [task('done', { parent: 'parent', status: 'completed' })];
    const colors = resolveEffectiveColors([...active, ...completed], new Map([['parent', 'purple']]));
    expect(colors.get('done')).toBe('purple');
  });

  it('terminates on a cycle in the parent chain', () => {
    const cyclic = [task('x', { parent: 'y' }), task('y', { parent: 'x' })];
    expect(resolveEffectiveColors(cyclic, new Map()).size).toBe(0);
  });
});

describe('collectDescendantIds', () => {
  it('returns children and grandchildren, not the root or unrelated tasks', () => {
    const tasks = [task('a'), task('b', { parent: 'a' }), task('c', { parent: 'b' }), task('d')];
    expect(collectDescendantIds('a', tasks).sort()).toEqual(['b', 'c']);
    expect(collectDescendantIds('d', tasks)).toEqual([]);
  });

  it('terminates on a cycle', () => {
    const tasks = [task('a', { parent: 'b' }), task('b', { parent: 'a' })];
    expect(collectDescendantIds('a', tasks)).toEqual(['b']);
  });
});

describe('canUncompleteTask', () => {
  it('blocks a subtask while its parent is still completed', () => {
    const child = task('child', { parent: 'p' });
    expect(canUncompleteTask(child, [task('p'), child])).toBe(false);
  });

  it('allows a subtask whose parent is active, and any top-level task', () => {
    const child = task('child', { parent: 'p' });
    expect(canUncompleteTask(child, [child])).toBe(true);
    expect(canUncompleteTask(task('top'), [task('top')])).toBe(true);
    expect(canUncompleteTask(child, undefined)).toBe(true);
  });
});

describe('sorting', () => {
  it('my-order sorts by position, tasks without one last', () => {
    const sorted = sortTasks([task('c', { position: '3' }), task('none'), task('a', { position: '1' })], 'my-order');
    expect(sorted.map(t => t.id)).toEqual(['a', 'c', 'none']);
  });

  it('title sorts alphabetically', () => {
    expect(sortTasks([task('b'), task('a')], 'title').map(t => t.id)).toEqual(['a', 'b']);
  });

  it('date puts the most recently updated first', () => {
    const sorted = sortTasks([
      task('old', { updated: '2026-01-01T00:00:00Z' }),
      task('new', { updated: '2026-06-01T00:00:00Z' }),
    ], 'date');
    expect(sorted.map(t => t.id)).toEqual(['new', 'old']);
  });

  it('deadline puts the earliest first and tasks without one last', () => {
    const sorted = sortTasks([
      task('none'),
      task('late', { due: '2026-12-01T00:00:00Z' }),
      task('soon', { due: '2026-02-01T00:00:00Z' }),
    ], 'deadline');
    expect(sorted.map(t => t.id)).toEqual(['soon', 'late', 'none']);
  });

  it('does not reorder the input array', () => {
    const input = [task('b'), task('a')];
    sortTasks(input, 'title');
    expect(input.map(t => t.id)).toEqual(['b', 'a']);
  });

  it('sorts every level of a tree', () => {
    const tree = sortTaskTree([task('p', { children: [task('y'), task('x')] })], 'title');
    expect(tree[0].children?.map(t => t.id)).toEqual(['x', 'y']);
  });

  it('comparators are consistent about missing values', () => {
    expect(compareDeadline(undefined, undefined)).toBe(0);
    expect(comparePosition(undefined, undefined)).toBe(0);
    expect(compareDeadline('garbage', '2026-01-01T00:00:00Z')).toBeGreaterThan(0);
  });
});

describe('due dates and timeframes', () => {
  // Wednesday, 2026-10-14, local time.
  const now = new Date(2026, 9, 14, 12, 0, 0);

  it('takes the date part of a midnight-UTC due date as is', () => {
    expect(getTaskDueDate(task('t', { due: '2026-10-14T00:00:00.000Z' }))).toBe('2026-10-14');
    expect(getTaskDueDate(task('t'))).toBeNull();
    expect(getTaskDueDate(task('t', { due: 'not a date' }))).toBeNull();
  });

  it('"all" keeps everything', () => {
    const tasks = [task('a', { due: '1999-01-01T00:00:00Z' })];
    expect(filterTasksByTimeframe(tasks, 'all', now)).toBe(tasks);
  });

  it('"today" keeps tasks due today and tasks without a due date', () => {
    const kept = filterTasksByTimeframe([
      task('today', { due: due(now) }),
      task('tomorrow', { due: due(new Date(2026, 9, 15)) }),
      task('undated'),
    ], 'today', now);
    expect(kept.map(t => t.id)).toEqual(['today', 'undated']);
  });

  it('"this-week" runs Monday through Sunday', () => {
    const kept = filterTasksByTimeframe([
      task('monday', { due: due(new Date(2026, 9, 12)) }),
      task('sunday', { due: due(new Date(2026, 9, 18)) }),
      task('last-sunday', { due: due(new Date(2026, 9, 11)) }),
      task('next-monday', { due: due(new Date(2026, 9, 19)) }),
    ], 'this-week', now);
    expect(kept.map(t => t.id)).toEqual(['monday', 'sunday']);
  });

  it('"this-month" keeps only the current month', () => {
    const kept = filterTasksByTimeframe([
      task('first', { due: due(new Date(2026, 9, 1)) }),
      task('last', { due: due(new Date(2026, 9, 31)) }),
      task('next', { due: due(new Date(2026, 10, 1)) }),
      task('last-year', { due: due(new Date(2025, 9, 14)) }),
    ], 'this-month', now);
    expect(kept.map(t => t.id)).toEqual(['first', 'last']);
  });

  it('keeps a non-matching parent when one of its subtasks matches', () => {
    const tree = [task('parent', {
      due: due(new Date(2026, 11, 1)),
      children: [task('sub', { due: due(now) }), task('other', { due: due(new Date(2026, 11, 2)) })],
    })];
    const filtered = filterTaskTreeByTimeframe(tree, 'today', now);
    expect(filtered.map(t => t.id)).toEqual(['parent']);
    expect(filtered[0].children?.map(t => t.id)).toEqual(['sub']);
  });
});
