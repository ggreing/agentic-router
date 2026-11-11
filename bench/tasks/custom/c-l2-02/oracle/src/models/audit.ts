export type AuditEventType = 'task.created' | 'task.assigned' | 'task.status_changed';

export interface FieldChange {
  from: unknown;
  to: unknown;
}

/** One recorded change to a task. */
export interface AuditEvent {
  id: string;
  taskId: string;
  type: AuditEventType;
  /** User who made the change, or null when unknown (anonymous / system). */
  actorId: string | null;
  /** ISO 8601; equals the task's updatedAt (createdAt for task.created) after the change. */
  at: string;
  changes: Record<string, FieldChange>;
}
