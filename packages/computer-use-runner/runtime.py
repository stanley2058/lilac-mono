"""Persistent desktop Python runtime, reached through docker exec and a local socket."""

import ast
import asyncio
import base64
import contextlib
import inspect
import io
import json
import os
import socket
import sys
import uuid
from urllib.request import urlopen

SOCKET_PATH = "/tmp/lilac-computer.sock"
MAX_REQUEST = 262144
MAX_RESPONSE = 16777216
MAX_TEXT = 65536
MAX_IMAGE_BYTES = 12582912


class OutputLimit(Exception):
    pass


class TextOutput(io.TextIOBase):
    def __init__(self):
        self.parts = []
        self.size = 0

    def write(self, value):
        self.size += len(value.encode("utf-8"))
        if self.size > MAX_TEXT:
            raise OutputLimit("Text output exceeds 64 KiB")
        self.parts.append(value)
        return len(value)


class Runtime:
    def __init__(self, driver):
        self.driver = driver
        self.generation = str(uuid.uuid4())
        self.images = []
        self.image_bytes = 0
        self.namespace = {"cua": self.cua, "display": self.display}
        self.started = False

    async def cua(self, name, **arguments):
        return await self.driver.call_tool(name, json.dumps(arguments))

    def display(self, value, mime_type="image/png"):
        if hasattr(value, "images"):
            if value.text:
                print(value.text)
            for part in value.images:
                self.add_image(part.data_base64, part.mime_type)
            return
        if not isinstance(value, bytes):
            raise TypeError("display expects CUA ToolResult or image bytes")
        self.add_image(base64.b64encode(value).decode("ascii"), mime_type)

    def add_image(self, data, mime_type):
        if mime_type not in ("image/png", "image/jpeg", "image/webp"):
            raise ValueError("Unsupported image MIME type")
        size = len(data.encode("ascii"))
        if len(self.images) >= 8 or self.image_bytes + size > MAX_IMAGE_BYTES:
            raise OutputLimit("Image output exceeds its limit")
        self.image_bytes += size
        self.images.append({"type": "image", "mimeType": mime_type, "data": data})

    async def health(self):
        if not self.started:
            result = await self.cua("start_session", session="lilac", capture_scope="desktop")
            if result.is_error:
                return {"ok": False, "generation": self.generation, "error": "CUA session unavailable"}
            self.started = True
        report = await self.cua("health_report")
        if report.is_error or not report.structured_json:
            return {"ok": False, "generation": self.generation, "error": "CUA health unavailable"}
        checks = json.loads(report.structured_json).get("checks", [])
        required = {"binary_version", "platform_supported", "session_active", "ax_capability", "screen_capture_capability"}
        passed = {item["name"] for item in checks if item.get("status") == "pass"}
        if not required.issubset(passed):
            return {"ok": False, "generation": self.generation, "error": "Desktop capabilities unavailable"}
        screenshot = await self.cua("get_desktop_state", session="lilac")
        if screenshot.is_error or not screenshot.images:
            return {"ok": False, "generation": self.generation, "error": "Desktop capture unavailable"}
        with urlopen("http://127.0.0.1:6901/vnc.html", timeout=3) as response:
            if response.status != 200:
                return {"ok": False, "generation": self.generation, "error": "Viewer unavailable"}
        return {"ok": True, "generation": self.generation}

    async def handle(self, request):
        if not isinstance(request, dict):
            return {"ok": False, "error": "Expected request object"}
        operation = request.get("operation")
        if operation == "info":
            return {"ok": True, "generation": self.generation}
        if operation == "health":
            return await self.health()
        if operation != "execute" or not isinstance(request.get("code"), str):
            return {"ok": False, "error": "Expected execute with code, health, or info"}
        self.images = []
        self.image_bytes = 0
        output = TextOutput()
        failure = None
        existing_tasks = asyncio.all_tasks()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                compiled = compile(request["code"], "<computer>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
                value = eval(compiled, self.namespace)
                if inspect.isawaitable(value):
                    await value
            except BaseException as error:
                failure = f"{type(error).__name__}: {str(error)[:4096]}"
            finally:
                # A completed call must not leave Python tasks that act during the next call.
                while pending := asyncio.all_tasks() - existing_tasks:
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
        content = [{"type": "text", "text": "".join(output.parts)}, *self.images]
        if failure:
            content.append({"type": "text", "text": failure})
        return {"ok": True, "generation": self.generation, "isError": failure is not None, "content": content}


def read_message(stream, limit):
    data = stream.readline(limit + 1)
    if not data.endswith(b"\n") or len(data) > limit:
        raise ValueError("Message exceeds its limit or is incomplete")
    return json.loads(data)


def serve():
    from cua_driver import CuaDriver

    runtime = Runtime(CuaDriver.create())
    with socket.socket(socket.AF_UNIX) as server, asyncio.Runner() as runner:
        # An existing socket means another runtime may own the persistent namespace.
        server.bind(SOCKET_PATH)
        os.chmod(SOCKET_PATH, 0o600)
        server.listen(16)
        while True:
            connection, _ = server.accept()
            with connection, connection.makefile("rb") as stream:
                try:
                    request = read_message(stream, MAX_REQUEST)
                    response = runner.run(runtime.handle(request))
                except Exception:
                    response = {"ok": False, "error": "Runner operation failed"}
                encoded = json.dumps(response).encode("utf-8") + b"\n"
                if len(encoded) > MAX_RESPONSE:
                    encoded = b'{"ok":false,"error":"Response exceeds its limit"}\n'
                try:
                    connection.sendall(encoded)
                except OSError:
                    pass


def client():
    request = read_message(sys.stdin.buffer, MAX_REQUEST)
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(SOCKET_PATH)
        connection.sendall(json.dumps(request).encode("utf-8") + b"\n")
        with connection.makefile("rb") as stream:
            response = read_message(stream, MAX_RESPONSE)
        sys.stdout.write(json.dumps(response) + "\n")


if __name__ == "__main__":
    if sys.argv[1:] == ["serve"]:
        serve()
    elif sys.argv[1:] == ["client"]:
        try:
            client()
        except Exception:
            sys.stdout.write('{"ok":false,"error":"Runner unavailable"}\n')
            sys.exit(1)
    else:
        sys.exit("Usage: runtime.py serve|client")
