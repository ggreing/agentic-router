export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type Priority = 'low' | 'medium' | 'high';

export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
export const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high'];
export const TITLE_MAX_LENGTH = 120;
/** Priority used when a task is created without one. */
export const DEFAULT_PRIORITY: Priority = 'low';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assigneeId: string | null;
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

export interface NewTaskInput {
  title: string;
  description?: string;
  priority?: Priority;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

/** Returns a list of human-readable problems; empty when the input is valid. */
export function validateNewTask(input: unknown): string[] {
  if (!isRecord(input)) return ['body must be an object'];
  const errors: string[] = [];
  const { title, description, priority } = input;
  if (typeof title !== 'string' || title.trim() === '') {
    errors.push('title is required');
  } else if (title.length > TITLE_MAX_LENGTH) {
    errors.push(`title must be at most ${TITLE_MAX_LENGTH} characters`);
  }
  if (description !== undefined && typeof description !== 'string') {
    errors.push('description must be a string');
  }
  if (priority !== undefined && !isPriority(priority)) {
    errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }
  return errors;
}
