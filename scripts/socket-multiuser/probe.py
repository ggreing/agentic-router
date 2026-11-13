#!/usr/bin/env python3
"""What the second user tries (run.sh runs this as that user). Prints OK or the errno name, one line.

  connect <socket>         connect to a Unix socket
  read <file>              open a file for reading
  list <dir>               list a directory
  enter <dir>              change into a directory
  bindunix <path>          create a Unix socket at a path
  mkdir <dir> <octal>      make a directory with that mode
  symlink <target> <link>  make a link
  record <port> <logfile>  listen on 127.0.0.1:<port>, write every byte received to <logfile>, answer 200
"""
import errno
import os
import socket
import sys


def attempt(fn):
    try:
        fn()
        print("OK")
    except OSError as e:
        print(errno.errorcode.get(e.errno, str(e.errno)))


def connect(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3)
    s.connect(path)
    s.close()


def bindunix(path):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(path)
    s.close()
    os.unlink(path)


def record(port, logfile):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(16)
    with open(logfile, "ab", buffering=0) as log:
        log.write(b"LISTENING\n")
        while True:
            conn, _ = srv.accept()
            conn.settimeout(2)
            log.write(b"CONNECTION\n")
            try:
                data = conn.recv(65536)
                log.write(data + b"\n")
                conn.sendall(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
            except OSError:
                pass
            finally:
                conn.close()


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "connect":
        attempt(lambda: connect(args[0]))
    elif cmd == "read":
        attempt(lambda: open(args[0], "rb").close())
    elif cmd == "list":
        attempt(lambda: os.listdir(args[0]))
    elif cmd == "enter":
        attempt(lambda: os.chdir(args[0]))
    elif cmd == "bindunix":
        attempt(lambda: bindunix(args[0]))
    elif cmd == "mkdir":
        def make():
            os.mkdir(args[0])
            os.chmod(args[0], int(args[1], 8))
        attempt(make)
    elif cmd == "symlink":
        attempt(lambda: os.symlink(args[0], args[1]))
    elif cmd == "record":
        record(int(args[0]), args[1])
    else:
        sys.exit("unknown command")


if __name__ == "__main__":
    main()
