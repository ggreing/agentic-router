import type { NewTaskInput, Task, TaskStatus } from '../models/task.ts';
import { DEFAULT_PRIORITY, TASK_STATUSES, isTaskStatus, validateNewTask } from '../models/task.ts';
import { InMemoryMembershipRepo } from '../repo/membershipRepo.ts';
import { InMemoryProjectRepo } from '../repo/projectRepo.ts';
import type { InMemoryTaskRepo } from '../repo/taskRepo.ts';
import type { InMemoryUserRepo } from '../repo/userRepo.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { createIdGenerator } from '../ids.ts';
import { AccessControl } from './permissions.ts';
import type { ProjectAction } from './permissions.ts';
import { canTransition } from './transitions.ts';

export interface TaskServiceOptions {
  /** Clock used for createdAt/updatedAt. Defaults to the system clock. */
  now?: () => Date;
  nextId?: () => string;
  /** Project access rules. Without it no project exists, so only project-less tasks can be created. */
  access?: AccessControl;
}

/**
 * Tasks outside a project behave as before: anyone, including an anonymous caller, may read and
 * change them. A task inside a project needs a caller (`actorId`) with the right role there.
 */
export class TaskService {
  #tasks: InMemoryTaskRepo;
  #users: InMemoryUserRepo;
  #access: AccessControl;
  #now: () => Date;
  #nextId: () => string;

  constructor(tasks: InMemoryTaskRepo, users: InMemoryUserRepo, options: TaskServiceOptions = {}) {
    this.#tasks = tasks;
    this.#users = users;
    this.#access = options.access ?? new AccessControl(users, new InMemoryProjectRepo(), new InMemoryMembershipRepo());
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? createIdGenerator('task');
  }

  createTask(input: NewTaskInput, actorId?: string): Task {
    const projectId = typeof input === 'object' && input !== null && typeof input.projectId === 'string' && input.projectId !== ''
      ? input.projectId
      : null;
    if (projectId !== null) this.#access.authorize(actorId, projectId, 'task.write');
    const errors = validateNewTask(input);
    if (errors.length > 0) throw new ValidationError(errors);
    const timestamp = this.#now().toISOString();
    return this.#tasks.insert({
      id: this.#nextId(),
      title: input.title.trim(),
      description: input.description ?? '',
      status: 'todo',
      priority: input.priority ?? DEFAULT_PRIORITY,
      assigneeId: null,
      projectId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  getTask(id: string, actorId?: string): Task {
    return this.#authorized(id, actorId, 'task.read');
  }

  /**
   * Tasks the caller may see, in creation order: tasks outside any project plus the tasks of
   * projects the caller is a member of. With `projectId`, only that project's tasks.
   */
  listTasks(actorId?: string, projectId?: string): Task[] {
    const all = this.#tasks.list();
    if (projectId !== undefined) {
      this.#access.authorize(actorId, projectId, 'task.read');
      return all.filter((task) => task.projectId === projectId);
    }
    return all.filter((task) => task.projectId === null
      || (actorId !== undefined && this.#access.roleOf(task.projectId, actorId) !== undefined));
  }

  /** Assign the task to `userId`, or unassign it with `null`. */
  assignTask(taskId: string, userId: string | null, actorId?: string): Task {
    const task = this.#authorized(taskId, actorId, 'task.write');
    if (userId !== null) {
      const user = this.#users.findById(userId);
      if (!user) throw new NotFoundError(`User not found: ${userId}`);
      if (!user.active) throw new ConflictError(`User is inactive: ${userId}`);
      if (task.projectId !== null) {
        const role = this.#access.roleOf(task.projectId, userId);
        if (!role || role === 'viewer') throw new ConflictError(`User cannot be assigned in project: ${userId}`);
      }
    }
    return this.#save({ ...task, assigneeId: userId });
  }

  changeStatus(taskId: string, status: TaskStatus, actorId?: string): Task {
    if (!isTaskStatus(status)) {
      throw new ValidationError([`status must be one of: ${TASK_STATUSES.join(', ')}`]);
    }
    const task = this.#authorized(taskId, actorId, 'task.write');
    if (!canTransition(task.status, status)) {
      throw new ConflictError(`Invalid status transition: ${task.status} -> ${status}`);
    }
    return this.#save({ ...task, status });
  }

  startTask(taskId: string, actorId?: string): Task {
    return this.changeStatus(taskId, 'in_progress', actorId);
  }

  completeTask(taskId: string, actorId?: string): Task {
    return this.changeStatus(taskId, 'done', actorId);
  }

  cancelTask(taskId: string, actorId?: string): Task {
    return this.changeStatus(taskId, 'cancelled', actorId);
  }

  /** The task, after checking the caller's role when it belongs to a project. */
  #authorized(id: string, actorId: string | undefined, action: ProjectAction): Task {
    const task = this.#tasks.findById(id);
    if (!task) throw new NotFoundError(`Task not found: ${id}`);
    if (task.projectId !== null) this.#access.authorize(actorId, task.projectId, action);
    return task;
  }

  #save(task: Task): Task {
    return this.#tasks.update({ ...task, updatedAt: this.#now().toISOString() });
  }
}
