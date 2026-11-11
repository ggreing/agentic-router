import type { User } from './models/user.ts';
import { InMemoryTaskRepo } from './repo/taskRepo.ts';
import { InMemoryUserRepo } from './repo/userRepo.ts';
import { InMemoryAuditLog } from './repo/auditRepo.ts';
import { TaskService } from './service/taskService.ts';
import { createTaskHandlers } from './handlers/taskHandlers.ts';

export interface AppOptions {
  /** Clock for timestamps; tests inject a fake one. */
  now?: () => Date;
  /** Users to seed the user repository with. */
  users?: User[];
}

export function createApp(options: AppOptions = {}) {
  const taskRepo = new InMemoryTaskRepo();
  const userRepo = new InMemoryUserRepo(options.users ?? []);
  const auditLog = new InMemoryAuditLog();
  const service = new TaskService(taskRepo, userRepo, { now: options.now, auditLog });
  const handlers = createTaskHandlers(service);
  return { taskRepo, userRepo, auditLog, service, handlers };
}

export type App = ReturnType<typeof createApp>;
