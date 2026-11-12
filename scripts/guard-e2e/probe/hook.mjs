#!/usr/bin/env node
// Logging hook for the guard end-to-end check: records the shape of each hook input and prints nothing,
// so it never takes part in a permission decision.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.E2E_LOG_DIR;
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  try {
    const i = JSON.parse(raw);
    const input = i.tool_input && typeof i.tool_input === 'object' ? i.tool_input : {};
    const entry = {
      at: new Date().toISOString(), event: process.argv[2] ?? i.hook_event_name, keys: Object.keys(i).sort(),
      tool_name: i.tool_name ?? null, tool_use_id: i.tool_use_id ?? null, session_id: i.session_id ?? null,
      agent_id: i.agent_id ?? null, agent_type: i.agent_type ?? null, cwd: i.cwd ?? null, permission_mode: i.permission_mode ?? null,
      hasTranscriptPath: typeof i.transcript_path === 'string', hasAgentTranscriptPath: typeof i.agent_transcript_path === 'string',
      inputKeys: Object.keys(input).sort(),
      command: typeof input.command === 'string' ? input.command.slice(0, 200) : undefined,
      file_path: typeof input.file_path === 'string' ? input.file_path : undefined,
      path: typeof input.path === 'string' ? input.path : undefined,
      envProjectDir: process.env.CLAUDE_PROJECT_DIR ?? null, envRouterHome: process.env.AGENTIC_ROUTER_HOME ?? null,
    };
    if (dir) fs.appendFileSync(path.join(dir, 'probe.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* never interfere */ }
});
