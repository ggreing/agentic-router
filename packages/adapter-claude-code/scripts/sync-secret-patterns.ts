// Regenerates plugin/hooks/secret-patterns.json from core's SECRET_PATTERN_SPECS (audit A5). The relay is
// dependency-free, so it ships the generated JSON and loads it at runtime. Run after changing the pattern
// list in packages/core/src/security.ts:
//   node packages/adapter-claude-code/scripts/sync-secret-patterns.ts
// secret-patterns-json.test.ts fails when the committed file is stale (same pattern as tools.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECRET_PATTERN_SPECS } from '@agentic-router/core';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin', 'hooks', 'secret-patterns.json');
fs.writeFileSync(out, JSON.stringify(SECRET_PATTERN_SPECS, null, 2) + '\n');
console.log(`wrote ${out} (${SECRET_PATTERN_SPECS.length} patterns)`);
