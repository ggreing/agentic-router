import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError, ValidationError, createApp } from '../src/index.ts';

function setup() {
  let t = Date.UTC(2024, 0, 1, 9, 0, 0);
  return createApp({
    now: () => new Date((t += 60_000)),
    users: [
      { id: 'u1', name: 'Ada', email: 'ada@example.com', active: true },
      { id: 'u2', name: 'Bob', email: 'bob@example.com', active: false },
    ],
  });
}

test('createTask fills in defaults', () => {
  const { service } = setup();
  const task = service.createTask({ title: '  Write docs  ', priority: 'high' });
  assert.equal(task.title, 'Write docs');
  assert.equal(task.status, 'todo');
  assert.equal(task.priority, 'high');
  assert.equal(task.description, '');
  assert.equal(task.assigneeId, null);
  assert.equal(task.createdAt, task.updatedAt);
  assert.deepEqual(service.getTask(task.id), task);
});

test('createTask validates input', () => {
  const { service } = setup();
  assert.throws(() => service.createTask({ title: '' }), ValidationError);
  assert.throws(() => service.createTask({ title: 'x'.repeat(121) }), ValidationError);
  assert.throws(
    () => service.createTask({ title: 'ok', priority: 'urgent' as never }),
    (err: unknown) => err instanceof ValidationError && err.details.includes('priority must be one of: low, medium, high'),
  );
});

test('assignTask checks the user', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'Ship it', priority: 'medium' });
  const assigned = service.assignTask(task.id, 'u1');
  assert.equal(assigned.assigneeId, 'u1');
  assert.notEqual(assigned.updatedAt, task.updatedAt);
  assert.throws(() => service.assignTask(task.id, 'nobody'), NotFoundError);
  assert.throws(() => service.assignTask(task.id, 'u2'), ConflictError);
  assert.equal(service.assignTask(task.id, null).assigneeId, null);
});

test('a task moves todo -> in_progress -> done', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'Fix bug', priority: 'high' });
  assert.equal(service.startTask(task.id).status, 'in_progress');
  assert.equal(service.completeTask(task.id).status, 'done');
});

test('a todo task cannot be completed directly', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'Fix bug', priority: 'low' });
  assert.throws(() => service.completeTask(task.id), {
    name: 'ConflictError',
    message: 'Invalid status transition: todo -> done',
  });
});

test('unknown task ids raise NotFoundError', () => {
  const { service } = setup();
  assert.throws(() => service.getTask('task-404'), { message: 'Task not found: task-404' });
});
