import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionQueue } from '../src/queue.ts';

test('tasks of one session run one at a time in arrival order', async () => {
  const q = new SessionQueue();
  const log: string[] = [];
  let running = 0;
  const task = (name: string, ms: number) => q.run('s1', async () => {
    running++;
    assert.equal(running, 1, 'two tasks of the same session overlapped');
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    running--;
    return name;
  });
  const results = await Promise.all([task('a', 30), task('b', 5), task('c', 1)]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('different sessions run concurrently', async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  await Promise.all([
    q.run('slow', async () => { await sleep(40); order.push('slow'); }),
    q.run('fast', async () => { await sleep(1); order.push('fast'); }),
  ]);
  assert.deepEqual(order, ['fast', 'slow']);
});

test('a failing task does not stop the queue and the error reaches its caller', async () => {
  const q = new SessionQueue();
  const failed = q.run('s', () => { throw new Error('boom'); });
  const next = q.run('s', () => 'next');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'next');
});

test('read-modify-write through the queue loses no update', async () => {
  const q = new SessionQueue();
  let counter = 0;
  await Promise.all(Array.from({ length: 50 }, () => q.run('s', async () => {
    const v = counter;
    await sleep(0);
    counter = v + 1;
  })));
  assert.equal(counter, 50);
  await q.drain();
  assert.equal(q.size, 0);
});
