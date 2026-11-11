import type { Membership, NewProjectInput, Project, ProjectPatch, ProjectRole } from '../models/project.ts';
import { PROJECT_ROLES, isProjectRole, validateProjectInput } from '../models/project.ts';
import type { InMemoryMembershipRepo } from '../repo/membershipRepo.ts';
import type { InMemoryProjectRepo } from '../repo/projectRepo.ts';
import type { InMemoryTaskRepo } from '../repo/taskRepo.ts';
import type { InMemoryUserRepo } from '../repo/userRepo.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { createIdGenerator } from '../ids.ts';
import type { AccessControl } from './permissions.ts';

export interface ProjectServiceOptions {
  now?: () => Date;
  nextId?: () => string;
}

export interface ProjectRepos {
  projects: InMemoryProjectRepo;
  memberships: InMemoryMembershipRepo;
  users: InMemoryUserRepo;
  tasks: InMemoryTaskRepo;
}

const LAST_OWNER = 'Project must keep at least one owner';

export class ProjectService {
  #projects: InMemoryProjectRepo;
  #memberships: InMemoryMembershipRepo;
  #users: InMemoryUserRepo;
  #tasks: InMemoryTaskRepo;
  #access: AccessControl;
  #now: () => Date;
  #nextId: () => string;

  constructor(repos: ProjectRepos, access: AccessControl, options: ProjectServiceOptions = {}) {
    this.#projects = repos.projects;
    this.#memberships = repos.memberships;
    this.#users = repos.users;
    this.#tasks = repos.tasks;
    this.#access = access;
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? createIdGenerator('project');
  }

  /** The creator becomes the project's first owner. */
  createProject(actorId: string | undefined, input: NewProjectInput): Project {
    const actor = this.#access.requireActor(actorId);
    const errors = validateProjectInput(input);
    if (errors.length > 0) throw new ValidationError(errors);
    const name = input.name.trim();
    this.#requireFreeName(name);
    const timestamp = this.#now().toISOString();
    const project = this.#projects.insert({
      id: this.#nextId(),
      name,
      description: input.description ?? '',
      archived: false,
      createdBy: actor.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#memberships.insert({ projectId: project.id, userId: actor.id, role: 'owner', addedAt: timestamp });
    return project;
  }

  getProject(actorId: string | undefined, projectId: string): Project {
    return this.#access.authorize(actorId, projectId, 'project.read').project;
  }

  /** Projects the caller is a member of, in creation order; archived ones only on request. */
  listProjects(actorId: string | undefined, options: { includeArchived?: boolean } = {}): Project[] {
    const actor = this.#access.requireActor(actorId);
    const mine = new Set(this.#memberships.listByUser(actor.id).map((m) => m.projectId));
    return this.#projects.list().filter((p) => mine.has(p.id) && (options.includeArchived || !p.archived));
  }

  updateProject(actorId: string | undefined, projectId: string, patch: ProjectPatch): Project {
    const { project } = this.#access.authorize(actorId, projectId, 'project.update');
    const errors = validateProjectInput(patch, true);
    if (errors.length > 0) throw new ValidationError(errors);
    const next = { ...project };
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name.toLowerCase() !== project.name.toLowerCase()) this.#requireFreeName(name);
      next.name = name;
    }
    if (patch.description !== undefined) next.description = patch.description;
    return this.#projects.update({ ...next, updatedAt: this.#now().toISOString() });
  }

  archiveProject(actorId: string | undefined, projectId: string): Project {
    return this.#setArchived(actorId, projectId, true);
  }

  unarchiveProject(actorId: string | undefined, projectId: string): Project {
    return this.#setArchived(actorId, projectId, false);
  }

  listMembers(actorId: string | undefined, projectId: string): Membership[] {
    this.#access.authorize(actorId, projectId, 'project.read');
    return this.#memberships.listByProject(projectId);
  }

  addMember(actorId: string | undefined, projectId: string, userId: unknown, role: unknown): Membership {
    const access = this.#access.authorize(actorId, projectId, 'member.manage');
    const errors: string[] = [];
    if (typeof userId !== 'string' || userId === '') errors.push('userId is required');
    if (!isProjectRole(role)) errors.push(`role must be one of: ${PROJECT_ROLES.join(', ')}`);
    if (errors.length > 0) throw new ValidationError(errors);
    this.#requireMayGrant(access.role, role as ProjectRole);
    const user = this.#users.findById(userId as string);
    if (!user) throw new NotFoundError(`User not found: ${userId}`);
    if (!user.active) throw new ConflictError(`User is inactive: ${user.id}`);
    if (this.#memberships.find(projectId, user.id)) throw new ConflictError(`Already a member: ${user.id}`);
    return this.#memberships.insert({
      projectId,
      userId: user.id,
      role: role as ProjectRole,
      addedAt: this.#now().toISOString(),
    });
  }

  changeMemberRole(actorId: string | undefined, projectId: string, userId: string, role: unknown): Membership {
    const access = this.#access.authorize(actorId, projectId, 'member.manage');
    if (!isProjectRole(role)) throw new ValidationError([`role must be one of: ${PROJECT_ROLES.join(', ')}`]);
    const membership = this.#requireMembership(projectId, userId);
    if (membership.role === 'owner' && access.role !== 'owner') {
      throw new ForbiddenError('Only an owner may change an owner');
    }
    this.#requireMayGrant(access.role, role);
    if (membership.role === 'owner' && role !== 'owner') this.#requireAnotherOwner(projectId, userId);
    return this.#memberships.update({ ...membership, role });
  }

  /**
   * Removes a member; anyone may remove themselves. Tasks of the project assigned to that user
   * become unassigned. Returns the ids of those tasks.
   */
  removeMember(actorId: string | undefined, projectId: string, userId: string): string[] {
    const access = this.#access.requireMember(actorId, projectId);
    const self = access.actor.id === userId;
    if (!self && access.role !== 'owner' && access.role !== 'admin') {
      throw new ForbiddenError(`Role ${access.role} may not member.manage`);
    }
    this.#access.requireActive(access.project);
    const membership = this.#requireMembership(projectId, userId);
    if (membership.role === 'owner' && access.role !== 'owner') {
      throw new ForbiddenError('Only an owner may remove an owner');
    }
    if (membership.role === 'owner') this.#requireAnotherOwner(projectId, userId);
    this.#memberships.delete(projectId, userId);
    const timestamp = this.#now().toISOString();
    const unassigned: string[] = [];
    for (const task of this.#tasks.list()) {
      if (task.projectId !== projectId || task.assigneeId !== userId) continue;
      this.#tasks.update({ ...task, assigneeId: null, updatedAt: timestamp });
      unassigned.push(task.id);
    }
    return unassigned;
  }

  #setArchived(actorId: string | undefined, projectId: string, archived: boolean): Project {
    const { project } = this.#access.authorize(actorId, projectId, 'project.archive');
    if (project.archived === archived) return project;
    return this.#projects.update({ ...project, archived, updatedAt: this.#now().toISOString() });
  }

  #requireFreeName(name: string): void {
    if (this.#projects.findByName(name)) throw new ConflictError(`Project name already in use: ${name}`);
  }

  #requireMembership(projectId: string, userId: string): Membership {
    const membership = this.#memberships.find(projectId, userId);
    if (!membership) throw new NotFoundError(`Member not found: ${userId}`);
    return membership;
  }

  #requireMayGrant(actorRole: ProjectRole, role: ProjectRole): void {
    if (role === 'owner' && actorRole !== 'owner') throw new ForbiddenError('Only an owner may grant the owner role');
  }

  #requireAnotherOwner(projectId: string, userId: string): void {
    const others = this.#memberships.listByProject(projectId).filter((m) => m.role === 'owner' && m.userId !== userId);
    if (others.length === 0) throw new ConflictError(LAST_OWNER);
  }
}
