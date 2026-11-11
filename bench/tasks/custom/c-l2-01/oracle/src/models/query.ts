import type { Priority, Task, TaskStatus } from './task.ts';
import { PRIORITIES, TASK_STATUSES, isPriority, isTaskStatus } from './task.ts';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Conditions are combined with AND. */
export interface TaskFilter {
  /** Matches any of the listed statuses. */
  status?: TaskStatus[];
  /** A user id, or null for unassigned tasks only. Omit for no assignee filter. */
  assigneeId?: string | null;
  priority?: Priority;
  /** Case-insensitive substring match on the title. */
  search?: string;
}

export interface TaskQuery extends TaskFilter {
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Defaults to DEFAULT_PAGE_SIZE, at most MAX_PAGE_SIZE. */
  pageSize?: number;
}

export interface TaskPage {
  items: Task[];
  page: number;
  pageSize: number;
  /** Number of tasks matching the filter, before paging. */
  total: number;
  totalPages: number;
}

export function validateTaskQuery(query: TaskQuery): string[] {
  const errors: string[] = [];
  if (query.status !== undefined) {
    if (!Array.isArray(query.status) || !query.status.every(isTaskStatus)) {
      errors.push(`status must be a list of: ${TASK_STATUSES.join(', ')}`);
    }
  }
  if (query.assigneeId !== undefined && query.assigneeId !== null && typeof query.assigneeId !== 'string') {
    errors.push('assigneeId must be a string or null');
  }
  if (query.priority !== undefined && !isPriority(query.priority)) {
    errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }
  if (query.search !== undefined && typeof query.search !== 'string') {
    errors.push('search must be a string');
  }
  if (query.page !== undefined && !(Number.isInteger(query.page) && query.page >= 1)) {
    errors.push('page must be a positive integer');
  }
  if (query.pageSize !== undefined
    && !(Number.isInteger(query.pageSize) && query.pageSize >= 1 && query.pageSize <= MAX_PAGE_SIZE)) {
    errors.push(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return errors;
}

export function matchesFilter(task: Task, filter: TaskFilter): boolean {
  if (filter.status !== undefined && !filter.status.includes(task.status)) return false;
  if (filter.assigneeId !== undefined && task.assigneeId !== filter.assigneeId) return false;
  if (filter.priority !== undefined && task.priority !== filter.priority) return false;
  if (filter.search !== undefined && !task.title.toLowerCase().includes(filter.search.toLowerCase())) return false;
  return true;
}
