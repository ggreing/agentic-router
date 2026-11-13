// Regenerates plugin/mcp/tools.json from core's routerToolList() (the dependency-free MCP server cannot
// import core, so it ships the generated JSON). Run after changing packages/core/src/tools.ts:
//   node packages/adapter-claude-code/scripts/sync-tools-json.ts
// tools-json.test.ts fails when the committed file is stale, the same pattern as the relay's secret
// patterns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerToolList } from '@do-it-all-claude-code/core';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin', 'mcp', 'tools.json');
fs.writeFileSync(out, JSON.stringify(routerToolList(), null, 2) + '\n');
console.log(`wrote ${out}`);
