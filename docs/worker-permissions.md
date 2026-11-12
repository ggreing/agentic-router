# Permissions for router workers

Router workers are the subagents the lead dispatches: coder, tester, reviewer, architect, ui-designer.
They use Claude Code's normal tools. The router puts a guard in front of those tools, and for each call
the guard does one of three things:

- **Refuses** it: a write outside the subtask's scope, anything touching a credential file or the
  router's own folder, a command or option that isn't on the worker allowlist. Nothing you allow can
  override a refusal.
- **Allows** it without a prompt: reading or searching named files inside the repository, and editing
  files inside the subtask's scope.
- **Stays out of it**: every Bash command it didn't refuse. Claude Code's own permission rules decide,
  exactly as they would without the router.

## Bash goes through your rules, not the guard's

The guard reads command lines. It doesn't sandbox anything, so it never approves a Bash command on your
behalf. A worker running `npm test` is treated like any other Bash command in Claude Code: it runs if one
of your rules allows it, and otherwise you get asked. Under `claude -p` there's nobody to ask, so it's
declined.

To let workers build and test without prompts:

```
claude --allowedTools "Bash(npm test)" "Bash(npm run *)"
```

or in `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Bash(npm test)", "Bash(npm run *)"] } }
```

Use `"Bash(npm run build)"` instead of `"Bash(npm run *)"` if you only want one script. Other toolchains
work the same way: allow their test and build commands.

A few things worth knowing before you add rules:

Claude Code splits a command on `&&`, `||`, `;` and `|` and checks each part, so `Bash(npm test)` doesn't
cover `make && npm test`. A `cd` into a directory inside the working tree is read-only and needs no rule,
so `cd packages/web && npm test` only needs the `npm test` rule.

Rules are session-wide. They apply to the lead and to every worker, not just router workers.

Allowing a command that runs code means vouching for that code. A test file or a package script is a
program, and once allowed it runs as you, with your file access. The router does refuse package scripts
and installs while `scripts` in `package.json` differ from the last commit, until you or the lead confirm,
but it doesn't look at what a test actually does.

A refusal wins over your allow rules. With `"Bash(npm run *)"` allowed, `npm run env` (which prints the
environment) is still refused, and with `"Bash(cat *)"` allowed, `cat .env` still is.

## What workers can't do, whatever you allow

They can't write outside their subtask's paths (`[scope: ...]`), or to CI configuration, `.claude/`,
`.git/`, `.mcp.json`, `.husky/`, `CLAUDE.md` and other files that change how the repository or the agent
runs. They can't read, search for or list credential files (`.env`, `.npmrc`, `~/.ssh`, `~/.aws`, the macOS
keychains, desktop keyrings, ...) or the router's folder (`~/.agentic-router`), under any name the same
directory has (a home reached through a link counts as the home); `.env.example` and other templates are fine. They can't run
commands outside the worker allowlist (network tools, shells, interpreters with inline code), print the
environment or reference secret-looking variables, use shell syntax the guard can't follow (`$'...'`,
`${VAR}`, command substitution, comments, redirection to files), install packages from anywhere but the
registry, or use PowerShell.

The guard reads words the way Bash does, so `cat .en""v` counts as `cat .env`, and a value glued to a
short option counts as a path (`grep -f.env` is refused like `grep -f .env`).

## Refusals that can surprise an honest worker

The refusal message says what to do instead. The common ones:

| Refused | Use instead |
|---|---|
| `rg --hidden`, `rg --no-ignore` | `rg` without them, or name the files |
| `git diff --no-index` | `git diff` on tracked files, or `diff` |
| `printf -v`, `echo ${VAR}` | plain `printf` / `echo $VAR` (non-secret names) |
| a comment inside a command | drop the comment |
| `npm install user/repo` | a registry name; ask the lead for anything else |
| `git commit` with no message on the command line | `git commit -m "..."` (or `-F <file>`, `-C <commit>`) |
| `git commit --amend`, `-e`, `--reset-author` | a new commit; the lead or user amends |
| `git add -p`, `-i`, `-e` | `git add <files>` |
| `git add -A` / `.` / `<dir>` with an un-ignored credential file below | add files by name, or put the file in `.gitignore` |
| `git branch` beyond `--show-current`; `git stash list --output`/`--ext-diff` | ask the lead |
| `tail -f`, `tail --follow` | `tail -n <N>` |
| global or out-of-project installs (`npm install -g`, `--prefix`, `pip install --user`, ...) | install into the project |
| a build/test/install command writing into `.git`, CI config, `.claude` or the router policy | point the output elsewhere |
| a path under `/proc` or `/dev` (except `/dev/null` and the std streams) | the file's ordinary path |
| on Windows, an 8.3 short name (`PROGRA~1`), an NTFS stream (`file:name`), a UNC or `\\?\` path, or a name ending in a dot or space | the full long path; a short name is fine only where it is part of the session's own working directory, home or temp folder |
| a brace expansion over 64 results, or a command line over 20,000 characters | split the command |
| a recursive grep over a directory with an un-ignored credential file | `rg`, the Grep tool, or name the files |
| a Bash search whose pattern is exactly a credential file name (`grep ".env" ...`) | the Grep tool, or a longer pattern like `process.env` |

## Project policy

A repository can add commands to the worker allowlist in `.agentic-router/policy.json` (`bashAllow`) and
name environment variables to pass to verification (`verifyEnv`). The file does nothing until you accept
it:

```
agentic-router policy show
agentic-router policy accept
```

Acceptance is tied to the file's content. If it changes, say after a `git pull`, it's ignored again until
you accept the new version. `agentic-router doctor` shows where things stand.

## Workers need the daemon

A worker can only write once the router has a scope record for it, and the daemon writes that record when
the lead dispatches the worker. If the daemon isn't running, router workers can read but not edit.
`agentic-router status` tells you whether it's up.

See [SECURITY.md](../SECURITY.md) for what the guard can't protect against.
