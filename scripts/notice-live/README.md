# notice-live

A live check for decision 163: the update notice at session start must reach the user and never the model.

The router hands a newer release to Claude Code as a SessionStart hook's `systemMessage`, and a restored team state
as `additionalContext`. The hooks reference describes `systemMessage` as a message shown to the user, and says an
async hook's `systemMessage` goes to Claude instead. It does not say outright that a synchronous hook's never does,
so this script checks it with a real Claude Code.

```
node scripts/notice-live/run.mjs              # one `claude -p` run
node scripts/notice-live/run.mjs --selftest   # no claude: checks the script's own plumbing
```

Options: `--keep` (keep the temp folder), `--timeout=<seconds>` (default 120). `CLAUDE_BIN=<path>` picks the binary.

What it does:

- A plugin of its own in a temp folder, with one synchronous SessionStart hook. The hook prints what the adapter
  renders for a session start with both a context and a notice, each carrying a random marker.
- A fresh temp config dir (no login), with `ANTHROPIC_BASE_URL` set to a fake Messages API on 127.0.0.1. The fake
  accepts only the dummy key of `scripts/tls-live/dummy-key.mjs` and records every request body.
- One `claude -p` run with that plugin.

| Result | Meaning |
|---|---|
| `met` | The context's marker is in a request to the model, and the notice's marker is in none |
| `NOT met`, `noticeReachedModel: true` | Claude Code sent the notice to the model |
| `NOT met`, `contextReachedModel: false` | The hook did not run or its output did not arrive, so nothing was shown |

`noticeInOutput` says whether the notice appeared in Claude Code's output (print mode may not show it).

No API call is made and nothing is billed. Your own `~/.claude` and `~/.do-it-all-claude-code` are not read or
changed.
