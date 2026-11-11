import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition } from '../src/index.ts';

test('transition table', () => {
  assert.equal(canTransition('todo', 'in_progress'), true);
  assert.equal(canTransition('in_progress', 'done'), true);
  assert.equal(canTransition('todo', 'done'), false);
  assert.equal(canTransition('cancelled', 'todo'), false);
});
