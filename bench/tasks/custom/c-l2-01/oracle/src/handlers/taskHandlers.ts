import type { NewTaskInput, Priority, TaskStatus } from '../models/task.ts';
import type { TaskQuery } from '../models/query.ts';
import type { TaskService } from '../service/taskService.ts';
import { ValidationError } from '../errors.ts';
import type { Request } from './http.ts';
import { bodyRecord, handle, ok, requireParam } from './http.ts';

export function createTaskHandlers(service: TaskService) {
  return {
    /** POST /tasks */
    createTask: handle((req) => ok(service.createTask(req.body as NewTaskInput), 201)),

    /** GET /tasks/:id */
    getTask: handle((req) => ok(service.getTask(requireParam(req, 'id')))),

    /** GET /tasks?status=todo,in_progress&assigneeId=u1|none&priority=high&q=login&page=1&pageSize=20 */
    listTasks: handle((req) => ok(service.queryTasks(parseTaskQuery(req)))),

    /** PUT /tasks/:id/assignee  body: { userId: string | null } */
    assignTask: handle((req) => {
      const { userId } = bodyRecord(req);
      if (userId !== null && typeof userId !== 'string') {
        throw new ValidationError(['userId must be a string or null']);
      }
      return ok(service.assignTask(requireParam(req, 'id'), userId));
    }),

    /** PUT /tasks/:id/status  body: { status } */
    updateStatus: handle((req) => {
      const { status } = bodyRecord(req);
      return ok(service.changeStatus(requireParam(req, 'id'), status as TaskStatus));
    }),
  };
}

export type TaskHandlers = ReturnType<typeof createTaskHandlers>;

/** Turn query-string values (all strings) into a TaskQuery; the service validates the values. */
function parseTaskQuery(req: Request): TaskQuery {
  const q = req.query ?? {};
  const query: TaskQuery = {};
  if (q.status !== undefined) {
    const statuses = q.status.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (statuses.length > 0) query.status = statuses as TaskStatus[];
  }
  if (q.assigneeId !== undefined) query.assigneeId = q.assigneeId === 'none' ? null : q.assigneeId;
  if (q.priority !== undefined) query.priority = q.priority as Priority;
  if (q.q !== undefined) query.search = q.q;
  if (q.page !== undefined) query.page = toInteger(q.page);
  if (q.pageSize !== undefined) query.pageSize = toInteger(q.pageSize);
  return query;
}

/** Strict integer parsing: anything but an optional sign and digits becomes NaN (rejected later). */
function toInteger(value: string): number {
  return /^[+-]?\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
}
