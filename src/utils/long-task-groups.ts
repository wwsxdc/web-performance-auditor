import type { DiagnosticEvent } from '../types/events';

export interface LongTaskGroup {
  id: string;
  startedAt: number;
  endedAt: number;
  count: number;
  totalDuration: number;
  events: DiagnosticEvent[];
}

/**
 * Consecutive long tasks are often one expensive user flow (FR-06). Group
 * tasks separated by at most `gapMs` so the panel and exports can show the
 * cost of the flow instead of unrelated one-off entries.
 */
export function groupLongTasks(
  events: DiagnosticEvent[],
  gapMs = 1000,
): LongTaskGroup[] {
  const tasks = events
    .filter((event) => event.type === 'long-task')
    .sort((left, right) => left.timestamp - right.timestamp);

  const groups: LongTaskGroup[] = [];
  for (const task of tasks) {
    const duration = task.duration ?? 0;
    const current = groups[groups.length - 1];
    const currentSource = current?.events[current.events.length - 1]?.details?.containerName;
    const taskSource = task.details?.containerName;
    const sameSource =
      typeof currentSource !== 'string' ||
      typeof taskSource !== 'string' ||
      currentSource === taskSource;
    if (current && sameSource && task.timestamp - current.endedAt <= gapMs) {
      current.events.push(task);
      current.count += 1;
      current.totalDuration += duration;
      current.endedAt = Math.max(current.endedAt, task.timestamp + duration);
      continue;
    }
    groups.push({
      id: `long-group-${task.id}`,
      startedAt: task.timestamp,
      endedAt: task.timestamp + duration,
      count: 1,
      totalDuration: duration,
      events: [task],
    });
  }
  return groups;
}

export function groupByEventId(groups: LongTaskGroup[]): Map<string, LongTaskGroup> {
  const map = new Map<string, LongTaskGroup>();
  for (const group of groups) {
    for (const event of group.events) map.set(event.id, group);
  }
  return map;
}
