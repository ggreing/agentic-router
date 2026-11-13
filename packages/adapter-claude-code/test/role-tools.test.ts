import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoleFile, FORBIDDEN_ROLE_TOOLS } from '@do-it-all-claude-code/core';

// plugin/agents/*.md are authored outside this package; this test validates them as they appear.
const agentsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin', 'agents');
const ROLES = ['architect', 'ui-designer', 'coder', 'reviewer', 'tester'];

function roleFiles(): string[] {
  if (!fs.existsSync(agentsDir)) return [];
  return fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).map(f => path.join(agentsDir, f));
}

test('every role file parses, names a tool list, and omits Agent/Task/WebFetch/WebSearch', () => {
  const files = roleFiles();
  if (files.length === 0) {
    assert.ok(true, 'no plugin/agents/*.md yet — nothing to check (authored outside this package)');
    return;
  }
  for (const f of files) {
    const role = parseRoleFile(fs.readFileSync(f, 'utf8'));
    const base = path.basename(f);
    assert.ok(role.tools.length > 0, `${base}: tools must be declared (spec 3.3, decision 58)`);
    for (const forbidden of FORBIDDEN_ROLE_TOOLS)
      assert.ok(!role.tools.includes(forbidden), `${base}: must not grant ${forbidden}`);
    assert.ok(role.role && ROLES.includes(role.role), `${base}: x-router.role must be one of ${ROLES.join(', ')}`);
    for (const v of role.verify)
      assert.ok(typeof v === 'string' || (v && typeof v === 'object' && typeof (v as { command?: unknown }).command === 'string'),
        `${base}: each x-router.verify entry is a string or { command }`);
  }
});

test('no role grants an mcp__ tool, and each disallows the router tools (decision 127)', () => {
  const files = roleFiles();
  if (files.length === 0) { assert.ok(true, 'no role files yet'); return; }
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const role = parseRoleFile(text);
    const base = path.basename(f);
    for (const t of role.tools)
      assert.ok(!t.startsWith('mcp__'), `${base}: must not grant an MCP tool (${t})`);
    assert.match(text, /^disallowedTools:\s*mcp__plugin_do-it-all-claude-code_router__\*/m, `${base}: must disallow the router MCP tools`);
  }
});

test('once all five role files exist, each router role is covered exactly once', () => {
  const files = roleFiles();
  if (files.length < ROLES.length) {
    assert.ok(true, `only ${files.length}/${ROLES.length} role files so far — skipping completeness check`);
    return;
  }
  const roles = files.map(f => parseRoleFile(fs.readFileSync(f, 'utf8')).role);
  for (const r of ROLES) assert.equal(roles.filter(x => x === r).length, 1, `exactly one ${r} role file`);
});
