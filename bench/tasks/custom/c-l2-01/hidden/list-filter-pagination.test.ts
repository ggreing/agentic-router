import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, createApp } from '../src/index.ts';

type Priority = 'low' | 'medium' | 'high';
type Status = 'todo' | 'in_progress' | 'done';
type T = { id: string; title: string };
type Page = { items: T[]; page: number; pageSize: number; total: number; totalPages: number };
type Res = { status: number; body: unknown };
type Seeded = { id: string; title: string; priority: Priority; assigneeId: string | null; status: Status };
// Loose view of the new service method so the test does not depend on its exact typing.
type QueryFn = (query?: Record<string, unknown>) => Page;

const USERS = [
  { id: 'u1', name: 'Ada', email: 'ada@example.com', active: true },
  { id: 'u2', name: 'Bob', email: 'bob@example.com', active: true },
];

function seed() {
  let t = Date.UTC(2024, 0, 1, 9, 0, 0);
  const app = createApp({ users: USERS, now: () => new Date((t += 60_000)) });
  const { service } = app;
  const created: Seeded[] = [];
  for (let i = 1; i <= 25; i++) {
    const priority = (['low', 'medium', 'high'] as const)[i % 3];
    const task = service.createTask({ title: `Task ${i}`, priority });
    let assigneeId: string | null = null;
    if (i % 2 === 0) assigneeId = 'u1';
    else if (i % 5 === 0) assigneeId = 'u2';
    if (assigneeId) service.assignTask(task.id, assigneeId);
    let status: Status = 'todo';
    if (i % 4 === 0 || i % 6 === 0) {
      service.startTask(task.id);
      status = 'in_progress';
    }
    if (i % 6 === 0) {
      service.completeTask(task.id);
      status = 'done';
    }
    created.push({ id: task.id, title: task.title, priority, assigneeId, status });
  }
  const list = (query?: Record<string, string>): Res => app.handlers.listTasks({ query });
  const queryTasks: QueryFn = (query) => (app.service as unknown as { queryTasks: QueryFn }).queryTasks(query);
  return { app, created, list, queryTasks };
}

const ids = (items: { id: string }[]) => items.map((t) => t.id);

test('no query: first page of 20 in creation order', () => {
  const { created, list } = seed();
  const res = list();
  assert.equal(res.status, 200);
  const body = res.body as Page;
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 20);
  assert.equal(body.total, 25);
  assert.equal(body.totalPages, 2);
  assert.deepEqual(ids(body.items), ids(created.slice(0, 20)));
  assert.deepEqual(ids((list({}).body as Page).items), ids(created.slice(0, 20)));
});

test('page and pageSize', () => {
  const { created, list } = seed();
  const second = list({ page: '2' }).body as Page;
  assert.equal(second.page, 2);
  assert.deepEqual(ids(second.items), ids(created.slice(20)));

  const third = list({ page: '3', pageSize: '10' }).body as Page;
  assert.equal(third.pageSize, 10);
  assert.equal(third.totalPages, 3);
  assert.deepEqual(ids(third.items), ids(created.slice(20, 25)));

  const all = list({ pageSize: '100' }).body as Page;
  assert.equal(all.items.length, 25);
  assert.equal(all.totalPages, 1);
});

test('a page past the end is empty, not an error', () => {
  const { list } = seed();
  const res = list({ page: '4', pageSize: '10' });
  assert.equal(res.status, 200);
  const body = res.body as Page;
  assert.deepEqual(body.items, []);
  assert.equal(body.total, 25);
  assert.equal(body.totalPages, 3);
});

test('status filter, single and comma-separated', () => {
  const { created, list } = seed();
  const inProgress = list({ status: 'in_progress' }).body as Page;
  const wantInProgress = created.filter((t) => t.status === 'in_progress');
  assert.equal(inProgress.total, wantInProgress.length);
  assert.deepEqual(ids(inProgress.items), ids(wantInProgress));

  const todoOrDone = list({ status: 'todo,done' }).body as Page;
  const want = created.filter((t) => t.status === 'todo' || t.status === 'done');
  assert.equal(todoOrDone.total, want.length);
  assert.deepEqual(ids(todoOrDone.items), ids(want.slice(0, 20)));
});

test('assignee filter, including none for unassigned', () => {
  const { created, list } = seed();
  const u1 = list({ assigneeId: 'u1' }).body as Page;
  assert.deepEqual(ids(u1.items), ids(created.filter((t) => t.assigneeId === 'u1')));
  const none = list({ assigneeId: 'none' }).body as Page;
  const unassigned = created.filter((t) => t.assigneeId === null);
  assert.equal(none.total, unassigned.length);
  assert.deepEqual(ids(none.items), ids(unassigned));
});

test('filters combine with AND and with pagination', () => {
  const { created, list } = seed();
  const combo = list({ priority: 'high', assigneeId: 'u1', status: 'todo' }).body as Page;
  const want = created.filter((t) => t.priority === 'high' && t.assigneeId === 'u1' && t.status === 'todo');
  assert.ok(want.length > 0);
  assert.equal(combo.total, want.length);
  assert.deepEqual(ids(combo.items), ids(want));

  const todos = created.filter((t) => t.status === 'todo');
  const paged = list({ status: 'todo', pageSize: '3', page: '2' }).body as Page;
  assert.equal(paged.total, todos.length);
  assert.equal(paged.totalPages, Math.ceil(todos.length / 3));
  assert.deepEqual(ids(paged.items), ids(todos.slice(3, 6)));
});

test('q searches titles case-insensitively', () => {
  const app = createApp();
  const titles = ['Fix login bug', 'Login page redesign', 'Logout flow', 'Update LOGIN docs', 'Signup'];
  const made = titles.map((title) => app.service.createTask({ title, priority: 'medium' }));
  const body = app.handlers.listTasks({ query: { q: 'login' } }).body as Page;
  assert.deepEqual(ids(body.items), [made[0].id, made[1].id, made[3].id]);
  const empty = app.handlers.listTasks({ query: { q: 'zzz' } }).body as Page;
  assert.equal(empty.total, 0);
  assert.equal(empty.totalPages, 0);
  assert.deepEqual(empty.items, []);
});

test('invalid query values give 400 Validation failed', () => {
  const { list } = seed();
  const bad: Record<string, string>[] = [
    { status: 'archived' },
    { status: 'todo,nope' },
    { priority: 'urgent' },
    { page: '0' },
    { page: 'abc' },
    { page: '1.5' },
    { pageSize: '0' },
    { pageSize: '101' },
  ];
  for (const query of bad) {
    const res = list(query);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(query)}`);
    const body = res.body as { error: string; details: unknown };
    assert.equal(body.error, 'Validation failed');
    assert.ok(Array.isArray(body.details) && body.details.length > 0);
  }
});

test('service.queryTasks', () => {
  const { app, created, queryTasks } = seed();
  const page = queryTasks();
  assert.equal(page.page, 1);
  assert.equal(page.pageSize, 20);
  assert.equal(page.total, 25);
  assert.equal(page.items.length, 20);

  const done = queryTasks({ status: ['done'] });
  assert.deepEqual(ids(done.items), ids(created.filter((t) => t.status === 'done')));

  const unassigned = created.filter((t) => t.assigneeId === null);
  const firstFive = queryTasks({ assigneeId: null, pageSize: 5 });
  assert.equal(firstFive.total, unassigned.length);
  assert.deepEqual(ids(firstFive.items), ids(unassigned.slice(0, 5)));

  assert.deepEqual(ids(queryTasks({ search: 'TASK 1' }).items), ids(created.filter((t) => t.title.startsWith('Task 1'))));

  assert.throws(() => queryTasks({ pageSize: 101 }), ValidationError);
  assert.throws(() => queryTasks({ page: 0 }), ValidationError);
  assert.throws(() => queryTasks({ status: ['nope'] }), ValidationError);

  assert.equal(app.service.listTasks().length, 25);
});
