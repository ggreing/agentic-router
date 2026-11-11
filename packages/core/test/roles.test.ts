import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORBIDDEN_ROLE_TOOLS, parseRoleFile } from '@agentic-router/core';

const sample = `---
name: coder
description: Implements a subtask spec.
tools: Read, Edit, Write, Bash, Grep, Glob
model: haiku
effort: low
isolation: worktree
maxTurns: 40
x-router:
  role: coder
  verify:
    - npm run build
    - { command: "npm test", kind: test, timeoutMs: 120000 }
---
## Responsibilities
- Edit only inside the allowed paths.
`;

test('role file: standard keys, x-router role and verify (block and flow entries)', () => {
  const r = parseRoleFile(sample);
  assert.equal(r.name, 'coder');
  assert.deepEqual(r.tools, ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);
  assert.equal(r.role, 'coder');
  assert.equal(r.verify.length, 2);
  assert.deepEqual(r.verify[1], { command: 'npm test', kind: 'test', timeoutMs: 120000 });
  assert.match(r.body, /Responsibilities/);
  assert.ok(!r.tools.some(t => FORBIDDEN_ROLE_TOOLS.includes(t)));
});

test('verify steps can be conditional on a repo-relative file; escaping paths are rejected', () => {
  const ok = parseRoleFile(sample.replace('- npm run build', '- { command: "npm run build --if-present", kind: build, ifExists: package.json }'));
  assert.deepEqual(ok.verify[0], { command: 'npm run build --if-present', kind: 'build', ifExists: 'package.json' });
  for (const bad of ['../package.json', '/etc/passwd', 'C:/x', 'a/../../b'])
    assert.throws(() => parseRoleFile(sample.replace('- npm run build', `- { command: "x", ifExists: "${bad}" }`)));
});

test('role file without front matter is rejected', () => {
  assert.throws(() => parseRoleFile('# just markdown'));
});

test('CRLF files parse too', () => {
  assert.equal(parseRoleFile(sample.replace(/\n/g, '\r\n')).verify.length, 2);
});

test('ifMissing makes a step run only while a path is absent; escaping paths are rejected (decision 86)', () => {
  const ok = parseRoleFile(sample.replace('- npm run build', '- { command: "npm ci", kind: build, ifExists: package-lock.json, ifMissing: node_modules }'));
  assert.deepEqual(ok.verify[0], { command: 'npm ci', kind: 'build', ifExists: 'package-lock.json', ifMissing: 'node_modules' });
  for (const bad of ['../node_modules', '/abs', 'D:/x'])
    assert.throws(() => parseRoleFile(sample.replace('- npm run build', `- { command: "x", ifMissing: "${bad}" }`)));
});

test('ifAnyExists lists repo-relative paths; escaping paths are rejected (decision 122)', () => {
  const ok = parseRoleFile(sample.replace('- npm run build', '- { command: "python -m pytest -q -x {relatedTests}", kind: test, ifAnyExists: [pytest.ini, pyproject.toml, setup.cfg, tox.ini, conftest.py] }'));
  assert.deepEqual(ok.verify[0], { command: 'python -m pytest -q -x {relatedTests}', kind: 'test', ifAnyExists: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'] });
  assert.throws(() => parseRoleFile(sample.replace('- npm run build', '- { command: "x", ifAnyExists: ["../a"] }')));
  assert.throws(() => parseRoleFile(sample.replace('- npm run build', '- { command: "x", ifAnyExists: [] }')));
});
