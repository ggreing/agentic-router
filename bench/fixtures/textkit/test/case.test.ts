import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelCase, kebabCase, pascalCase, snakeCase, splitWords, titleCase } from '../src/index.ts';

test('splitWords understands common identifier styles', () => {
  assert.deepEqual(splitWords('parseHTTPResponse'), ['parse', 'http', 'response']);
  assert.deepEqual(splitWords('user_id'), ['user', 'id']);
  assert.deepEqual(splitWords('Content-Type'), ['content', 'type']);
});

test('case converters', () => {
  assert.equal(camelCase('hello world'), 'helloWorld');
  assert.equal(pascalCase('hello-world'), 'HelloWorld');
  assert.equal(snakeCase('helloWorld'), 'hello_world');
  assert.equal(kebabCase('Hello World'), 'hello-world');
  assert.equal(titleCase('hello_world'), 'Hello World');
});

test('case converters handle empty input', () => {
  assert.equal(camelCase(''), '');
  assert.equal(snakeCase('   '), '');
});
