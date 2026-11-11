import type { Task } from '../models/task.ts';

/** Map-backed task storage. Returns copies so callers cannot mutate stored state. */
export class InMemoryTaskRepo {
  #tasks = new Map<string, Task>();

  insert(task: Task): Task {
    if (this.#tasks.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    this.#tasks.set(task.id, { ...task });
    return { ...task };
  }

  findById(id: string): Task | undefined {
    const task = this.#tasks.get(id);
    return task ? { ...task } : undefined;
  }

  update(task: Task): Task {
    if (!this.#tasks.has(task.id)) throw new Error(`Unknown task id: ${task.id}`);
    this.#tasks.set(task.id, { ...task });
    return { ...task };
  }

  /** All tasks in insertion (creation) order. */
  list(): Task[] {
    return [...this.#tasks.values()].map((task) => ({ ...task }));
  }

  delete(id: string): boolean {
    return this.#tasks.delete(id);
  }
}
