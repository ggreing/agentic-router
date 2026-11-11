import type { NewTaskInput, TaskStatus } from '../models/task.ts';
import type { TaskService } from '../service/taskService.ts';
import { ValidationError } from '../errors.ts';
import { bodyRecord, handle, ok, requireParam } from './http.ts';

export function createTaskHandlers(service: TaskService) {
  return {
    /** POST /tasks  body may carry projectId */
    createTask: handle((req) => ok(service.createTask(req.body as NewTaskInput, req.userId), 201)),

    /** GET /tasks/:id */
    getTask: handle((req) => ok(service.getTask(requireParam(req, 'id'), req.userId))),

    /** GET /tasks?projectId=... */
    listTasks: handle((req) => ok({ items: service.listTasks(req.userId, req.query?.projectId) })),

    /** PUT /tasks/:id/assignee  body: { userId: string | null } */
    assignTask: handle((req) => {
      const { userId } = bodyRecord(req);
      if (userId !== null && typeof userId !== 'string') {
        throw new ValidationError(['userId must be a string or null']);
      }
      return ok(service.assignTask(requireParam(req, 'id'), userId, req.userId));
    }),

    /** PUT /tasks/:id/status  body: { status } */
    updateStatus: handle((req) => {
      const { status } = bodyRecord(req);
      return ok(service.changeStatus(requireParam(req, 'id'), status as TaskStatus, req.userId));
    }),
  };
}

export type TaskHandlers = ReturnType<typeof createTaskHandlers>;
