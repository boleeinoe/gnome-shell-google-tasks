import type { GoogleTask, GoogleTaskList } from '../src/tasksManager.js';
import { describe, expect, it } from 'bun:test';
import {
  buildRejection,
  describeLevelsProblem,
  describeLevelsTimeout,
  findNestingOffenders,
  MAX_REPORTED_OFFENDERS,
  parseLevelsRequest,
  parseLevelsResult,
  serializeLevelsRequest,
  serializeLevelsResult,
  taskLevels,
} from '../src/nestingCheck.js';

function task(id: string, list: string, parent?: string, title = id): GoogleTask {
  return { id, title, status: 'needsAction', taskListId: list, parent };
}

const lists: GoogleTaskList[] = [{ id: 'L1', title: 'Work' }, { id: 'L2', title: 'Home' }];

describe('taskLevels', () => {
  it('counts levels down the parent chain', () => {
    const levels = taskLevels([task('a', 'L1'), task('b', 'L1', 'a'), task('c', 'L1', 'b'), task('d', 'L1')]);
    expect(Object.fromEntries(levels)).toEqual({ a: 1, b: 2, c: 3, d: 1 });
  });

  it('treats a task whose parent is missing (or in another list) as top-level', () => {
    const levels = taskLevels([task('a', 'L1'), task('b', 'L2', 'a'), task('c', 'L2', 'gone')]);
    expect(levels.get('b')).toBe(1);
    expect(levels.get('c')).toBe(1);
  });

  it('survives a parent cycle', () => {
    const levels = taskLevels([task('a', 'L1', 'b'), task('b', 'L1', 'a')]);
    expect(levels.get('a')).toBeGreaterThan(0);
    expect(levels.get('b')).toBeGreaterThan(0);
  });
});

describe('findNestingOffenders', () => {
  const tasks = [
    task('p', 'L1', undefined, 'Parent'),
    task('c', 'L1', 'p', 'Child'),
    task('g', 'L1', 'c', 'Grandchild'),
    task('x', 'L2', undefined, 'Other'),
    task('y', 'L2', 'x', 'Sub'),
    task('z', 'L2', 'y', 'Deep'),
  ];

  it('checks every list, not just one', () => {
    const offenders = findNestingOffenders(lists, tasks, 2);
    expect(offenders.map(o => o.listTitle).sort()).toEqual(['Home', 'Work']);
  });

  it('names each offender by its full path', () => {
    const work = findNestingOffenders(lists, tasks, 2).find(o => o.listTitle === 'Work')!;
    expect(work.path).toEqual(['Parent', 'Child', 'Grandchild']);
    expect(work.level).toBe(3);
  });

  it('finds nothing when every task fits', () => {
    expect(findNestingOffenders(lists, tasks, 3)).toEqual([]);
    expect(findNestingOffenders(lists, tasks.filter(t => t.id !== 'g' && t.id !== 'z'), 2)).toEqual([]);
  });

  it('counts completed tasks too (they are in the list as well)', () => {
    const done = [task('p', 'L1'), task('c', 'L1', 'p'), { ...task('g', 'L1', 'c'), status: 'completed' }];
    expect(findNestingOffenders(lists, done, 2)).toHaveLength(1);
  });
});

describe('request / result protocol', () => {
  it('round-trips a request and rejects garbage', () => {
    const request = { id: 'r1', levels: 2 };
    expect(parseLevelsRequest(serializeLevelsRequest(request))).toEqual(request);
    for (const bad of ['', 'nope', '{}', '{"id":"","levels":2}', '{"id":"x","levels":2.5}'])
      expect(parseLevelsRequest(bad)).toBeNull();
  });

  it('round-trips every kind of result', () => {
    const offenders = findNestingOffenders(lists, [task('p', 'L1'), task('c', 'L1', 'p'), task('g', 'L1', 'c')], 2);
    for (const result of [
      { id: 'a', status: 'applied' as const, levels: 2 },
      buildRejection('b', 2, offenders),
      { id: 'c', status: 'failed' as const, levels: 2, failedLists: ['Work'] },
    ])
      expect(parseLevelsResult(serializeLevelsResult(result))).toEqual(result);
    expect(parseLevelsResult('{"id":"x"}')).toBeNull();
  });

  it('lists only the first few offenders but counts them all', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ listTitle: 'Work', path: ['a', 'b', `c${i}`], level: 3 }));
    const rejection = buildRejection('r', 2, many);
    if (rejection.status !== 'rejected')
      throw new Error('expected a rejection');
    expect(rejection.offenders).toHaveLength(MAX_REPORTED_OFFENDERS);
    expect(rejection.total).toBe(20);
    expect(rejection.deepest).toBe(3);
    expect(describeLevelsProblem(rejection, 3)!.body).toContain(`and ${20 - MAX_REPORTED_OFFENDERS} more`);
  });
});

describe('messages', () => {
  it('a rejection says how deep, which tasks, and that the old limit stays', () => {
    const offenders = findNestingOffenders(lists, [task('p', 'L1', undefined, 'Parent'), task('c', 'L1', 'p', 'Child'), task('g', 'L1', 'c', 'Grandchild')], 2);
    const message = describeLevelsProblem(buildRejection('r', 2, offenders), 3)!;
    expect(message.body).toContain('3 levels deep');
    expect(message.body).toContain('Work: Parent › Child › Grandchild');
    expect(message.body).toContain('stays at 3');
  });

  it('a failed check names the lists that did not load', () => {
    const message = describeLevelsProblem({ id: 'r', status: 'failed', levels: 2, failedLists: ['Home'] }, 3)!;
    expect(message.body).toContain('Home');
    expect(message.body).toContain('stays at 3');
  });

  it('an applied change needs no message', () => {
    expect(describeLevelsProblem({ id: 'r', status: 'applied', levels: 2 }, 2)).toBeNull();
  });

  it('a timeout points at the extension', () => {
    expect(describeLevelsTimeout(3).body).toContain('enabled');
  });
});
