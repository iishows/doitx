"""Offline tests for the per-bot browser proxy relay.

A fake upstream proxy stands in for the real one so the HTTPS CONNECT and SOCKS5
paths can be exercised without any network access.
"""
import base64
import importlib.machinery
import importlib.util
import socket
import threading
import unittest
from pathlib import Path

loader = importlib.machinery.SourceFileLoader("relay", str(Path(__file__).with_name("browser-proxy-relay.py")))
spec = importlib.util.spec_from_loader(loader.name, loader)
relay = importlib.util.module_from_spec(spec)
loader.exec_module(relay)


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def recv_exact(conn, count):
    """Read exactly `count` bytes; a single recv can return a partial read."""
    data = b""
    while len(data) < count:
        chunk = conn.recv(count - len(data))
        if not chunk:
            raise AssertionError("peer closed before sending the expected bytes")
        data += chunk
    return data


class FakeHttpProxy:
    """Accepts one CONNECT, records the credentials it saw, then echoes bytes."""

    def __init__(self, status=b"200 Connection Established"):
        self.status = status
        self.authorization = None
        self.target = None
        self.received = b""
        self.port = free_port()
        self._listener = socket.socket()
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", self.port))
        self._listener.listen(4)
        self._thread = threading.Thread(target=self._guard, daemon=True)
        self._thread.start()

    def _guard(self):
        # close() races this daemon thread during teardown; that is not a failure.
        try:
            self._serve()
        except OSError:
            pass

    def _serve(self):
        conn, _ = self._listener.accept()
        with conn:
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                head += chunk
            for line in head.split(b"\r\n"):
                if line.lower().startswith(b"proxy-authorization:"):
                    self.authorization = line.split(b":", 1)[1].strip()
                if line.startswith(b"CONNECT "):
                    self.target = line.split(b" ")[1].decode()
            conn.sendall(b"HTTP/1.1 " + self.status + b"\r\n\r\n")
            if not self.status.startswith(b"2"):
                return
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                self.received += chunk
                conn.sendall(chunk)

    def close(self):
        self._listener.close()


class FakeSocksProxy:
    """Minimal SOCKS5 server that requires username/password (RFC 1929)."""

    def __init__(self, accept_credentials=b"user:secret"):
        self.accept_credentials = accept_credentials
        self.saw_credentials = None
        self.target = None
        self.port = free_port()
        self._listener = socket.socket()
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listener.bind(("127.0.0.1", self.port))
        self._listener.listen(4)
        threading.Thread(target=self._guard, daemon=True).start()

    def _guard(self):
        try:
            self._serve()
        except OSError:
            pass

    def _serve(self):
        conn, _ = self._listener.accept()
        with conn:
            head = recv_exact(conn, 2)
            methods = recv_exact(conn, head[1])
            self.offered_methods = methods
            conn.sendall(b"\x05\x02")  # username/password required
            recv_exact(conn, 1)  # auth version
            user = recv_exact(conn, recv_exact(conn, 1)[0])
            secret = recv_exact(conn, recv_exact(conn, 1)[0])
            self.saw_credentials = user + b":" + secret
            if self.saw_credentials == self.accept_credentials:
                conn.sendall(b"\x01\x00")
            else:
                conn.sendall(b"\x01\x01")
                return
            request = recv_exact(conn, 4)
            if request[3] == 0x01:
                host = socket.inet_ntoa(recv_exact(conn, 4))
            else:
                host = recv_exact(conn, recv_exact(conn, 1)[0]).decode()
            port = int.from_bytes(recv_exact(conn, 2), "big")
            self.target = f"{host}:{port}"
            conn.sendall(b"\x05\x00\x00\x01" + socket.inet_aton("127.0.0.1") + b"\x00\x00")
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                conn.sendall(chunk)

    def close(self):
        self._listener.close()


def start_relay(config):
    thread = threading.Thread(target=relay.serve, args=(config,), daemon=True)
    thread.start()
    return thread


def connect_with_request(listen_port, target):
    """Open a client connection and speak the HTTPS CONNECT handshake."""
    client = socket.create_connection(("127.0.0.1", listen_port), timeout=5)
    client.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    return client


class ParseUpstreamTests(unittest.TestCase):
    def test_accepts_each_supported_scheme(self):
        for scheme in ("http", "https", "socks5", "socks5h"):
            with self.subTest(scheme=scheme):
                parsed = relay.parse_upstream(f"{scheme}://proxy.example:9000")
                self.assertEqual(parsed[:3], (scheme, "proxy.example", 9000))

    def test_reads_embedded_credentials(self):
        _, _, _, credential = relay.parse_upstream("socks5://user:secret@proxy.example:1080")
        self.assertEqual(credential, "user:secret")

    def test_rejects_unknown_scheme_and_missing_host(self):
        with self.assertRaises(relay.RelayError):
            relay.parse_upstream("ftp://proxy.example:21")
        with self.assertRaises(relay.RelayError):
            relay.parse_upstream("http://:8080")


class RelayConfigTests(unittest.TestCase):
    def test_requires_a_port_and_an_upstream(self):
        with self.assertRaises(relay.RelayError):
            relay.load_config_from_env({"RAKAZO_BROWSER_PROXY_UPSTREAM": "http://p.example:1"})
        with self.assertRaises(relay.RelayError):
            relay.load_config_from_env({"RAKAZO_BROWSER_PROXY_PORT": "20001"})

    def test_prefers_explicit_credentials_over_embedded_ones(self):
        config = relay.load_config_from_env({
            "RAKAZO_BROWSER_PROXY_PORT": "20001",
            "RAKAZO_BROWSER_PROXY_UPSTREAM": "socks5://embedded:value@proxy.example:1080",
            "RAKAZO_BROWSER_PROXY_USERNAME": "explicit",
            "RAKAZO_BROWSER_PROXY_PASSWORD": "wins",
        })
        self.assertEqual((config.username, config.password), ("explicit", "wins"))

    def test_port_must_be_numeric(self):
        with self.assertRaises(relay.RelayError):
            relay.load_config_from_env({
                "RAKAZO_BROWSER_PROXY_PORT": "not-a-port",
                "RAKAZO_BROWSER_PROXY_UPSTREAM": "http://proxy.example:8080",
            })


class RelayForwardingTests(unittest.TestCase):
    def test_forwards_through_an_http_proxy_with_basic_credentials(self):
        upstream = FakeHttpProxy()
        listen = free_port()
        start_relay(relay.RelayConfig("http", "127.0.0.1", upstream.port, "user", "secret", listen))
        client = connect_with_request(listen, "example.test:443")
        try:
            self.assertTrue(client.recv(64) .startswith(b"HTTP/1.1 200"))
            client.sendall(b"ping")
            self.assertEqual(client.recv(64), b"ping")
        finally:
            client.close()
            upstream.close()
        self.assertEqual(upstream.target, "example.test:443")
        expected = base64.b64encode(b"user:secret")
        self.assertEqual(upstream.authorization, b"Basic " + expected)

    def test_reports_bad_gateway_when_the_upstream_refuses(self):
        upstream = FakeHttpProxy(status=b"407 Proxy Authentication Required")
        listen = free_port()
        start_relay(relay.RelayConfig("http", "127.0.0.1", upstream.port, "user", "wrong", listen))
        client = connect_with_request(listen, "example.test:443")
        try:
            self.assertTrue(client.recv(64).startswith(b"HTTP/1.1 502"))
        finally:
            client.close()
            upstream.close()

    def test_reports_bad_gateway_when_the_upstream_is_unreachable(self):
        listen = free_port()
        start_relay(relay.RelayConfig("http", "127.0.0.1", free_port(), None, None, listen))
        client = connect_with_request(listen, "example.test:443")
        try:
            self.assertTrue(client.recv(64).startswith(b"HTTP/1.1 502"))
        finally:
            client.close()

    def test_authenticates_to_a_socks5_upstream(self):
        # socks5 (unlike socks5h) resolves locally, so the target must be an IP.
        upstream = FakeSocksProxy()
        listen = free_port()
        start_relay(relay.RelayConfig("socks5", "127.0.0.1", upstream.port, "user", "secret", listen))
        client = connect_with_request(listen, "93.184.216.34:443")
        try:
            self.assertTrue(client.recv(64).startswith(b"HTTP/1.1 200"))
            client.sendall(b"ping")
            self.assertEqual(client.recv(64), b"ping")
        finally:
            client.close()
            upstream.close()
        self.assertEqual(upstream.saw_credentials, b"user:secret")
        self.assertEqual(upstream.target, "93.184.216.34:443")

    def test_socks5h_leaves_resolution_to_the_proxy(self):
        upstream = FakeSocksProxy()
        listen = free_port()
        start_relay(relay.RelayConfig("socks5h", "127.0.0.1", upstream.port, "user", "secret", listen))
        client = connect_with_request(listen, "example.test:443")
        try:
            self.assertTrue(client.recv(64).startswith(b"HTTP/1.1 200"))
        finally:
            client.close()
            upstream.close()
        self.assertEqual(upstream.target, "example.test:443")

    def test_plain_http_is_tunnelled_and_rewritten_to_origin_form(self):
        upstream = FakeHttpProxy()
        listen = free_port()
        start_relay(relay.RelayConfig("http", "127.0.0.1", upstream.port, None, None, listen))
        client = socket.create_connection(("127.0.0.1", listen), timeout=5)
        try:
            # The fake origin echoes whatever it receives, so whatever comes back
            # equals the request the origin actually saw.
            client.sendall(b"GET http://example.test/path?q=1 HTTP/1.1\r\nHost: example.test\r\n\r\n")
            echoed = client.recv(256)
        finally:
            client.close()
            upstream.close()
        self.assertEqual(upstream.target, "example.test:80")
        self.assertTrue(echoed.startswith(b"GET /path?q=1 HTTP/1.1"))
        self.assertNotIn(b"http://example.test", echoed)

    def test_rejects_a_request_with_no_destination(self):
        upstream = FakeHttpProxy()
        listen = free_port()
        start_relay(relay.RelayConfig("http", "127.0.0.1", upstream.port, None, None, listen))
        client = socket.create_connection(("127.0.0.1", listen), timeout=5)
        try:
            client.sendall(b"GET / HTTP/1.1\r\nHost: \r\n\r\n")
            self.assertTrue(client.recv(64).startswith(b"HTTP/1.1 400"))
        finally:
            client.close()
            upstream.close()


if __name__ == "__main__":
    unittest.main()
