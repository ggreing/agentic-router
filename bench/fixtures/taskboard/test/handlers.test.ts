import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.ts';
import type { Task } from '../src/index.ts';

function setup() {
  return createApp({ users: [{ id: 'u1', name: 'Ada', email: 'ada@example.com', active: true }] });
}

test('createTask returns 201 with the task', () => {
  const { handlers } = setup();
  const res = handlers.createTask({ body: { title: 'Write docs', priority: 'low' } });
  assert.equal(res.status, 201);
  assert.equal((res.body as Task).title, 'Write docs');
});

test('createTask returns 400 with details for invalid input', () => {
  const { handlers } = setup();
  const res = handlers.createTask({ body: { title: 42 } });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, { error: 'Validation failed', details: ['title is required'] });
  assert.equal(handlers.createTask({}).status, 400);
});

test('getTask returns 404 for unknown ids', () => {
  const { handlers } = setup();
  const res = handlers.getTask({ params: { id: 'task-99' } });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Task not found: task-99' });
});

test('listTasks returns all tasks', () => {
  const { handlers } = setup();
  handlers.createTask({ body: { title: 'A', priority: 'low' } });
  handlers.createTask({ body: { title: 'B', priority: 'high' } });
  const res = handlers.listTasks({});
  assert.equal(res.status, 200);
  const { items } = res.body as { items: Task[] };
  assert.deepEqual(items.map((t) => t.title), ['A', 'B']);
});

test('assignTask and updateStatus', () => {
  const { handlers } = setup();
  const { id } = handlers.createTask({ body: { title: 'A', priority: 'low' } }).body as Task;
  const assigned = handlers.assignTask({ params: { id }, body: { userId: 'u1' } });
  assert.equal(assigned.status, 200);
  assert.equal((assigned.body as Task).assigneeId, 'u1');
  assert.equal(handlers.assignTask({ params: { id }, body: { userId: 7 } }).status, 400);

  const started = handlers.updateStatus({ params: { id }, body: { status: 'in_progress' } });
  assert.equal(started.status, 200);
  assert.equal((started.body as Task).status, 'in_progress');

  const bogus = handlers.updateStatus({ params: { id }, body: { status: 'archived' } });
  assert.equal(bogus.status, 400);
});

test('updateStatus returns 409 for a forbidden transition', () => {
  const { handlers } = setup();
  const { id } = handlers.createTask({ body: { title: 'A', priority: 'low' } }).body as Task;
  const res = handlers.updateStatus({ params: { id }, body: { status: 'done' } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Invalid status transition: todo -> done' });
});
