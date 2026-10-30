#!/usr/bin/env python3
"""Close one Chromium by CDP so it commits its profile before the container dies.

PID 1's shutdown sends SIGTERM to every process. Chromium treats that as an
abrupt exit: it does not commit its cookie jar, and it leaves exit_type=Crashed,
which makes the next start drop session cookies (account sign-in) while
persistent cookies survive. The supervisor's own stop path avoids this by
sending Browser.close over the DevTools socket first; this is the same close for
the shutdown the container performs itself.

Usage: close-browser.py <pid> <profile-dir>

Exits non-zero without closing when the process is not a browser holding that
profile, so the caller can fall back to signalling it.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import sys
import urllib.request

TIMEOUT_S = 2.0
MAX_RESPONSE = 16_384


def remote_debugging_port(pid: str, profile: str) -> int | None:
    """The port this browser was launched with.

    Read from the process's own argv rather than discovered on the profile, so a
    browser started with an explicit --remote-debugging-port is still found.
    """
    try:
        with open("/proc/" + pid + "/cmdline", "rb") as handle:
            data = handle.read().replace(b"\0", b" ")
    except OSError:
        return None
    if profile:
        # Drop the profile flag so a path containing the key cannot match it.
        data = data.replace(b"--user-data-dir=" + profile.encode(), b" ", 1)
    key = b"--remote-debugging-port="
    start = len(data)
    while True:
        start = data.rfind(key, 0, start)
        if start < 0:
            return None
        if start == 0 or data[start - 1 : start] == b" ":
            digits = bytearray()
            index = start + len(key)
            while index < len(data) and 48 <= data[index] <= 57:
                digits.append(data[index])
                index += 1
            if digits:
                return int(digits)
    return None


def browser_websocket(port: int) -> str:
    with urllib.request.urlopen(
        "http://127.0.0.1:" + str(port) + "/json/version", timeout=TIMEOUT_S
    ) as response:
        return json.load(response)["webSocketDebuggerUrl"]


def send_browser_close(endpoint: str, port: int) -> None:
    path = "/" + endpoint.split("/", 3)[3]
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    with socket.create_connection(("127.0.0.1", port), timeout=TIMEOUT_S) as connection:
        connection.sendall(
            (
                "GET " + path + " HTTP/1.1\r\n"
                "Host: 127.0.0.1:" + str(port) + "\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Key: " + key + "\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode("ascii")
        )
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = connection.recv(4096)
            if not chunk:
                raise RuntimeError("browser debugger disconnected")
            response += chunk
            if len(response) > MAX_RESPONSE:
                raise RuntimeError("browser debugger handshake too large")
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise RuntimeError("browser debugger rejected connection")
        payload = b'{"id":1,"method":"Browser.close"}'
        mask = os.urandom(4)
        connection.sendall(
            bytes([0x81, 0x80 | len(payload)])
            + mask
            + bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        )
        # The browser answers and then tears the socket down; a reset here still means the close
        # was delivered, so it is not a failure.
        try:
            connection.recv(4096)
        except OSError:
            pass


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: close-browser.py <pid> <profile-dir>", file=sys.stderr)
        return 2
    pid, profile = argv[1], argv[2]
    if not pid.isdigit():
        return 2
    port = remote_debugging_port(pid, profile)
    if port is None:
        return 1
    try:
        send_browser_close(browser_websocket(port), port)
    except Exception as exc:  # noqa: BLE001 - any failure means "signal it instead"
        print("close failed: " + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
