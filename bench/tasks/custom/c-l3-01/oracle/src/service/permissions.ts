import type { Project, ProjectRole } from '../models/project.ts';
import type { User } from '../models/user.ts';
import type { InMemoryMembershipRepo } from '../repo/membershipRepo.ts';
import type { InMemoryProjectRepo } from '../repo/projectRepo.ts';
import type { InMemoryUserRepo } from '../repo/userRepo.ts';
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../errors.ts';

export type ProjectAction =
  | 'project.read'
  | 'project.update'
  | 'project.archive'
  | 'member.manage'
  | 'task.read'
  | 'task.write';

/** What each role may do inside a project. */
export const PERMISSIONS: Record<ProjectRole, readonly ProjectAction[]> = {
  owner: ['project.read', 'project.update', 'project.archive', 'member.manage', 'task.read', 'task.write'],
  admin: ['project.read', 'project.update', 'member.manage', 'task.read', 'task.write'],
  member: ['project.read', 'task.read', 'task.write'],
  viewer: ['project.read', 'task.read'],
};

const WRITE_ACTIONS: readonly ProjectAction[] = ['project.update', 'member.manage', 'task.write'];

export function can(role: ProjectRole, action: ProjectAction): boolean {
  return PERMISSIONS[role]?.includes(action) ?? false;
}

export interface Access {
  actor: User;
  project: Project;
  role: ProjectRole;
}

/**
 * The one place that answers "may this caller do that in this project".
 * Checks run in a fixed order: caller (401, inactive 403), project (404), membership and role (403),
 * archived project on a write (409).
 */
export class AccessControl {
  #users: InMemoryUserRepo;
  #projects: InMemoryProjectRepo;
  #memberships: InMemoryMembershipRepo;

  constructor(users: InMemoryUserRepo, projects: InMemoryProjectRepo, memberships: InMemoryMembershipRepo) {
    this.#users = users;
    this.#projects = projects;
    this.#memberships = memberships;
  }

  requireActor(actorId: string | undefined): User {
    const actor = actorId ? this.#users.findById(actorId) : undefined;
    if (!actor) throw new UnauthorizedError();
    if (!actor.active) throw new ForbiddenError(`User is inactive: ${actor.id}`);
    return actor;
  }

  requireProject(projectId: string): Project {
    const project = this.#projects.findById(projectId);
    if (!project) throw new NotFoundError(`Project not found: ${projectId}`);
    return project;
  }

  roleOf(projectId: string, userId: string): ProjectRole | undefined {
    return this.#memberships.find(projectId, userId)?.role;
  }

  /** Member of the project in any role; no permission check beyond that. */
  requireMember(actorId: string | undefined, projectId: string): Access {
    const actor = this.requireActor(actorId);
    const project = this.requireProject(projectId);
    const role = this.roleOf(projectId, actor.id);
    if (!role) throw new ForbiddenError(`Not a member of project: ${projectId}`);
    return { actor, project, role };
  }

  authorize(actorId: string | undefined, projectId: string, action: ProjectAction): Access {
    const access = this.requireMember(actorId, projectId);
    if (!can(access.role, action)) throw new ForbiddenError(`Role ${access.role} may not ${action}`);
    if (WRITE_ACTIONS.includes(action)) this.requireActive(access.project);
    return access;
  }

  requireActive(project: Project): void {
    if (project.archived) throw new ConflictError(`Project is archived: ${project.id}`);
  }
}
