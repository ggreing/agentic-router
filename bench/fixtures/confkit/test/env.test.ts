import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromEnv, getPath } from '../src/index.ts';

test('fromEnv maps prefixed variables to nested keys', () => {
  const layer = fromEnv(
    { APP_PORT: '8080', APP_DB__HOST: 'db', APP_DB__POOL__MAX: '10', HOME: '/root', APP_: 'x' },
    'APP_',
  );
  assert.deepEqual(layer, { port: '8080', db: { host: 'db', pool: { max: '10' } } });
  assert.equal(getPath(layer, 'db.pool.max'), '10');
  assert.equal(getPath(layer, 'db.missing'), undefined);
});
