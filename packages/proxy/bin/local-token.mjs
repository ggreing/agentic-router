#!/usr/bin/env node
// Claude Code's apiKeyHelper in API-key mode (decision 130): prints the local proxy token, and nothing else
// (Claude Code rejects a helper that prints anything besides the credential). The real API key never
// reaches Claude Code; the token is read from <router home>/proxy-token (0600), never from settings.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const v = process.env.AGENTIC_ROUTER_HOME;
const home = v && path.isAbsolute(v) ? v : path.join(os.homedir(), '.agentic-router');
try {
  const token = fs.readFileSync(path.join(home, 'proxy-token'), 'utf8').trim();
  if (!token) throw new Error('empty');
  process.stdout.write(token);
} catch {
  process.stderr.write('agentic-router: no local proxy token (run agentic-router init --mode api)\n');
  process.exit(1);
}
