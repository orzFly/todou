#!/usr/bin/env python3
"""Private NDJSON PTY bridge for native-lifecycle-smoke.mjs (Python stdlib only)."""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(value):
    print(json.dumps(value), flush=True)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: pty.py executable [arguments ...]")
    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
    emit({"kind": "spawn", "pid": pid})
    stopping = False
    buffer = b""
    status = None

    def stop(_signum=None, _frame=None):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping:
            exited, child_status = os.waitpid(pid, os.WNOHANG)
            if exited:
                status = child_status
                break
            readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    emit({"kind": "output", "base64": base64.b64encode(data).decode()})
                    # Native terminals may query cursor position before accepting input.
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")
                else:
                    break
            if sys.stdin.fileno() in readable:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    break
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    command = json.loads(line)
                    if command.get("stop"):
                        stopping = True
                        break
                    os.write(master, command["input"].encode())
    finally:
        # The PTY child is a session/group leader. Kill its complete owned group,
        # including children surviving an early host exit, before reaping it.
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 3
        while status is None and time.monotonic() < deadline:
            exited, child_status = os.waitpid(pid, os.WNOHANG)
            if exited:
                status = child_status
                break
            select.select([], [], [], 0.05)
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if status is None:
            _, status = os.waitpid(pid, 0)
        os.close(master)
        emit({"kind": "exit", "pid": pid, "code": os.waitstatus_to_exitcode(status)})


if __name__ == "__main__":
    main()
