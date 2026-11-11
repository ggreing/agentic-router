import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError, createApp } from '../src/index.ts';

type T = { id: string; createdAt: string; updatedAt: string };
type Event = {
  id: string;
  taskId: string;
  type: string;
  actorId: string | null;
  at: string;
  changes: Record<string, { from: unknown; to: unknown }>;
};
type Res = { status: number; body: unknown };
type Req = { params?: Record<string, string>; body?: unknown; userId?: string };
// Loose views so the test does not depend on how the new members are typed.
type Svc = {
  createTask(input: Record<string, unknown>, actorId?: string | null): T;
  assignTask(taskId: string, userId: string | null, actorId?: string | null): T;
  changeStatus(taskId: string, status: string, actorId?: string | null): T;
  startTask(taskId: string, actorId?: string | null): T;
  completeTask(taskId: string, actorId?: string | null): T;
  getTaskHistory(taskId: string): Event[];
};
type Handlers = Record<'createTask' | 'assignTask' | 'updateStatus' | 'getTaskHistory', (req: Req) => Res>;

function setup() {
  let t = Date.UTC(2024, 5, 1, 9, 0, 0);
  const app = createApp({
    now: () => new Date((t += 60_000)),
    users: [
      { id: 'u1', name: 'Ada', email: 'ada@example.com', active: true },
      { id: 'u2', name: 'Bob', email: 'bob@example.com', active: true },
      { id: 'u3', name: 'Eve', email: 'eve@example.com', active: false },
    ],
  });
  return { service: app.service as unknown as Svc, handlers: app.handlers as unknown as Handlers };
}

function history(handlers: Handlers, id: string): Event[] {
  const res = handlers.getTaskHistory({ params: { id } });
  assert.equal(res.status, 200);
  return (res.body as { items: Event[] }).items;
}

test('creating a task through the handler records task.created', () => {
  const { handlers } = setup();
  const task = handlers.createTask({ body: { title: 'Write docs', priority: 'low' }, userId: 'u1' }).body as T;
  const items = history(handlers, task.id);
  assert.equal(items.length, 1);
  const [event] = items;
  assert.equal(typeof event.id, 'string');
  assert.equal(event.taskId, task.id);
  assert.equal(event.type, 'task.created');
  assert.equal(event.actorId, 'u1');
  assert.equal(event.at, task.createdAt);
  assert.deepEqual(event.changes, {});
});

test('a full lifecycle through the handlers', () => {
  const { handlers } = setup();
  const task = handlers.createTask({ body: { title: 'Ship', priority: 'high' }, userId: 'u1' }).body as T;
  const assigned = handlers.assignTask({ params: { id: task.id }, body: { userId: 'u2' }, userId: 'u1' }).body as T;
  const started = handlers.updateStatus({ params: { id: task.id }, body: { status: 'in_progress' }, userId: 'u2' }).body as T;
  const done = handlers.updateStatus({ params: { id: task.id }, body: { status: 'done' }, userId: 'u2' }).body as T;

  const items = history(handlers, task.id);
  assert.deepEqual(items.map((e) => e.type), ['task.created', 'task.assigned', 'task.status_changed', 'task.status_changed']);
  assert.deepEqual(items.map((e) => e.actorId), ['u1', 'u1', 'u2', 'u2']);
  assert.deepEqual(items[1].changes, { assigneeId: { from: null, to: 'u2' } });
  assert.deepEqual(items[2].changes, { status: { from: 'todo', to: 'in_progress' } });
  assert.deepEqual(items[3].changes, { status: { from: 'in_progress', to: 'done' } });
  assert.deepEqual(items.map((e) => e.at), [task.createdAt, assigned.updatedAt, started.updatedAt, done.updatedAt]);
});

test('anonymous requests and service calls without an actor record null', () => {
  const { handlers, service } = setup();
  const viaHandler = handlers.createTask({ body: { title: 'anon', priority: 'low' } }).body as T;
  assert.equal(history(handlers, viaHandler.id)[0].actorId, null);

  const task = service.createTask({ title: 'svc', priority: 'low' });
  service.assignTask(task.id, 'u1');
  service.startTask(task.id);
  service.completeTask(task.id, 'u2');
  const items = service.getTaskHistory(task.id);
  assert.deepEqual(items.map((e) => e.actorId), [null, null, null, 'u2']);
  service.changeStatus(task.id, 'in_progress', 'u1');
  const last = service.getTaskHistory(task.id).at(-1) as Event;
  assert.equal(last.actorId, 'u1');
  assert.deepEqual(last.changes, { status: { from: 'done', to: 'in_progress' } });
});

test('failed operations are not recorded', () => {
  const { handlers, service } = setup();
  const task = service.createTask({ title: 'a', priority: 'low' }, 'u1');
  assert.throws(() => service.completeTask(task.id, 'u1'), ConflictError);
  assert.throws(() => service.assignTask(task.id, 'ghost', 'u1'), NotFoundError);
  assert.throws(() => service.assignTask(task.id, 'u3', 'u1'), ConflictError);
  assert.equal(handlers.updateStatus({ params: { id: task.id }, body: { status: 'archived' }, userId: 'u1' }).status, 400);
  assert.equal(handlers.createTask({ body: { title: '' }, userId: 'u1' }).status, 400);
  assert.equal(service.getTaskHistory(task.id).length, 1);
});

test('re-assigning the same user is not recorded, unassigning is', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'a', priority: 'low' });
  service.assignTask(task.id, 'u1', 'u2');
  service.assignTask(task.id, 'u1', 'u2');
  service.assignTask(task.id, null, 'u2');
  const items = service.getTaskHistory(task.id);
  assert.deepEqual(items.map((e) => e.type), ['task.created', 'task.assigned', 'task.assigned']);
  assert.deepEqual(items[1].changes, { assigneeId: { from: null, to: 'u1' } });
  assert.deepEqual(items[2].changes, { assigneeId: { from: 'u1', to: null } });
});

test('history of an unknown task is a 404', () => {
  const { handlers, service } = setup();
  const res = handlers.getTaskHistory({ params: { id: 'task-404' } });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Task not found: task-404' });
  assert.throws(() => service.getTaskHistory('task-404'), { name: 'NotFoundError', message: 'Task not found: task-404' });
});

test('histories are kept per task and event ids are unique', () => {
  const { service } = setup();
  const a = service.createTask({ title: 'a', priority: 'low' });
  const b = service.createTask({ title: 'b', priority: 'low' });
  service.startTask(a.id);
  service.assignTask(b.id, 'u1');
  service.startTask(b.id);
  const ha = service.getTaskHistory(a.id);
  const hb = service.getTaskHistory(b.id);
  assert.equal(ha.length, 2);
  assert.equal(hb.length, 3);
  assert.ok(ha.every((e) => e.taskId === a.id));
  assert.ok(hb.every((e) => e.taskId === b.id));
  const allIds = [...ha, ...hb].map((e) => e.id);
  assert.equal(new Set(allIds).size, allIds.length);
});
