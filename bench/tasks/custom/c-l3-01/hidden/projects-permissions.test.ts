import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as taskboard from '../src/index.ts';

type Res = { status: number; body: unknown };
type Req = { userId?: string; params?: Record<string, string>; query?: Record<string, string | undefined>; body?: unknown };
type Handlers = Record<string, (req: Req) => Res>;
type Project = { id: string; name: string; description: string; archived: boolean; createdBy: string; createdAt: string; updatedAt: string };
type Member = { projectId: string; userId: string; role: string; addedAt: string };
type Task = { id: string; title: string; assigneeId: string | null; projectId: string | null; status: string; updatedAt: string };

const USERS = [
  { id: 'ada', name: 'Ada', email: 'ada@example.com', active: true },
  { id: 'bob', name: 'Bob', email: 'bob@example.com', active: true },
  { id: 'cy', name: 'Cy', email: 'cy@example.com', active: true },
  { id: 'dee', name: 'Dee', email: 'dee@example.com', active: true },
  { id: 'eve', name: 'Eve', email: 'eve@example.com', active: true },
  { id: 'zed', name: 'Zed', email: 'zed@example.com', active: false },
];

function setup() {
  let t = Date.UTC(2024, 0, 1, 9, 0, 0);
  const app = taskboard.createApp({ users: USERS, now: () => new Date((t += 60_000)) });
  const h = app.handlers as unknown as Handlers;
  const call = (name: string, req: Req): Res => {
    assert.equal(typeof h[name], 'function', `app.handlers.${name} is missing`);
    return h[name]!(req);
  };
  const okBody = <T>(res: Res, status = 200): T => {
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body as T;
  };
  return { app, call, okBody };
}

/** A project owned by ada with bob = admin, cy = member, dee = viewer. eve is not a member. */
function team() {
  const s = setup();
  const project = s.okBody<Project>(s.call('createProject', { userId: 'ada', body: { name: 'Apollo' } }), 201);
  const id = project.id;
  for (const [userId, role] of [['bob', 'admin'], ['cy', 'member'], ['dee', 'viewer']]) {
    s.okBody<Member>(s.call('addMember', { userId: 'ada', params: { id }, body: { userId, role } }), 201);
  }
  const newTask = (userId: string, title: string): Task =>
    s.okBody<Task>(s.call('createTask', { userId, body: { title, projectId: id } }), 201);
  return { ...s, project, id, newTask };
}

const errorOf = (res: Res): unknown => (res.body as { error?: unknown }).error;

test('the permission matrix', () => {
  const can = (taskboard as unknown as { can: (role: string, action: string) => boolean }).can;
  assert.equal(typeof can, 'function', 'can(role, action) is exported from src/index.ts');
  const actions = ['project.read', 'project.update', 'project.archive', 'member.manage', 'task.read', 'task.write'];
  const expected: Record<string, string[]> = {
    owner: actions,
    admin: ['project.read', 'project.update', 'member.manage', 'task.read', 'task.write'],
    member: ['project.read', 'task.read', 'task.write'],
    viewer: ['project.read', 'task.read'],
  };
  for (const [role, allowed] of Object.entries(expected)) {
    for (const action of actions) assert.equal(can(role, action), allowed.includes(action), `${role} ${action}`);
  }
});

test('createProject: the creator becomes the owner', () => {
  const { call, okBody } = setup();
  const project = okBody<Project>(call('createProject', { userId: 'ada', body: { name: '  Apollo  ', description: 'Moon' } }), 201);
  assert.equal(project.id, 'project-1');
  assert.equal(project.name, 'Apollo');
  assert.equal(project.description, 'Moon');
  assert.equal(project.archived, false);
  assert.equal(project.createdBy, 'ada');
  assert.equal(project.createdAt, project.updatedAt);
  assert.ok(!Number.isNaN(Date.parse(project.createdAt)));

  const second = okBody<Project>(call('createProject', { userId: 'bob', body: { name: 'Borealis' } }), 201);
  assert.equal(second.id, 'project-2');
  assert.equal(second.description, '');

  const members = okBody<{ items: Member[] }>(call('listMembers', { userId: 'ada', params: { id: project.id } }));
  assert.deepEqual(members.items.map((m) => [m.projectId, m.userId, m.role]), [[project.id, 'ada', 'owner']]);
  assert.deepEqual(okBody<Project>(call('getProject', { userId: 'ada', params: { id: project.id } })), project);
});

test('createProject: authentication, validation and unique names', () => {
  const { call } = setup();
  const anonymous = call('createProject', { body: { name: 'Apollo' } });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(anonymous.body, { error: 'Authentication required' });
  assert.equal(call('createProject', { userId: 'nobody', body: { name: 'Apollo' } }).status, 401);
  assert.equal(call('createProject', { userId: 'zed', body: { name: 'Apollo' } }).status, 403);

  const empty = call('createProject', { userId: 'ada', body: { name: '   ' } });
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body, { error: 'Validation failed', details: ['name is required'] });
  const long = call('createProject', { userId: 'ada', body: { name: 'x'.repeat(61) } });
  assert.deepEqual(long.body, { error: 'Validation failed', details: ['name must be at most 60 characters'] });
  assert.equal(call('createProject', { userId: 'ada', body: { name: 'x'.repeat(60) } }).status, 201);
  assert.equal(call('createProject', { userId: 'ada', body: { name: 'Apollo', description: 7 } }).status, 400);
  assert.equal(call('createProject', { userId: 'ada' }).status, 400);

  assert.equal(call('createProject', { userId: 'ada', body: { name: 'Apollo' } }).status, 201);
  const duplicate = call('createProject', { userId: 'bob', body: { name: 'apollo' } });
  assert.equal(duplicate.status, 409);
});

test('projects are visible to their members only', () => {
  const { call, okBody, id, project } = team();
  const other = okBody<Project>(call('createProject', { userId: 'eve', body: { name: 'Borealis' } }), 201);

  for (const userId of ['ada', 'bob', 'cy', 'dee']) {
    assert.deepEqual(okBody<Project>(call('getProject', { userId, params: { id } })), project);
    assert.deepEqual(okBody<{ items: Project[] }>(call('listProjects', { userId })).items.map((p) => p.id), [id]);
    assert.equal(okBody<{ items: Member[] }>(call('listMembers', { userId, params: { id } })).items.length, 4);
  }
  assert.deepEqual(okBody<{ items: Project[] }>(call('listProjects', { userId: 'eve' })).items.map((p) => p.id), [other.id]);

  const outsider = call('getProject', { userId: 'eve', params: { id } });
  assert.equal(outsider.status, 403);
  assert.deepEqual(outsider.body, { error: `Not a member of project: ${id}` });
  assert.equal(call('listMembers', { userId: 'eve', params: { id } }).status, 403);

  assert.equal(call('getProject', { params: { id } }).status, 401);
  assert.equal(call('listProjects', {}).status, 401);
  const missing = call('getProject', { userId: 'ada', params: { id: 'project-99' } });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Project not found: project-99' });
  // the caller is checked before the project
  assert.equal(call('getProject', { params: { id: 'project-99' } }).status, 401);
});

test('updateProject needs owner or admin', () => {
  const { call, okBody, id, project } = team();
  const renamed = okBody<Project>(call('updateProject', { userId: 'bob', params: { id }, body: { name: ' Artemis ' } }));
  assert.equal(renamed.name, 'Artemis');
  assert.equal(renamed.description, '');
  assert.ok(renamed.updatedAt > project.updatedAt);
  assert.equal(renamed.createdAt, project.createdAt);
  const described = okBody<Project>(call('updateProject', { userId: 'ada', params: { id }, body: { description: 'Back to the Moon' } }));
  assert.deepEqual([described.name, described.description], ['Artemis', 'Back to the Moon']);

  assert.equal(call('updateProject', { userId: 'cy', params: { id }, body: { name: 'Nope' } }).status, 403);
  assert.equal(call('updateProject', { userId: 'dee', params: { id }, body: { name: 'Nope' } }).status, 403);
  assert.equal(call('updateProject', { userId: 'eve', params: { id }, body: { name: 'Nope' } }).status, 403);
  assert.equal(call('updateProject', { userId: 'ada', params: { id }, body: { name: '' } }).status, 400);

  okBody<Project>(call('createProject', { userId: 'eve', body: { name: 'Borealis' } }), 201);
  assert.equal(call('updateProject', { userId: 'ada', params: { id }, body: { name: 'BOREALIS' } }).status, 409);
  // keeping its own name (in another case) is not a clash
  assert.equal(okBody<Project>(call('updateProject', { userId: 'ada', params: { id }, body: { name: 'ARTEMIS' } })).name, 'ARTEMIS');
});

test('addMember: who may add whom', () => {
  const { call, okBody, id } = team();
  const members = okBody<{ items: Member[] }>(call('listMembers', { userId: 'dee', params: { id } })).items;
  assert.deepEqual(members.map((m) => [m.userId, m.role]), [['ada', 'owner'], ['bob', 'admin'], ['cy', 'member'], ['dee', 'viewer']]);
  for (const m of members) {
    assert.equal(m.projectId, id);
    assert.ok(!Number.isNaN(Date.parse(m.addedAt)));
  }

  // member and viewer cannot manage members; outsiders neither
  for (const userId of ['cy', 'dee', 'eve']) {
    assert.equal(call('addMember', { userId, params: { id }, body: { userId: 'eve', role: 'viewer' } }).status, 403);
  }
  // an admin adds members but cannot hand out the owner role
  assert.equal(call('addMember', { userId: 'bob', params: { id }, body: { userId: 'eve', role: 'owner' } }).status, 403);
  const added = okBody<Member>(call('addMember', { userId: 'bob', params: { id }, body: { userId: 'eve', role: 'member' } }), 201);
  assert.deepEqual([added.projectId, added.userId, added.role], [id, 'eve', 'member']);

  const again = call('addMember', { userId: 'ada', params: { id }, body: { userId: 'eve', role: 'viewer' } });
  assert.equal(again.status, 409);
  const badRole = call('addMember', { userId: 'ada', params: { id }, body: { userId: 'eve', role: 'boss' } });
  assert.equal(badRole.status, 400);
  assert.deepEqual(badRole.body, { error: 'Validation failed', details: ['role must be one of: owner, admin, member, viewer'] });
  assert.equal(call('addMember', { userId: 'ada', params: { id }, body: { role: 'member' } }).status, 400);
  const unknown = call('addMember', { userId: 'ada', params: { id }, body: { userId: 'ghost', role: 'member' } });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, { error: 'User not found: ghost' });
  const inactive = call('addMember', { userId: 'ada', params: { id }, body: { userId: 'zed', role: 'member' } });
  assert.equal(inactive.status, 409);
  assert.deepEqual(inactive.body, { error: 'User is inactive: zed' });
  assert.equal(call('addMember', { params: { id }, body: { userId: 'eve', role: 'member' } }).status, 401);
});

test('changeMemberRole: owners are protected and one owner always remains', () => {
  const { call, okBody, id } = team();
  const promoted = okBody<Member>(call('changeMemberRole', { userId: 'bob', params: { id, userId: 'dee' }, body: { role: 'member' } }));
  assert.deepEqual([promoted.userId, promoted.role], ['dee', 'member']);

  assert.equal(call('changeMemberRole', { userId: 'cy', params: { id, userId: 'dee' }, body: { role: 'viewer' } }).status, 403);
  // an admin can neither touch an owner nor make one
  assert.equal(call('changeMemberRole', { userId: 'bob', params: { id, userId: 'ada' }, body: { role: 'member' } }).status, 403);
  assert.equal(call('changeMemberRole', { userId: 'bob', params: { id, userId: 'cy' }, body: { role: 'owner' } }).status, 403);
  assert.equal(call('changeMemberRole', { userId: 'ada', params: { id, userId: 'cy' }, body: { role: 'chief' } }).status, 400);
  assert.equal(call('changeMemberRole', { userId: 'ada', params: { id, userId: 'eve' }, body: { role: 'member' } }).status, 404);

  // the only owner cannot step down ...
  const last = call('changeMemberRole', { userId: 'ada', params: { id, userId: 'ada' }, body: { role: 'admin' } });
  assert.equal(last.status, 409);
  assert.deepEqual(last.body, { error: 'Project must keep at least one owner' });
  // ... until there is a second one
  okBody<Member>(call('changeMemberRole', { userId: 'ada', params: { id, userId: 'cy' }, body: { role: 'owner' } }));
  assert.equal(okBody<Member>(call('changeMemberRole', { userId: 'ada', params: { id, userId: 'ada' }, body: { role: 'admin' } })).role, 'admin');
  const roles = okBody<{ items: Member[] }>(call('listMembers', { userId: 'ada', params: { id } })).items.map((m) => [m.userId, m.role]);
  assert.deepEqual(roles, [['ada', 'admin'], ['bob', 'admin'], ['cy', 'owner'], ['dee', 'member']]);
});

test('removeMember: managers remove others, anyone may leave, the last owner stays', () => {
  const { call, okBody, id } = team();
  assert.equal(call('removeMember', { userId: 'cy', params: { id, userId: 'dee' } }).status, 403);
  assert.equal(call('removeMember', { userId: 'bob', params: { id, userId: 'ada' } }).status, 403);
  assert.equal(call('removeMember', { userId: 'ada', params: { id, userId: 'eve' } }).status, 404);
  assert.equal(call('removeMember', { userId: 'eve', params: { id, userId: 'dee' } }).status, 403);

  assert.deepEqual(okBody(call('removeMember', { userId: 'bob', params: { id, userId: 'cy' } })), { unassignedTaskIds: [] });
  // a viewer may leave on their own
  assert.deepEqual(okBody(call('removeMember', { userId: 'dee', params: { id, userId: 'dee' } })), { unassignedTaskIds: [] });
  assert.equal(call('getProject', { userId: 'dee', params: { id } }).status, 403);

  const last = call('removeMember', { userId: 'ada', params: { id, userId: 'ada' } });
  assert.equal(last.status, 409);
  assert.deepEqual(last.body, { error: 'Project must keep at least one owner' });
  okBody<Member>(call('changeMemberRole', { userId: 'ada', params: { id, userId: 'bob' }, body: { role: 'owner' } }));
  okBody(call('removeMember', { userId: 'ada', params: { id, userId: 'ada' } }));
  const left = okBody<{ items: Member[] }>(call('listMembers', { userId: 'bob', params: { id } })).items;
  assert.deepEqual(left.map((m) => [m.userId, m.role]), [['bob', 'owner']]);
  // a removed user can be added again
  okBody<Member>(call('addMember', { userId: 'bob', params: { id }, body: { userId: 'ada', role: 'viewer' } }), 201);
});

test('tasks in a project: who may create, read and change them', () => {
  const { call, okBody, id, newTask } = team();
  const task = newTask('cy', 'Build the lander');
  assert.equal(task.projectId, id);
  assert.equal(task.title, 'Build the lander');
  for (const userId of ['ada', 'bob']) assert.equal(newTask(userId, `By ${userId}`).projectId, id);

  // viewers read but do not write; outsiders and anonymous callers do neither
  assert.equal(call('createTask', { userId: 'dee', body: { title: 'Nope', projectId: id } }).status, 403);
  assert.equal(call('createTask', { userId: 'eve', body: { title: 'Nope', projectId: id } }).status, 403);
  assert.equal(call('createTask', { body: { title: 'Nope', projectId: id } }).status, 401);
  const missing = call('createTask', { userId: 'cy', body: { title: 'Nope', projectId: 'project-99' } });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: 'Project not found: project-99' });
  assert.equal(call('createTask', { userId: 'cy', body: { title: '', projectId: id } }).status, 400);

  assert.deepEqual(okBody<Task>(call('getTask', { userId: 'dee', params: { id: task.id } })), task);
  assert.equal(call('getTask', { userId: 'eve', params: { id: task.id } }).status, 403);
  assert.equal(call('getTask', { params: { id: task.id } }).status, 401);

  assert.equal(call('updateStatus', { userId: 'dee', params: { id: task.id }, body: { status: 'in_progress' } }).status, 403);
  assert.equal(call('updateStatus', { userId: 'eve', params: { id: task.id }, body: { status: 'in_progress' } }).status, 403);
  assert.equal(call('updateStatus', { params: { id: task.id }, body: { status: 'in_progress' } }).status, 401);
  assert.equal(okBody<Task>(call('updateStatus', { userId: 'cy', params: { id: task.id }, body: { status: 'in_progress' } })).status, 'in_progress');
  // the transition rules still apply
  assert.equal(call('updateStatus', { userId: 'ada', params: { id: task.id }, body: { status: 'todo' } }).status, 200);
  assert.equal(call('updateStatus', { userId: 'ada', params: { id: task.id }, body: { status: 'done' } }).status, 409);
});

test('assigning a task in a project', () => {
  const { call, okBody, id, newTask } = team();
  const task = newTask('ada', 'Plan the mission');
  const assign = (userId: string | undefined, assignee: string | null) =>
    call('assignTask', { userId, params: { id: task.id }, body: { userId: assignee } });

  assert.equal(okBody<Task>(assign('cy', 'bob')).assigneeId, 'bob');
  assert.equal(okBody<Task>(assign('bob', 'cy')).assigneeId, 'cy');
  assert.equal(assign('dee', 'cy').status, 403);
  assert.equal(assign('eve', 'cy').status, 403);
  assert.equal(assign(undefined, 'cy').status, 401);

  // only non-viewer members of the project can be assigned
  const viewer = assign('ada', 'dee');
  assert.equal(viewer.status, 409);
  assert.deepEqual(viewer.body, { error: 'User cannot be assigned in project: dee' });
  assert.equal(assign('ada', 'eve').status, 409);
  assert.equal(assign('ada', 'ghost').status, 404);
  assert.equal(assign('ada', 'zed').status, 409);
  assert.equal(okBody<Task>(call('getTask', { userId: 'ada', params: { id: task.id } })).assigneeId, 'cy');
  assert.equal(okBody<Task>(assign('cy', null)).assigneeId, null);
  assert.equal(id, task.projectId);
});

test('removing a member unassigns their tasks in that project only', () => {
  const { call, okBody, id, newTask } = team();
  const other = okBody<Project>(call('createProject', { userId: 'cy', body: { name: 'Borealis' } }), 201);
  const a = newTask('ada', 'A');
  const b = newTask('ada', 'B');
  const c = newTask('ada', 'C');
  const elsewhere = okBody<Task>(call('createTask', { userId: 'cy', body: { title: 'Elsewhere', projectId: other.id } }), 201);
  const personal = okBody<Task>(call('createTask', { body: { title: 'Personal' } }), 201);
  for (const t of [a, c, elsewhere, personal]) {
    okBody<Task>(call('assignTask', { userId: 'cy', params: { id: t.id }, body: { userId: 'cy' } }));
  }
  okBody<Task>(call('assignTask', { userId: 'ada', params: { id: b.id }, body: { userId: 'bob' } }));
  const before = okBody<Task>(call('getTask', { userId: 'ada', params: { id: a.id } }));

  const removed = okBody<{ unassignedTaskIds: string[] }>(call('removeMember', { userId: 'ada', params: { id, userId: 'cy' } }));
  assert.deepEqual([...removed.unassignedTaskIds].sort(), [a.id, c.id].sort());

  const after = okBody<Task>(call('getTask', { userId: 'ada', params: { id: a.id } }));
  assert.equal(after.assigneeId, null);
  assert.ok(after.updatedAt > before.updatedAt);
  assert.equal(okBody<Task>(call('getTask', { userId: 'ada', params: { id: b.id } })).assigneeId, 'bob');
  assert.equal(okBody<Task>(call('getTask', { userId: 'cy', params: { id: elsewhere.id } })).assigneeId, 'cy');
  assert.equal(okBody<Task>(call('getTask', { params: { id: personal.id } })).assigneeId, 'cy');
  // cy lost access to the project's tasks
  assert.equal(call('getTask', { userId: 'cy', params: { id: a.id } }).status, 403);
});

test('listTasks shows project-less tasks and the tasks of the caller\'s projects', () => {
  const { call, okBody, id, newTask } = team();
  const other = okBody<Project>(call('createProject', { userId: 'eve', body: { name: 'Borealis' } }), 201);
  const p1 = okBody<Task>(call('createTask', { body: { title: 'Personal 1' } }), 201);
  const a = newTask('ada', 'Apollo 1');
  const e = okBody<Task>(call('createTask', { userId: 'eve', body: { title: 'Borealis 1', projectId: other.id } }), 201);
  const b = newTask('cy', 'Apollo 2');
  const p2 = okBody<Task>(call('createTask', { userId: 'eve', body: { title: 'Personal 2' } }), 201);
  assert.equal(p1.projectId, null);
  assert.equal(p2.projectId, null);

  const list = (userId?: string, projectId?: string): string[] =>
    okBody<{ items: Task[] }>(call('listTasks', { userId, query: projectId ? { projectId } : undefined })).items.map((t) => t.id);
  assert.deepEqual(list(), [p1.id, p2.id]);
  assert.deepEqual(list('dee'), [p1.id, a.id, b.id, p2.id]);
  assert.deepEqual(list('eve'), [p1.id, e.id, p2.id]);
  assert.deepEqual(list('ada', id), [a.id, b.id]);
  assert.deepEqual(list('eve', other.id), [e.id]);

  assert.equal(call('listTasks', { userId: 'eve', query: { projectId: id } }).status, 403);
  assert.equal(call('listTasks', { query: { projectId: id } }).status, 401);
  assert.equal(call('listTasks', { userId: 'ada', query: { projectId: 'project-99' } }).status, 404);

  // eve joins Apollo and sees its tasks too
  okBody<Member>(call('addMember', { userId: 'ada', params: { id }, body: { userId: 'eve', role: 'viewer' } }), 201);
  assert.deepEqual(list('eve'), [p1.id, a.id, e.id, b.id, p2.id]);
});

test('an archived project is read-only until it is unarchived', () => {
  const { call, okBody, id, newTask } = team();
  const task = newTask('cy', 'Before the archive');
  // only an owner archives
  for (const userId of ['bob', 'cy', 'dee', 'eve']) assert.equal(call('archiveProject', { userId, params: { id } }).status, 403);
  const archived = okBody<Project>(call('archiveProject', { userId: 'ada', params: { id } }));
  assert.equal(archived.archived, true);

  const expectArchived = (res: Res) => {
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: `Project is archived: ${id}` });
  };
  expectArchived(call('createTask', { userId: 'cy', body: { title: 'Late', projectId: id } }));
  expectArchived(call('updateStatus', { userId: 'cy', params: { id: task.id }, body: { status: 'in_progress' } }));
  expectArchived(call('assignTask', { userId: 'cy', params: { id: task.id }, body: { userId: 'cy' } }));
  expectArchived(call('updateProject', { userId: 'ada', params: { id }, body: { name: 'Artemis' } }));
  expectArchived(call('addMember', { userId: 'ada', params: { id }, body: { userId: 'eve', role: 'member' } }));
  expectArchived(call('changeMemberRole', { userId: 'ada', params: { id, userId: 'cy' }, body: { role: 'admin' } }));
  expectArchived(call('removeMember', { userId: 'ada', params: { id, userId: 'cy' } }));
  // a missing role still answers 403 before the archive is looked at
  assert.equal(call('createTask', { userId: 'dee', body: { title: 'Late', projectId: id } }).status, 403);

  // reading still works
  assert.equal(okBody<Project>(call('getProject', { userId: 'dee', params: { id } })).archived, true);
  assert.deepEqual(okBody<Task>(call('getTask', { userId: 'dee', params: { id: task.id } })), task);
  assert.equal(okBody<{ items: Member[] }>(call('listMembers', { userId: 'cy', params: { id } })).items.length, 4);
  assert.equal(okBody<{ items: Task[] }>(call('listTasks', { userId: 'cy', query: { projectId: id } })).items.length, 1);
  // archived projects drop out of the default project list
  assert.deepEqual(okBody<{ items: Project[] }>(call('listProjects', { userId: 'cy' })).items, []);
  assert.deepEqual(okBody<{ items: Project[] }>(call('listProjects', { userId: 'cy', query: { includeArchived: 'true' } })).items.map((p) => p.id), [id]);

  assert.equal(call('unarchiveProject', { userId: 'bob', params: { id } }).status, 403);
  assert.equal(okBody<Project>(call('unarchiveProject', { userId: 'ada', params: { id } })).archived, false);
  assert.equal(okBody<Task>(call('updateStatus', { userId: 'cy', params: { id: task.id }, body: { status: 'in_progress' } })).status, 'in_progress');
  assert.deepEqual(okBody<{ items: Project[] }>(call('listProjects', { userId: 'cy' })).items.map((p) => p.id), [id]);
});

test('tasks outside a project keep working without a caller', () => {
  const { app, call, okBody } = setup();
  const task = okBody<Task>(call('createTask', { body: { title: 'Solo' } }), 201);
  assert.equal(task.projectId, null);
  assert.equal(okBody<Task>(call('assignTask', { params: { id: task.id }, body: { userId: 'eve' } })).assigneeId, 'eve');
  assert.equal(okBody<Task>(call('updateStatus', { params: { id: task.id }, body: { status: 'in_progress' } })).status, 'in_progress');
  assert.equal(okBody<Task>(call('getTask', { params: { id: task.id } })).id, task.id);
  assert.equal(call('createTask', { userId: 'ada', body: { title: 'Bad', projectId: 7 } }).status, 400);
  // the service keeps its old call shapes
  const direct = app.service.createTask({ title: 'Direct' });
  assert.equal((direct as unknown as Task).projectId, null);
  assert.equal(app.service.listTasks().length, 2);
  assert.equal(app.service.getTask(direct.id).title, 'Direct');
});

test('the new errors are exported and carry their status', () => {
  const { ForbiddenError, UnauthorizedError, AppError } = taskboard as unknown as Record<string, new (...args: string[]) => Error & { status: number }>;
  assert.equal(typeof ForbiddenError, 'function');
  assert.equal(typeof UnauthorizedError, 'function');
  const forbidden = new ForbiddenError!('no');
  assert.ok(forbidden instanceof AppError!);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.message, 'no');
  const unauthorized = new UnauthorizedError!('Authentication required');
  assert.ok(unauthorized instanceof AppError!);
  assert.equal(unauthorized.status, 401);
});
