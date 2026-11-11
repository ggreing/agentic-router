import type { NewTaskInput, Task, TaskStatus } from '../models/task.ts';
import { DEFAULT_PRIORITY, TASK_STATUSES, isTaskStatus, validateNewTask } from '../models/task.ts';
import type { AuditEvent, AuditEventType, FieldChange } from '../models/audit.ts';
import type { InMemoryTaskRepo } from '../repo/taskRepo.ts';
import type { InMemoryUserRepo } from '../repo/userRepo.ts';
import { InMemoryAuditLog } from '../repo/auditRepo.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { createIdGenerator } from '../ids.ts';
import { canTransition } from './transitions.ts';

export interface TaskServiceOptions {
  /** Clock used for createdAt/updatedAt and audit timestamps. Defaults to the system clock. */
  now?: () => Date;
  nextId?: () => string;
  /** Where change events are recorded. Defaults to a fresh in-memory log. */
  auditLog?: InMemoryAuditLog;
}

export class TaskService {
  #tasks: InMemoryTaskRepo;
  #users: InMemoryUserRepo;
  #audit: InMemoryAuditLog;
  #now: () => Date;
  #nextId: () => string;
  #nextEventId = createIdGenerator('evt');

  constructor(tasks: InMemoryTaskRepo, users: InMemoryUserRepo, options: TaskServiceOptions = {}) {
    this.#tasks = tasks;
    this.#users = users;
    this.#audit = options.auditLog ?? new InMemoryAuditLog();
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? createIdGenerator('task');
  }

  createTask(input: NewTaskInput, actorId: string | null = null): Task {
    const errors = validateNewTask(input);
    if (errors.length > 0) throw new ValidationError(errors);
    const timestamp = this.#now().toISOString();
    const task = this.#tasks.insert({
      id: this.#nextId(),
      title: input.title.trim(),
      description: input.description ?? '',
      status: 'todo',
      priority: input.priority ?? DEFAULT_PRIORITY,
      assigneeId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#record(task, 'task.created', actorId, {});
    return task;
  }

  getTask(id: string): Task {
    const task = this.#tasks.findById(id);
    if (!task) throw new NotFoundError(`Task not found: ${id}`);
    return task;
  }

  listTasks(): Task[] {
    return this.#tasks.list();
  }

  /** Change events for one task, oldest first. */
  getTaskHistory(taskId: string): AuditEvent[] {
    this.getTask(taskId);
    return this.#audit.listByTask(taskId);
  }

  /** Assign the task to `userId`, or unassign it with `null`. */
  assignTask(taskId: string, userId: string | null, actorId: string | null = null): Task {
    const task = this.getTask(taskId);
    if (userId !== null) {
      const user = this.#users.findById(userId);
      if (!user) throw new NotFoundError(`User not found: ${userId}`);
      if (!user.active) throw new ConflictError(`User is inactive: ${userId}`);
    }
    if (task.assigneeId === userId) return task;
    const saved = this.#save({ ...task, assigneeId: userId });
    this.#record(saved, 'task.assigned', actorId, { assigneeId: { from: task.assigneeId, to: userId } });
    return saved;
  }

  changeStatus(taskId: string, status: TaskStatus, actorId: string | null = null): Task {
    if (!isTaskStatus(status)) {
      throw new ValidationError([`status must be one of: ${TASK_STATUSES.join(', ')}`]);
    }
    const task = this.getTask(taskId);
    if (!canTransition(status, task.status)) {
      throw new ConflictError(`Invalid status transition: ${task.status} -> ${status}`);
    }
    const saved = this.#save({ ...task, status });
    this.#record(saved, 'task.status_changed', actorId, { status: { from: task.status, to: status } });
    return saved;
  }

  startTask(taskId: string, actorId: string | null = null): Task {
    return this.changeStatus(taskId, 'in_progress', actorId);
  }

  completeTask(taskId: string, actorId: string | null = null): Task {
    return this.changeStatus(taskId, 'done', actorId);
  }

  cancelTask(taskId: string, actorId: string | null = null): Task {
    return this.changeStatus(taskId, 'cancelled', actorId);
  }

  #save(task: Task): Task {
    return this.#tasks.update({ ...task, updatedAt: this.#now().toISOString() });
  }

  /** Record a change; `at` reuses the saved task's updatedAt so both agree exactly. */
  #record(task: Task, type: AuditEventType, actorId: string | null, changes: Record<string, FieldChange>): void {
    this.#audit.append({ id: this.#nextEventId(), taskId: task.id, type, actorId, at: task.updatedAt, changes });
  }
}
