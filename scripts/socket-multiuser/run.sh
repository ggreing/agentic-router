#!/usr/bin/env bash
# The daemon's Unix socket against a real second user (decision 164). Linux only; run as root:
#
#   sudo scripts/socket-multiuser/run.sh --user <you> [--repo <checkout>] [--node <dir holding bin/node>]
#
# Root is needed for one thing: to create a throwaway second account and remove it again (always, also when a
# check fails). "Our side" (the daemon and its clients) runs as --user in a temporary router home; "the other
# user" runs probe.py. No network, no API calls; your own router home is not read or changed.
# One line per check: "met" or "NOT MET". Exit code 1 when any check is not met.
set -u

US=""; REPO=""; NODE_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --user) US="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --node) NODE_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = "Linux" ] || { echo "Linux only" >&2; exit 2; }
[ "$(id -u)" = "0" ] || { echo "run as root (it creates and removes a throwaway account)" >&2; exit 2; }
US="${US:-${SUDO_USER:-}}"
[ -n "$US" ] && [ "$US" != "root" ] && id "$US" >/dev/null 2>&1 || { echo "--user <an ordinary account> is needed" >&2; exit 2; }
REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
[ -f "$REPO/packages/daemon/src/main.ts" ] || { echo "not a checkout: $REPO" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is needed (the other user's probe)" >&2; exit 2; }
NODE_BIN="${NODE_DIR:+$NODE_DIR/bin/}node"
US_UID="$(id -u "$US")"

THEM="diacc-sock-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BASE=""; SHARED=""; FAILED=0; PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  if id "$THEM" >/dev/null 2>&1; then
    pkill -KILL -u "$THEM" 2>/dev/null
    sleep 0.3
    userdel -r "$THEM" >/dev/null 2>&1 || userdel "$THEM" >/dev/null 2>&1
    id "$THEM" >/dev/null 2>&1 && echo "WARNING: the account $THEM could not be removed: userdel $THEM" >&2
  fi
  [ -n "$BASE" ] && rm -rf "$BASE"
  [ -n "$SHARED" ] && rm -rf "$SHARED"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

ours() { runuser -u "$US" -- env PATH="${NODE_DIR:+$NODE_DIR/bin:}$PATH" "$@"; }
them() { runuser -u "$THEM" -- python3 "$SHARED/probe.py" "$@"; }
check() {   # check <description> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "met      $1"; else echo "NOT MET  $1 (got: $2, expected: $3)"; FAILED=1; fi
}
json() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2" 2>/dev/null; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

make_home() {   # make_home <dir> <port>: a router home as init leaves it, but open (0755): the daemon must close it
  ours mkdir -p "$1"
  ours chmod 755 "$1"
  ours bash -c 'umask 077; head -c 32 /dev/urandom | base64 | tr -d "=+/\n" > "$1/token"; printf "{\"daemonPort\": %s, \"fableOptIn\": false, \"holdoutRate\": 0}\n" "$2" > "$1/config.json"' _ "$1" "$2"
}
start_daemon() {   # start_daemon <home> [NAME=value ...]: waits for endpoint.json; the pid is in <home>.pid
  local home="$1"; shift
  ours rm -f "$home/endpoint.json"
  ours env DO_IT_ALL_CLAUDE_CODE_HOME="$home" "$@" bash -c 'echo $$ > "$1"; cd "$2"; exec "$3" packages/daemon/src/main.ts' _ "$home.pid" "$REPO" "$NODE_BIN" >/dev/null 2>&1 &
  disown
  for _ in $(seq 1 100); do [ -f "$home/endpoint.json" ] && return 0; sleep 0.2; done
  echo "NOT MET  the daemon started for $home (see $home/logs)"; FAILED=1; return 1
}
stop_daemon() {   # stop_daemon <home>
  local pid; pid="$(cat "$1.pid" 2>/dev/null)"
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.2; done
  kill -KILL "$pid" 2>/dev/null
}
status_line() { ours env DO_IT_ALL_CLAUDE_CODE_HOME="$1" "${@:2}" bash -c 'echo "{\"session_id\":\"s-multiuser\"}" | "$1" "$2/plugin/statusline.mjs"' _ "$NODE_BIN" "$REPO"; }

# ---------------------------------------------------------------- setup
ours "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>24||(a===24&&b>=5)?0:1)' \
  || { echo "--node: Node 24.5 or later is needed for --user $US" >&2; exit 2; }
useradd --system --no-create-home --shell /usr/sbin/nologin "$THEM" || { echo "could not create the account" >&2; exit 2; }
echo "second user: $THEM (uid $(id -u "$THEM")); our side: $US (uid $US_UID)"
# Everything sits under /tmp, which anyone may enter: only the router home's own mode stands between the two users.
BASE="$(ours mktemp -d /tmp/diacc-mu.XXXXXX)"; ours chmod 755 "$BASE"
SHARED="$(mktemp -d /tmp/diacc-shared.XXXXXX)"; chmod 1777 "$SHARED"
cp "$(dirname "$0")/probe.py" "$SHARED/probe.py"; chmod 644 "$SHARED/probe.py"
MARKER="MARKER-multiuser-7f3a"

# ---------------------------------------------------------------- 1. the socket in the home
H="$BASE/home"; PORT="$(free_port)"
make_home "$H" "$PORT"
if start_daemon "$H"; then
  SOCK="$(json "$H/endpoint.json" socket)"
  check "the daemon names a socket in its home" "$SOCK" "$H/daemon.sock"
  check "the daemon closed a home that was open (0755 -> 0700)" "$(stat -c %a "$H")" "700"
  check "the socket file is 0600" "$(stat -c %a "$H/daemon.sock" 2>/dev/null)" "600"
  case "$(status_line "$H")" in *OFF*) R="OFF" ;; *"[Router]"*) R="answered" ;; *) R="nothing" ;; esac
  check "control: our own status line reaches the daemon" "$R" "answered"
  check "(1) the other user cannot connect to our socket" "$(them connect "$H/daemon.sock")" "EACCES"
  check "(2) the other user cannot read endpoint.json" "$(them read "$H/endpoint.json")" "EACCES"
  check "(2) the other user cannot read the token" "$(them read "$H/token")" "EACCES"
  check "(5) the other user cannot list the home" "$(them list "$H")" "EACCES"
  check "(5) the other user cannot enter the home" "$(them enter "$H")" "EACCES"
  check "(5) the other user cannot reach a folder inside it" "$(them list "$H/logs")" "EACCES"
  stop_daemon "$H"
  check "after a stop the socket is gone and endpoint.json still names it" "$([ ! -e "$H/daemon.sock" ] && echo gone)/$(json "$H/endpoint.json" socket)" "gone/$H/daemon.sock"
  check "(3) the other user cannot create a socket at our path" "$(them bindunix "$H/daemon.sock")" "EACCES"

  # (4) the other user takes our TCP port while the daemon is down
  LOG="$SHARED/recorded.log"
  runuser -u "$THEM" -- python3 "$SHARED/probe.py" record "$PORT" "$LOG" &
  PIDS+=("$!")
  disown   # it is killed below on purpose: no "Killed" job notice in the report
  for _ in $(seq 1 50); do grep -q LISTENING "$LOG" 2>/dev/null && break; sleep 0.1; done
  check "(4) the other user can bind our TCP port while the daemon is down" "$(grep -c LISTENING "$LOG" 2>/dev/null)" "1"
  RELAY="$(ours env DO_IT_ALL_CLAUDE_CODE_HOME="$H" bash -c 'printf "%s" "$3" | "$1" "$2/plugin/hooks/relay.mjs" UserPromptSubmit' _ "$NODE_BIN" "$REPO" "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"s-multiuser\",\"cwd\":\"/tmp\",\"prompt\":\"hello $MARKER\"}")"
  check "(4) the hook passes the prompt through" "$RELAY" "{}"
  check "(4) the hook's event waits in the spool" "$(ls "$H/spool" 2>/dev/null | wc -l | tr -d ' ')" "1"
  case "$(status_line "$H")" in *OFF*) R="OFF" ;; *) R="not OFF" ;; esac
  check "(4) the status line says OFF" "$R" "OFF"
  case "$(ours env DO_IT_ALL_CLAUDE_CODE_HOME="$H" bash -c 'cd "$2" && "$1" packages/cli/src/index.ts status' _ "$NODE_BIN" "$REPO" 2>&1)" in *"Router OFF"*) R="OFF" ;; *) R="not OFF" ;; esac
  check "(4) the CLI says the router is off" "$R" "OFF"
  sleep 0.5
  check "(4) the other user's listener received no connection at all" "$(grep -c '^CONNECTION' "$LOG")" "0"
  check "(4) nothing it received holds the token or the prompt" "$(grep -c -e "$(cat "$H/token")" -e "$MARKER" "$LOG")" "0"
  # the listener does record: one request of our own, sent on purpose
  ours python3 -c 'import sys,urllib.request; urllib.request.urlopen("http://127.0.0.1:%s/control" % sys.argv[1], timeout=3).read()' "$PORT" 2>/dev/null
  sleep 0.3
  check "control: the listener records what does reach it" "$(grep -c 'GET /control' "$LOG")" "1"
  pkill -KILL -u "$THEM" 2>/dev/null
fi

# ---------------------------------------------------------------- 2. the fallback directory (a home path too long for a socket)
LH="$BASE/$(printf 'h%.0s' $(seq 1 110))"; LPORT="$(free_port)"
make_home "$LH" "$LPORT"
if start_daemon "$LH" XDG_RUNTIME_DIR="$SHARED" TMPDIR="$SHARED"; then
  FSOCK="$(json "$LH/endpoint.json" socket)"; FDIR="$(dirname "$FSOCK")"
  case "$FSOCK" in "$SHARED"/*/daemon.sock) R="in the runtime directory" ;; *) R="$FSOCK" ;; esac
  check "a long home puts the socket in a directory of ours under the runtime directory" "$R" "in the runtime directory"
  check "that directory is ours and 0700" "$(stat -c '%a %U' "$FDIR" 2>/dev/null)" "700 $US"
  check "the other user cannot connect to the fallback socket" "$(them connect "$FSOCK")" "EACCES"
  check "the other user cannot list the fallback directory" "$(them list "$FDIR")" "EACCES"
  stop_daemon "$LH"
  check "the other user cannot create a socket in it" "$(them bindunix "$FSOCK")" "EACCES"

  # the other user prepares the directory first (open to everyone): our daemon must refuse it
  ours rm -rf "$FDIR"
  check "the other user pre-creates the fallback directory" "$(them mkdir "$FDIR" 777)" "OK"
  if start_daemon "$LH" XDG_RUNTIME_DIR="$SHARED" TMPDIR="$SHARED"; then
    check "our daemon refuses a directory the other user prepared: no socket named" "$(json "$LH/endpoint.json" socket)" ""
    check "and puts nothing into it" "$(ls -A "$FDIR" | wc -l | tr -d ' ')" "0"
    check "it says so in its log" "$(grep -l 'no private place for the daemon socket' "$LH"/logs/* 2>/dev/null | wc -l | tr -d ' ')" "1"
    case "$(status_line "$LH" XDG_RUNTIME_DIR="$SHARED" TMPDIR="$SHARED")" in *OFF*) R="OFF" ;; *"[Router]"*) R="answered" ;; *) R="nothing" ;; esac
    check "and still answers its own clients on the port, sealed" "$R" "answered"
    stop_daemon "$LH"
  fi
  # the same with a link in that place, pointing at a directory of the other user's
  runuser -u "$THEM" -- rmdir "$FDIR" 2>/dev/null
  them mkdir "$SHARED/theirs" 777 >/dev/null
  check "the other user puts a link in that place" "$(them symlink "$SHARED/theirs" "$FDIR")" "OK"
  if start_daemon "$LH" XDG_RUNTIME_DIR="$SHARED" TMPDIR="$SHARED"; then
    check "our daemon refuses the link: no socket named" "$(json "$LH/endpoint.json" socket)" ""
    check "and puts nothing behind it" "$(ls -A "$SHARED/theirs" | wc -l | tr -d ' ')" "0"
    stop_daemon "$LH"
  fi
fi

if [ "$FAILED" = "0" ]; then echo "all checks met"; else echo "some checks NOT MET"; fi
exit "$FAILED"
