import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.ts';

type TaskBody = { id: string; priority: string };

test('service: priority defaults to medium', () => {
  const { service } = createApp();
  assert.equal(service.createTask({ title: 'No priority given' }).priority, 'medium');
});

test('handler: POST without priority creates a medium task', () => {
  const { handlers, service } = createApp();
  const res = handlers.createTask({ body: { title: 'From the API' } });
  assert.equal(res.status, 201);
  const body = res.body as TaskBody;
  assert.equal(body.priority, 'medium');
  assert.equal(service.getTask(body.id).priority, 'medium');
});

test('an explicit priority is kept', () => {
  const { service } = createApp();
  assert.equal(service.createTask({ title: 'a', priority: 'low' }).priority, 'low');
  assert.equal(service.createTask({ title: 'b', priority: 'high' }).priority, 'high');
});
