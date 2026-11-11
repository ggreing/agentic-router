import type { TaskStatus } from '../models/task.ts';

/** Statuses a task may move to, keyed by its current status. */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['todo', 'done', 'cancelled'],
  done: ['in_progress'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
