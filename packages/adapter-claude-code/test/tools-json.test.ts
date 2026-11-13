import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerToolList, ROUTER_TOOL_NAMES } from '@do-it-all-claude-code/core';

const toolsJson = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin', 'mcp', 'tools.json');

test('plugin/mcp/tools.json is the current output of core routerToolList() (run scripts/sync-tools-json.ts if this fails)', () => {
  const onDisk = JSON.parse(fs.readFileSync(toolsJson, 'utf8')) as unknown;
  assert.deepEqual(onDisk, routerToolList());
});

test('tools.json lists exactly the five router tool names', () => {
  const onDisk = JSON.parse(fs.readFileSync(toolsJson, 'utf8')) as Array<{ name: string }>;
  assert.deepEqual(onDisk.map(t => t.name).sort(), [...ROUTER_TOOL_NAMES].sort());
});
