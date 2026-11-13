# The daemon's socket against a second user

On macOS and Linux the daemon listens on a Unix socket in a folder only you can enter, and its clients use
that socket and nothing else (see SECURITY.md, "Shared machines"). The unit tests cover the logic with one
user. This script checks the claim against a real second account. Linux only.

**It needs root**, for one thing: to create a throwaway account (`diacc-sock-<random>`, no login, no home)
and to remove it again when it ends, also when a check fails or you interrupt it. Nothing else on the system
is changed. No network, no API calls. Your own router home is not read or changed: the daemon runs in a
temporary home under `/tmp`.

## Run

```
sudo scripts/socket-multiuser/run.sh --user <your account> [--repo <checkout>] [--node <dir holding bin/node>]
```

`--user` is the account "our side" runs as (default: the one that called sudo). It needs Node 24.5 or later
(`--node` when it is not on root's PATH), `npm ci` done in the checkout, and the checkout readable by that
account. `python3` is needed for the other user's probe. In WSL, where sudo asks for a password:
`wsl -d <distro> -u root -- bash <checkout>/scripts/socket-multiuser/run.sh --user <you> ...`.

It prints one line per check, `met` or `NOT MET`, and exits 1 when any is not met.

## What it checks

Everything sits under `/tmp`, which anyone may enter, so only the router home's own mode stands between the
two users. The home is created open (0755) on purpose: the daemon must close it.

With our daemon running, the other user must get `EACCES` when it tries to

1. connect to our `daemon.sock`;
2. read `endpoint.json` or the token;
3. list or enter the home, or a folder inside it.

With our daemon stopped:

4. it cannot create a socket at our path;
5. it can bind our TCP port, and then receives nothing: our hook relay, status line and CLI know the daemon
   by the socket named in `endpoint.json`, treat it as down, and never try the port. The listener records
   every byte; the check is that it saw no connection, and neither the token nor the prompt. A request sent
   on purpose afterwards shows the listener does record.

The fallback folder (a home whose path is too long for a socket, so the socket goes into a folder of ours
under `$XDG_RUNTIME_DIR` or the temp folder):

6. the other user cannot connect to that socket, list the folder or create a socket in it;
7. when the other user creates that folder first (open to everyone), or puts a link there, our daemon
   refuses it, names no socket, writes nothing into it, says so in its log, and still answers its own
   clients on the local port with sealed messages.

## Files

- `run.sh`: both sides, the checks, the clean-up.
- `probe.py`: what the second user tries; prints `OK` or the errno name.
