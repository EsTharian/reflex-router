#!/usr/bin/env python3
# Spike helper: runs a command inside a pseudo-terminal (so interactive TUIs start), types the given keystrokes after
# delays, and drains the terminal output to /dev/null. Used by first-turn-probe.mjs.
#   pty-run.py <delay-s> <text> [<delay-s> <text> ...] -- <command...>
import os, pty, select, sys, time

args = sys.argv[1:]
sep = args.index("--")
steps = [(float(args[i]), args[i + 1].encode().decode("unicode_escape").encode()) for i in range(0, sep, 2)]
cmd = args[sep + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
start = time.time()
pending = list(steps)
while True:
    if pending and time.time() - start >= pending[0][0]:
        os.write(fd, pending.pop(0)[1])
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            if not os.read(fd, 65536):
                break
        except OSError:
            break
    done, _ = os.waitpid(pid, os.WNOHANG)
    if done:
        break
