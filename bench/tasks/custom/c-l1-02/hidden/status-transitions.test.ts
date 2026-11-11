import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, createApp } from '../src/index.ts';

type TaskBody = { id: string; status: string; updatedAt: string };

function setup() {
  let t = Date.UTC(2024, 4, 1, 9, 0, 0);
  return createApp({ now: () => new Date((t += 60_000)) });
}

test('todo and in_progress tasks can be cancelled', () => {
  const { service } = setup();
  const a = service.createTask({ title: 'a', priority: 'low' });
  assert.equal(service.cancelTask(a.id).status, 'cancelled');

  const b = service.createTask({ title: 'b', priority: 'low' });
  service.startTask(b.id);
  assert.equal(service.changeStatus(b.id, 'cancelled').status, 'cancelled');
});

test('cancel through the handler returns 200', () => {
  const { handlers } = setup();
  const { id } = handlers.createTask({ body: { title: 'a', priority: 'low' } }).body as TaskBody;
  const res = handlers.updateStatus({ params: { id }, body: { status: 'cancelled' } });
  assert.equal(res.status, 200);
  assert.equal((res.body as TaskBody).status, 'cancelled');
});

test('cancelled is terminal', () => {
  const { handlers, service } = setup();
  const { id } = handlers.createTask({ body: { title: 'a', priority: 'low' } }).body as TaskBody;
  service.cancelTask(id);
  const res = handlers.updateStatus({ params: { id }, body: { status: 'todo' } });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'Invalid status transition: cancelled -> todo' });
  assert.throws(() => service.startTask(id), ConflictError);
});

test('done can only be reopened to in_progress', () => {
  const { handlers, service } = setup();
  const { id } = handlers.createTask({ body: { title: 'a', priority: 'low' } }).body as TaskBody;
  service.startTask(id);
  service.completeTask(id);
  const cancel = handlers.updateStatus({ params: { id }, body: { status: 'cancelled' } });
  assert.equal(cancel.status, 409);
  assert.deepEqual(cancel.body, { error: 'Invalid status transition: done -> cancelled' });
  assert.throws(() => service.changeStatus(id, 'todo'), { message: 'Invalid status transition: done -> todo' });
  assert.equal(service.changeStatus(id, 'in_progress').status, 'in_progress');
});

test('todo -> done is still rejected', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'a', priority: 'low' });
  assert.throws(() => service.completeTask(task.id), { message: 'Invalid status transition: todo -> done' });
});

test('same-status change is a no-op', () => {
  const { handlers, service } = setup();
  const task = service.createTask({ title: 'a', priority: 'low' });
  const same = service.changeStatus(task.id, 'todo');
  assert.equal(same.status, 'todo');
  assert.equal(same.updatedAt, task.updatedAt);
  assert.equal(service.getTask(task.id).updatedAt, task.updatedAt);

  const started = service.startTask(task.id);
  const res = handlers.updateStatus({ params: { id: task.id }, body: { status: 'in_progress' } });
  assert.equal(res.status, 200);
  assert.equal((res.body as TaskBody).updatedAt, started.updatedAt);
});
