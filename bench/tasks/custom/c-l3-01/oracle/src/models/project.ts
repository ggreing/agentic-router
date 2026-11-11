export type ProjectRole = 'owner' | 'admin' | 'member' | 'viewer';

export const PROJECT_ROLES: readonly ProjectRole[] = ['owner', 'admin', 'member', 'viewer'];
export const PROJECT_NAME_MAX_LENGTH = 60;

export interface Project {
  id: string;
  name: string;
  description: string;
  /** An archived project is read-only until it is unarchived. */
  archived: boolean;
  /** Id of the user who created the project (its first owner). */
  createdBy: string;
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  projectId: string;
  userId: string;
  role: ProjectRole;
  /** ISO 8601 timestamp. */
  addedAt: string;
}

export interface NewProjectInput {
  name: string;
  description?: string;
}

export interface ProjectPatch {
  name?: string;
  description?: string;
}

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a list of human-readable problems; empty when the input is valid.
 * With `partial` the name may be left out (an update that only changes the description).
 */
export function validateProjectInput(input: unknown, partial = false): string[] {
  if (!isRecord(input)) return ['body must be an object'];
  const errors: string[] = [];
  const { name, description } = input;
  if (name === undefined && partial) {
    // nothing to check
  } else if (typeof name !== 'string' || name.trim() === '') {
    errors.push('name is required');
  } else if (name.trim().length > PROJECT_NAME_MAX_LENGTH) {
    errors.push(`name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`);
  }
  if (description !== undefined && typeof description !== 'string') {
    errors.push('description must be a string');
  }
  return errors;
}
