import type { AuditEvent } from '../models/audit.ts';

function copy(event: AuditEvent): AuditEvent {
  return { ...event, changes: structuredClone(event.changes) };
}

/** Append-only, in-memory audit log. */
export class InMemoryAuditLog {
  #events: AuditEvent[] = [];

  append(event: AuditEvent): AuditEvent {
    this.#events.push(copy(event));
    return copy(event);
  }

  /** Events for one task, oldest first. */
  listByTask(taskId: string): AuditEvent[] {
    return this.#events.filter((event) => event.taskId === taskId).map(copy);
  }

  list(): AuditEvent[] {
    return this.#events.map(copy);
  }
}
