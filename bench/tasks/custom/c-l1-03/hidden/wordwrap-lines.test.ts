import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextkitError, wordWrap } from '../src/index.ts';

type Wrap = (text: string, width: number, options?: { breakLongWords?: boolean }) => string;
const wrap = wordWrap as Wrap;

test('existing line breaks and blank lines are preserved', () => {
  assert.equal(wrap('aaa bbb\n\nccc ddd', 3), 'aaa\nbbb\n\nccc\nddd');
  assert.equal(wrap('the quick brown\nfox', 10), 'the quick\nbrown\nfox');
});

test('whitespace-only lines become empty lines', () => {
  assert.equal(wrap('a\n   \nb', 5), 'a\n\nb');
  assert.equal(wrap('  one   two  \nthree', 20), 'one two\nthree');
});

test('breakLongWords splits words into width-sized pieces', () => {
  assert.equal(wrap('abcdefghij', 4, { breakLongWords: true }), 'abcd\nefgh\nij');
  assert.equal(wrap('xy abcdefgh', 4, { breakLongWords: true }), 'xy\nabcd\nefgh');
});

test('the last piece shares a line with the next word when it fits', () => {
  assert.equal(wrap('abcdefg hi', 5, { breakLongWords: true }), 'abcde\nfg hi');
});

test('long words stay whole by default', () => {
  assert.equal(wrap('a supercalifragilistic b', 5), 'a\nsupercalifragilistic\nb');
  assert.equal(wrap('a supercalifragilistic b', 5, { breakLongWords: false }), 'a\nsupercalifragilistic\nb');
});

test('empty input and width validation', () => {
  assert.equal(wrap('', 10), '');
  assert.throws(() => wrap('abc', 0), TextkitError);
});
