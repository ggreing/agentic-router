#!/usr/bin/env node
// Claude Code's apiKeyHelper in direct mode (`agentic-router mode direct`, spec 5.4): with the proxy down,
// Claude Code talks to the API itself and gets the key from the OS keychain through this helper. It prints
// the key only (no newline, no banner); nothing is written to a file or an environment variable.
import { readKey } from '../src/vault.ts';

try {
  process.stdout.write(await readKey());
} catch (e) {
  process.stderr.write(`agentic-router: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
