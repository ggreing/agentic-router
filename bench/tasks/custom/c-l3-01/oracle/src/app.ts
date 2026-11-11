import type { User } from './models/user.ts';
import { InMemoryMembershipRepo } from './repo/membershipRepo.ts';
import { InMemoryProjectRepo } from './repo/projectRepo.ts';
import { InMemoryTaskRepo } from './repo/taskRepo.ts';
import { InMemoryUserRepo } from './repo/userRepo.ts';
import { AccessControl } from './service/permissions.ts';
import { ProjectService } from './service/projectService.ts';
import { TaskService } from './service/taskService.ts';
import { createProjectHandlers } from './handlers/projectHandlers.ts';
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
  const projectRepo = new InMemoryProjectRepo();
  const membershipRepo = new InMemoryMembershipRepo();
  const access = new AccessControl(userRepo, projectRepo, membershipRepo);
  const service = new TaskService(taskRepo, userRepo, { now: options.now, access });
  const projectService = new ProjectService(
    { projects: projectRepo, memberships: membershipRepo, users: userRepo, tasks: taskRepo },
    access,
    { now: options.now },
  );
  const handlers = { ...createTaskHandlers(service), ...createProjectHandlers(projectService) };
  return { taskRepo, userRepo, projectRepo, membershipRepo, access, service, projectService, handlers };
}

export type App = ReturnType<typeof createApp>;
