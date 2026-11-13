# Do It All Claude Code 0.4.0

The main thing in this release is that Do It All Claude Code can now tell you when a newer version is out.
It also finishes two changes that earlier releases started.

**Update check, if you want it.** `do-it-all-claude-code init` asks whether to check GitHub once a day for a
newer release. Press Enter for yes. If you upgrade an existing install, it stays off until you run
`do-it-all-claude-code update on`, and `doctor` suggests that. `update check` looks right away, whatever the
setting.

When a newer version is out, you see it in the status line and in a one-line note when a session starts.
The note is shown only to you and is never sent to the model, at most once a day per version. Nothing
updates itself.

The check reads GitHub's public release list. GitHub sees an ordinary web request from your machine (your IP
address and a generic client name); nothing else is sent. It follows your `HTTPS_PROXY`/`NO_PROXY` settings,
and it skips the check rather than go around a proxy setting it can't use. This is the one network call the
router makes on its own, and it only happens if you turned the check on.

**The old token route is off.** Since 0.2.0 the router's own programs seal every message to the daemon
instead of sending its token. The daemon no longer accepts the token sent in the clear unless you set
`bearerApi` to `on`. That switch still works in this release, but it's deprecated, and `doctor` warns while it
is on.

**`.agentic-router/` is no longer read.** If a project still has the folder from before the rename, rename
it to `.do-it-all-claude-code/`. `doctor` and `policy show` point it out, and a policy you had accepted counts
again after the rename.

We also checked the daemon's socket against a second user on the same machine (in WSL): that user could not
connect to the socket, read the router folder or token, or stand in for the daemon while it was stopped, and
our hooks never sent anything to a program holding the daemon's port.

Upgrading:

```
node packages/cli/src/index.ts stop
git pull
npm ci
npm run build:dashboard
node packages/cli/src/index.ts init
node packages/cli/src/index.ts start
```

Then restart your Claude Code sessions. Coming from 0.2.0 or earlier, `init` also moves your old install to
the new name, as described in the 0.3.0 notes.

The full list is in `CHANGELOG.md`. Security issues: please report them privately through GitHub (see
SECURITY.md).
