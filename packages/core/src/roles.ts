// Role (.md subagent) file parsing (decision 64).
// Claude Code reads the standard front matter keys; the router reads `x-router`.
import fs from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Role } from './types.ts';

// A verify step. `ifExists` (repo-relative path) makes the step conditional: when the file is
// absent the step is skipped and recorded as ok/skipped (decision 70), e.g. npm steps in a
// Python repository, or an install step that only applies when a lockfile exists.
// `ifMissing` is the reverse: the step runs only while the path is absent (decision 86), e.g.
// `npm ci` only in a fresh worktree without node_modules, never over the user's installed tree.
const repoRelative = (name: string) => z.string().min(1)
  .refine(p => !/^([/\\]|[A-Za-z]:)|(^|[/\\])\.\.([/\\]|$)/.test(p), `${name} must be a repo-relative path inside the repository`);
const verifyEntry = z.union([z.string().min(1), z.object({
  command: z.string().min(1),
  kind: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  ifExists: repoRelative('ifExists').optional(),
  ifMissing: repoRelative('ifMissing').optional(),
})]);

const frontMatter = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tools: z.union([z.string(), z.array(z.string())]).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  isolation: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  'x-router': z.object({
    role: z.enum(['architect', 'ui-designer', 'coder', 'reviewer', 'tester']).optional(),
    verify: z.array(verifyEntry).optional(),
  }).passthrough().optional(),
}).passthrough();

export type VerifyEntry = z.infer<typeof verifyEntry>;

export interface RoleFile {
  name: string;
  description?: string;
  tools: string[];
  model?: string;
  effort?: string;
  isolation?: string;
  maxTurns?: number;
  role?: Role;
  verify: VerifyEntry[];
  body: string;
}

/** Parses a subagent .md file. Throws if the front matter is missing or invalid. */
export function parseRoleFile(text: string): RoleFile {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('role file has no YAML front matter');
  const fm = frontMatter.parse(parse(m[1]!) ?? {});
  const tools = Array.isArray(fm.tools) ? fm.tools : (fm.tools ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const xr = fm['x-router'];
  return {
    name: fm.name, ...(fm.description !== undefined ? { description: fm.description } : {}), tools,
    ...(fm.model !== undefined ? { model: fm.model } : {}), ...(fm.effort !== undefined ? { effort: fm.effort } : {}),
    ...(fm.isolation !== undefined ? { isolation: fm.isolation } : {}), ...(fm.maxTurns !== undefined ? { maxTurns: fm.maxTurns } : {}),
    ...(xr?.role ? { role: xr.role } : {}), verify: xr?.verify ?? [], body: m[2] ?? '',
  };
}

export function readRoleFile(file: string): RoleFile {
  return parseRoleFile(fs.readFileSync(file, 'utf8'));
}

/** Tools a router role must never have (decisions 34, 58): no nested subagents, no web egress. */
export const FORBIDDEN_ROLE_TOOLS = ['Agent', 'Task', 'WebFetch', 'WebSearch'];
