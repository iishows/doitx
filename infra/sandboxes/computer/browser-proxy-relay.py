#!/usr/bin/env python3
"""Per-bot local proxy relay for the sandboxed browser.

Chromium cannot send proxy credentials on the command line, so instead of
pointing it straight at the upstream proxy we point it at this loopback relay.
The relay holds the upstream credential and speaks either HTTP CONNECT or
SOCKS5 (RFC 1929) to the real proxy, so each bot's browser leaves from its own
egress IP without the credential ever reaching the browser or the argv.

Configuration comes from the environment so it needs no file on disk:

  RAKAZO_BROWSER_PROXY_PORT      loopback port to listen on (required)
  RAKAZO_BROWSER_PROXY_UPSTREAM  scheme://host:port (http, https, socks5, socks5h)
  RAKAZO_BROWSER_PROXY_USERNAME  optional
  RAKAZO_BROWSER_PROXY_PASSWORD  optional

Every accepted connection is handed to a fresh thread, and dialing the upstream
is done only after the client has asked for a destination, so an unreachable
proxy fails the individual request instead of the whole listener.
"""

from __future__ import annotations

import base64
import os
import socket
import ssl
import sys
import threading
from urllib.parse import urlsplit

UPSTREAM_SCHEMES = ("http", "https", "socks5", "socks5h")
CONNECT_TIMEOUT_SECONDS = 15
IO_TIMEOUT_SECONDS = 300
BUFFER_SIZE = 65536


class RelayError(Exception):
    """Raised when the upstream proxy cannot be reached or refused the request."""


def parse_upstream(value: str) -> tuple[str, str, int, str]:
    """Split an upstream URL into (scheme, host, port, credential)."""
    parts = urlsplit(value)
    scheme = parts.scheme.lower()
    if scheme not in UPSTREAM_SCHEMES:
        raise RelayError(f"unsupported upstream scheme: {scheme or value!r}")
    if not parts.hostname:
        raise RelayError("upstream proxy is missing a host")
    port = parts.port or (1080 if scheme.startswith("socks") else 8080)
    credential = ""
    if parts.username is not None:
        credential = f"{parts.username}:{parts.password or ''}"
    return scheme, parts.hostname, int(port), credential


def read_until_blank_line(sock: socket.socket) -> bytes:
    """Read one HTTP message head, ending at the blank line."""
    head = b""
    while b"\r\n\r\n" not in head and b"\n\n" not in head:
        chunk = sock.recv(BUFFER_SIZE)
        if not chunk:
            break
        head += chunk
        if len(head) > BUFFER_SIZE:
            raise RelayError("proxy response head too large")
    return head


def dial_tcp(host: str, port: int) -> socket.socket:
    upstream = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT_SECONDS)
    upstream.settimeout(IO_TIMEOUT_SECONDS)
    return upstream


def dial_proxy(config: "RelayConfig") -> socket.socket:
    """Connect to the upstream proxy, wrapping in TLS when its scheme is https."""
    sock = dial_tcp(config.host, config.port)
    if config.scheme != "https":
        return sock
    try:
        context = ssl.create_default_context()
        return context.wrap_socket(sock, server_hostname=config.host)
    except OSError:
        sock.close()
        raise


def socks5_handshake(sock: socket.socket, username: str, password: str) -> None:
    if username or password:
        methods = b"\x00\x02"
    else:
        methods = b"\x00"
    sock.sendall(b"\x05" + bytes([len(methods)]) + methods)
    reply = recv_exact(sock, 2)
    if reply[0] != 0x05:
        raise RelayError("upstream is not a SOCKS5 proxy")
    if reply[1] == 0x02:
        user = username.encode()
        secret = password.encode()
        sock.sendall(
            b"\x01"
            + bytes([len(user)])
            + user
            + bytes([len(secret)])
            + secret
        )
        auth_reply = recv_exact(sock, 2)
        if auth_reply[1] != 0x00:
            raise RelayError("upstream proxy rejected the credentials")
    elif reply[1] != 0x00:
        raise RelayError("upstream proxy requires an unsupported authentication method")


def recv_exact(sock: socket.socket, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise RelayError("upstream proxy closed the connection")
        data += chunk
    return data


def socks5_connect(sock: socket.socket, host: str, port: int, resolve_locally: bool) -> None:
    if resolve_locally:
        try:
            address = socket.gethostbyname(host)
        except OSError as error:
            raise RelayError(f"cannot resolve {host}") from error
        request = b"\x05\x01\x00\x01" + socket.inet_aton(address)
    else:
        encoded = host.encode()
        if len(encoded) > 255:
            raise RelayError("destination hostname is too long")
        request = b"\x05\x01\x00\x03" + bytes([len(encoded)]) + encoded
    sock.sendall(request + port.to_bytes(2, "big"))
    reply = recv_exact(sock, 4)
    if reply[1] != 0x00:
        raise RelayError(f"upstream proxy refused the connection (code {reply[1]})")
    if reply[3] == 0x01:
        recv_exact(sock, 4 + 2)
    elif reply[3] == 0x04:
        recv_exact(sock, 16 + 2)
    elif reply[3] == 0x03:
        length = recv_exact(sock, 1)[0]
        recv_exact(sock, length + 2)
    else:
        raise RelayError("upstream proxy sent an unknown address type")


def connect_upstream(config: "RelayConfig", host: str, port: int) -> socket.socket:
    """Open a byte tunnel to host:port through the upstream proxy."""
    if config.scheme.startswith("socks"):
        sock = dial_proxy(config)
        try:
            socks5_handshake(sock, config.username, config.password)
            socks5_connect(sock, host, port, resolve_locally=config.scheme == "socks5")
            return sock
        except Exception:
            sock.close()
            raise
    sock = dial_proxy(config)
    try:
        header = [f"CONNECT {host}:{port} HTTP/1.1", f"Host: {host}:{port}"]
        if config.username or config.password:
            token = base64.b64encode(
                f"{config.username}:{config.password}".encode()
            ).decode()
            header.append(f"Proxy-Authorization: Basic {token}")
        sock.sendall(("\r\n".join(header) + "\r\n\r\n").encode())
        response = read_until_blank_line(sock)
        status_line = response.split(b"\r\n", 1)[0].split(b"\n", 1)[0]
        fields = status_line.split(b" ", 2)
        if len(fields) < 2 or not fields[1].startswith(b"2"):
            raise RelayError(
                f"upstream proxy refused CONNECT: {status_line.decode(errors='replace')}"
            )
        return sock
    except Exception:
        sock.close()
        raise


def pump(source: socket.socket, sink: socket.socket) -> None:
    try:
        while True:
            chunk = source.recv(BUFFER_SIZE)
            if not chunk:
                break
            sink.sendall(chunk)
    except OSError:
        pass
    finally:
        for sock in (source, sink):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def request_line_fields(head: bytes) -> list[bytes]:
    first_line = head.split(b"\r\n", 1)[0].split(b"\n", 1)[0]
    return first_line.split(b" ")


def parse_target(head: bytes) -> tuple[str, int]:
    """Return (host, port) from a proxy request line, whether CONNECT or absolute URI."""
    fields = request_line_fields(head)
    if len(fields) < 2:
        raise RelayError("malformed proxy request")
    method, target = fields[0].upper(), fields[1].decode(errors="replace")
    if method == b"CONNECT":
        host, _, raw_port = target.rpartition(":")
        if not host or not raw_port.isdigit():
            raise RelayError("malformed CONNECT target")
        return host.strip("[]"), int(raw_port)
    # Plain HTTP through a proxy uses an absolute request target:
    #   GET http://example.test/path HTTP/1.1
    parts = urlsplit(target)
    if not parts.hostname:
        raise RelayError("proxy request is missing a destination host")
    return parts.hostname, int(parts.port or (443 if parts.scheme == "https" else 80))


def to_origin_form(head: bytes) -> bytes:
    """Rewrite an absolute request target to origin form for the origin server."""
    separator = b"\r\n" if b"\r\n" in head else b"\n"
    lines = head.split(separator)
    fields = lines[0].split(b" ")
    if len(fields) >= 3:
        parts = urlsplit(fields[1].decode(errors="replace"))
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"
        fields[1] = path.encode()
        lines[0] = b" ".join(fields)
    return separator.join(lines)


class RelayConfig:
    def __init__(self, scheme: str, host: str, port: int, username: str, password: str, listen_port: int):
        self.scheme = scheme
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.listen_port = listen_port


def handle_client(client: socket.socket, config: RelayConfig) -> None:
    upstream: socket.socket | None = None
    try:
        client.settimeout(IO_TIMEOUT_SECONDS)
        head = read_until_blank_line(client)
        if not head:
            return
        fields = request_line_fields(head)
        is_connect = bool(fields) and fields[0].upper() == b"CONNECT"
        try:
            host, port = parse_target(head)
        except (RelayError, ValueError):
            client.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        try:
            upstream = connect_upstream(config, host, port)
        except (OSError, RelayError):
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        if is_connect:
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        else:
            # Plain HTTP: hand the request on to the origin server unchanged
            # apart from the absolute target becoming origin form.
            upstream.sendall(to_origin_form(head))
        threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
        pump(upstream, client)
    except OSError:
        pass
    finally:
        for sock in (client, upstream):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass


def serve(config: RelayConfig) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", config.listen_port))
    listener.listen(128)
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            continue
        threading.Thread(target=handle_client, args=(client, config), daemon=True).start()


def load_config_from_env(env: dict[str, str]) -> RelayConfig:
    raw_port = env.get("RAKAZO_BROWSER_PROXY_PORT", "").strip()
    if not raw_port.isdigit():
        raise RelayError("RAKAZO_BROWSER_PROXY_PORT must be set to a port number")
    upstream = env.get("RAKAZO_BROWSER_PROXY_UPSTREAM", "").strip()
    if not upstream:
        raise RelayError("RAKAZO_BROWSER_PROXY_UPSTREAM is required")
    scheme, host, port, embedded = parse_upstream(upstream)
    username = env.get("RAKAZO_BROWSER_PROXY_USERNAME", "") or ""
    password = env.get("RAKAZO_BROWSER_PROXY_PASSWORD", "") or ""
    if embedded and not username:
        username, _, password = embedded.partition(":")
    return RelayConfig(scheme, host, port, username, password, int(raw_port))


def main() -> int:
    try:
        config = load_config_from_env(dict(os.environ))
    except RelayError as error:
        print(f"invalid relay configuration: {error}", file=sys.stderr)
        return 1
    try:
        serve(config)
    except OSError as error:
        print(f"relay failed to listen on 127.0.0.1:{config.listen_port}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
