# Do It All Claude Code 0.3.0

This release is the project's new name, and nothing else changes in how it works. Agentic Router Proxy is
now **Do It All Claude Code**. The command, the package and everything the tool creates on your machine
carry the new name:

- the CLI and its package: `do-it-all-claude-code`
- the router folder: `~/.do-it-all-claude-code`
- the per-project folder: `.do-it-all-claude-code/`
- environment variables: `DO_IT_ALL_CLAUDE_CODE_...`
- the subagents in Claude Code: `do-it-all-claude-code:coder` and so on

The repository moved to https://github.com/ggreing/do-it-all-claude-code. The old address still redirects
there.

A version for Codex is planned as a separate project, Do It All Codex.

Upgrading from 0.1.0 or 0.2.0:

```
node packages/cli/src/index.ts stop
git remote set-url origin https://github.com/ggreing/do-it-all-claude-code
git pull
npm ci
npm run build:dashboard
node packages/cli/src/index.ts init
node packages/cli/src/index.ts start
```

Stop with the old checkout's CLI before you pull. When `init` finds your old install, it shows what it
will change, including which processes it will stop, and asks before doing anything. It then moves your
router folder (history, tokens, certificate and settings), updates the router's own entries in Claude
Code's settings after making a backup, and moves your API key in the system keychain to the new name. On
macOS you paste the key once when it asks. Your other Claude Code settings are left alone.

It refuses to move a folder that is a link, isn't yours, or doesn't look like a router folder, and it won't
stop a process it can't confirm is the old router. In both cases it changes nothing and tells you why.

Restart your Claude Code sessions afterwards. A project that still has an `.agentic-router/` folder keeps
working for this release, and `do-it-all-claude-code doctor` will remind you to rename it.

The full list is in `CHANGELOG.md`. Security issues: please report them privately through GitHub (see
SECURITY.md).
