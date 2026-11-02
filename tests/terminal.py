"""PTY smoke checks for a complete native build: python3 tests/terminal.py COMMAND [ARGS]."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def check(command, exit_mode):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    environment = dict(os.environ, TERM="xterm-256color")
    environment.pop("NO_COLOR", None)
    process = subprocess.Popen(command + ["--side", "both", "--unicode"],
                               stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True, env=environment)
    output = bytearray()

    def read_until(marker, offset=0):
        deadline = time.monotonic() + 20
        while marker not in output[offset:]:
            if time.monotonic() >= deadline:
                raise AssertionError("Timed out waiting for " + repr(marker) + ": " + repr(output[-500:]))
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    raise AssertionError("Terminal closed before " + repr(marker))
                output.extend(chunk)
            elif process.poll() is not None:
                raise AssertionError("Process exited before " + repr(marker))

    try:
        read_until(b"> ")
        assert b"\x1b[?1049h" in output, "No alternate screen"
        assert "♜".encode() in output, "No Unicode pieces"
        assert b"48;5;" in output, "No board colors"
        assert termios.tcgetattr(slave)[3] & (termios.ICANON | termios.ECHO) == 0, "Not in raw mode"
        offset = len(output)
        os.write(master, b"e2e4\r")
        read_until(b"Played e2e4.", offset)
        offset = len(output)
        os.write(master, b"undo\r")
        read_until(b"Move taken back.", offset)
        offset = len(output)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 50, 0, 0))
        process.send_signal(signal.SIGWINCH)
        read_until(b"\x1b[H\x1b[2J", offset)
        offset = len(output)
        if exit_mode == "quit":
            os.write(master, b"quit\r")
        elif exit_mode == "ctrl-c":
            os.write(master, b"\x03")
        else:
            process.send_signal(signal.SIGTERM)
        read_until(b"Thanks for playing.", offset)
        assert process.wait(timeout=10) == 0, "Nonzero exit"
        assert b"\x1b[?1049l" in output[offset:], "Alternate screen was not restored"
        assert b"\x1b[?25h" in output[offset:], "Cursor was not restored"
        restored = termios.tcgetattr(slave)
        # PENDIN is a kernel input-status bit, not a terminal-mode setting.
        normalized = list(restored)
        normalized[3] &= ~getattr(termios, "PENDIN", 0)
        expected = list(original)
        expected[3] &= ~getattr(termios, "PENDIN", 0)
        assert normalized == expected, "Terminal settings were not restored"
        return {"exit": exit_mode, "bytes": len(output), "passed": True,
                "pendinChanged": bool((original[3] ^ restored[3]) & getattr(termios, "PENDIN", 0))}
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Pass executable and optional arguments")
    print(json.dumps({"command": sys.argv[1:], "results": [
        check(sys.argv[1:], mode) for mode in ["quit", "ctrl-c", "sigterm"]
    ]}, indent=2))
