import type { Membership } from '../models/project.ts';

/** Memberships in the order they were added; at most one per (project, user). */
export class InMemoryMembershipRepo {
  #items: Membership[] = [];

  insert(membership: Membership): Membership {
    if (this.find(membership.projectId, membership.userId)) {
      throw new Error(`Duplicate membership: ${membership.projectId}/${membership.userId}`);
    }
    this.#items.push({ ...membership });
    return { ...membership };
  }

  find(projectId: string, userId: string): Membership | undefined {
    const found = this.#items.find((m) => m.projectId === projectId && m.userId === userId);
    return found ? { ...found } : undefined;
  }

  update(membership: Membership): Membership {
    const index = this.#items.findIndex((m) => m.projectId === membership.projectId && m.userId === membership.userId);
    if (index < 0) throw new Error(`Unknown membership: ${membership.projectId}/${membership.userId}`);
    this.#items[index] = { ...membership };
    return { ...membership };
  }

  delete(projectId: string, userId: string): boolean {
    const index = this.#items.findIndex((m) => m.projectId === projectId && m.userId === userId);
    if (index < 0) return false;
    this.#items.splice(index, 1);
    return true;
  }

  listByProject(projectId: string): Membership[] {
    return this.#items.filter((m) => m.projectId === projectId).map((m) => ({ ...m }));
  }

  listByUser(userId: string): Membership[] {
    return this.#items.filter((m) => m.userId === userId).map((m) => ({ ...m }));
  }
}
