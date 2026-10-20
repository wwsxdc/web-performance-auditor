import { describe, expect, it } from 'vitest';
import type { DiagnosticEvent } from '../types/events';
import { groupByEventId, groupLongTasks } from './long-task-groups';

function task(id: string, timestamp: number, duration: number): DiagnosticEvent {
  return {
    id,
    sessionId: 'session-1',
    navigationId: 'nav-1',
    type: 'long-task',
    timestamp,
    duration,
  };
}

describe('groupLongTasks', () => {
  it('groups tasks that are close in time and keeps unrelated tasks separate', () => {
    const groups = groupLongTasks([
      task('a', 1000, 60),
      task('b', 1100, 80),
      task('c', 4000, 120),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ count: 2, totalDuration: 140, startedAt: 1000, endedAt: 1180 });
    expect(groups[1]).toMatchObject({ count: 1, totalDuration: 120 });
    expect(groupByEventId(groups).get('b')).toBe(groups[0]);
  });

  it('keeps adjacent tasks from different known sources separate', () => {
    const groups = groupLongTasks([
      { ...task('a', 1000, 60), details: { containerName: 'analytics.js' } },
      { ...task('b', 1100, 80), details: { containerName: 'chat.js' } },
      { ...task('c', 1200, 70), details: { containerName: 'chat.js' } },
    ]);
    expect(groups.map((group) => group.count)).toEqual([1, 2]);
  });
});
