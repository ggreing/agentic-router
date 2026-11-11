import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, TextkitError } from '../src/index.ts';

test('missing value error message is spelled correctly', () => {
  assert.throws(() => interpolate('Hi {{name}}', {}), {
    name: 'TextkitError',
    message: 'Missing value for placeholder "name"',
  });
});

test('message uses the actual placeholder name', () => {
  assert.throws(
    () => interpolate('Order {{ order_id }} for {{customer}}', { customer: 'Ada' }),
    (err: unknown) => err instanceof TextkitError && err.message === 'Missing value for placeholder "order_id"',
  );
});

test('other interpolate behaviour is unchanged', () => {
  assert.equal(interpolate('Hi {{name}}', { name: 'Ada' }), 'Hi Ada');
  assert.equal(interpolate('Hi {{name}}', {}, { strict: false }), 'Hi {{name}}');
});
