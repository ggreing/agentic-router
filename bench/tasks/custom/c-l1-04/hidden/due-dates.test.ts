import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, createApp } from '../src/index.ts';

const DUE_MSG = 'dueDate must be a valid date in YYYY-MM-DD format';
const TODAY_MSG = 'today must be a valid date in YYYY-MM-DD format';

type T = { id: string; dueDate: string | null; status: string };
// Loose views so the test does not depend on how the new members are typed.
type Svc = {
  createTask(input: Record<string, unknown>): T;
  getTask(id: string): T;
  startTask(id: string): T;
  completeTask(id: string): T;
  listOverdueTasks(today: string): T[];
};
type Res = { status: number; body: unknown };
type Handlers = {
  createTask(req: { body?: unknown }): Res;
  listOverdueTasks(req: { query?: Record<string, string | undefined> }): Res;
};

function setup() {
  let t = Date.UTC(2024, 2, 1, 9, 0, 0);
  const app = createApp({ now: () => new Date((t += 60_000)) });
  return { service: app.service as unknown as Svc, handlers: app.handlers as unknown as Handlers };
}

test('dueDate defaults to null and is stored when valid', () => {
  const { service } = setup();
  assert.equal(service.createTask({ title: 'no due', priority: 'low' }).dueDate, null);
  assert.equal(service.createTask({ title: 'null due', priority: 'low', dueDate: null }).dueDate, null);
  const leap = service.createTask({ title: 'leap', priority: 'low', dueDate: '2024-02-29' });
  assert.equal(leap.dueDate, '2024-02-29');
  assert.equal(service.getTask(leap.id).dueDate, '2024-02-29');
});

test('invalid dueDate values are rejected by the service', () => {
  const { service } = setup();
  for (const dueDate of ['2023-02-29', '2024-13-01', '2024-04-31', '2024-2-01', '20240101', 'tomorrow', 20240101]) {
    assert.throws(
      () => service.createTask({ title: 'bad', priority: 'low', dueDate }),
      (err: unknown) => err instanceof ValidationError && err.details.includes(DUE_MSG),
      `dueDate ${JSON.stringify(dueDate)} should be rejected`,
    );
  }
});

test('createTask handler returns 400 for an invalid dueDate', () => {
  const { handlers } = setup();
  const res = handlers.createTask({ body: { title: 'bad', priority: 'low', dueDate: '2024-02-30' } });
  assert.equal(res.status, 400);
  const body = res.body as { error: string; details: string[] };
  assert.equal(body.error, 'Validation failed');
  assert.ok(body.details.includes(DUE_MSG));
});

test('listOverdueTasks filters, excludes done and due-today, and sorts', () => {
  const { service } = setup();
  const late = service.createTask({ title: 'A', priority: 'low', dueDate: '2024-03-09' });
  const oldest = service.createTask({ title: 'B', priority: 'low', dueDate: '2024-03-01' });
  const sameDay = service.createTask({ title: 'C', priority: 'low', dueDate: '2024-03-01' });
  service.createTask({ title: 'due today', priority: 'low', dueDate: '2024-03-10' });
  service.createTask({ title: 'future', priority: 'low', dueDate: '2024-04-01' });
  service.createTask({ title: 'no due', priority: 'low' });
  const finished = service.createTask({ title: 'done', priority: 'low', dueDate: '2024-02-01' });
  service.startTask(finished.id);
  service.completeTask(finished.id);
  service.startTask(late.id);

  const overdue = service.listOverdueTasks('2024-03-10');
  assert.deepEqual(overdue.map((t) => t.id), [oldest.id, sameDay.id, late.id]);
  assert.throws(
    () => service.listOverdueTasks('2024-3-10'),
    (err: unknown) => err instanceof ValidationError && err.details.includes(TODAY_MSG),
  );
});

test('listOverdueTasks handler', () => {
  const { handlers, service } = setup();
  const a = service.createTask({ title: 'A', priority: 'low', dueDate: '2024-01-15' });
  service.createTask({ title: 'B', priority: 'low', dueDate: '2024-12-31' });
  const res = handlers.listOverdueTasks({ query: { today: '2024-06-01' } });
  assert.equal(res.status, 200);
  assert.deepEqual((res.body as { items: T[] }).items.map((t) => t.id), [a.id]);
  assert.equal(handlers.listOverdueTasks({ query: { today: 'June 1st' } }).status, 400);
  assert.equal(handlers.listOverdueTasks({ query: {} }).status, 400);
});
