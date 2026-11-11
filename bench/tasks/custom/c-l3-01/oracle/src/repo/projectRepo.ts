import type { Project } from '../models/project.ts';

/** Map-backed project storage. Returns copies so callers cannot mutate stored state. */
export class InMemoryProjectRepo {
  #projects = new Map<string, Project>();

  insert(project: Project): Project {
    if (this.#projects.has(project.id)) throw new Error(`Duplicate project id: ${project.id}`);
    this.#projects.set(project.id, { ...project });
    return { ...project };
  }

  findById(id: string): Project | undefined {
    const project = this.#projects.get(id);
    return project ? { ...project } : undefined;
  }

  /** Case-insensitive lookup by name. */
  findByName(name: string): Project | undefined {
    const wanted = name.toLowerCase();
    for (const project of this.#projects.values()) {
      if (project.name.toLowerCase() === wanted) return { ...project };
    }
    return undefined;
  }

  update(project: Project): Project {
    if (!this.#projects.has(project.id)) throw new Error(`Unknown project id: ${project.id}`);
    this.#projects.set(project.id, { ...project });
    return { ...project };
  }

  /** All projects in creation order. */
  list(): Project[] {
    return [...this.#projects.values()].map((project) => ({ ...project }));
  }
}
