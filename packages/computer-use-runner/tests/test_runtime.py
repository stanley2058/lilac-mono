import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from runtime import MAX_REQUEST, Runtime, read_message


class Driver:
    async def list_tools_json(self):
        return '{"tools":[{"name":"get_desktop_state","inputSchema":{"type":"object"}}]}'

    async def call_tool(self, name, arguments_json):
        return SimpleNamespace(text="desktop", images=[SimpleNamespace(mime_type="image/png", data_base64="aGVsbG8=")], is_error=False)


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runtime = Runtime(Driver())

    async def execute(self, code):
        return await self.runtime.handle({"operation": "execute", "code": code})

    async def test_namespace_and_generation_survive_calls(self):
        first = await self.execute("answer = 40")
        second = await self.execute("answer += 2\nprint(answer)")
        self.assertEqual(first["generation"], second["generation"])
        self.assertEqual(second["content"][0]["text"], "42\n")

    async def test_async_sdk_images_and_user_exceptions(self):
        result = await self.execute('display(await cua("get_desktop_state"))')
        self.assertFalse(result["isError"])
        self.assertEqual(result["content"][1]["type"], "image")
        failed = await self.execute('print("before")\nraise ValueError("bad input")')
        self.assertTrue(failed["isError"])
        self.assertEqual(failed["content"][0]["text"], "before\n")
        self.assertIn("ValueError", failed["content"][1]["text"])
        self.assertFalse((await self.execute('print("after")'))["isError"])

    async def test_limits_and_nonserializable_last_expression(self):
        result = await self.execute('print("a" * 70000)')
        self.assertTrue(result["isError"])
        result = await self.execute('for i in range(9): display(b"image")')
        self.assertTrue(result["isError"])
        self.assertEqual(sum(part["type"] == "image" for part in result["content"]), 8)
        self.assertFalse((await self.execute("object()"))["isError"])

    async def test_inventory_uses_installed_driver(self):
        result = await self.execute("print(await cua_tools())")
        self.assertIn("get_desktop_state", result["content"][0]["text"])
        schema = await self.execute('print(await cua_tools("get_desktop_state"))')
        self.assertIn("inputSchema", schema["content"][0]["text"])

    async def test_info_does_not_reset_namespace(self):
        await self.execute("a = 3")
        self.assertTrue((await self.runtime.handle({"operation": "info"}))["ok"])
        self.assertEqual((await self.execute("print(a)"))["content"][0]["text"], "3\n")

    async def test_background_python_tasks_stop_before_next_call(self):
        result = await self.execute('''
import asyncio
event = asyncio.Event()
async def later():
    await event.wait()
    print("leaked")
background = asyncio.create_task(later())
''')
        self.assertFalse(result["isError"])
        following = await self.execute('event.set()\nprint(background.cancelled())')
        self.assertEqual(following["content"][0]["text"], "True\n")

    async def test_gather_failure_cancels_remaining_children(self):
        result = await self.execute('''
import asyncio
event = asyncio.Event()
async def fail():
    raise ValueError("failed child")
async def later():
    await event.wait()
    print("leaked")
background = asyncio.create_task(later())
await asyncio.gather(fail(), background)
''')
        self.assertTrue(result["isError"])
        following = await self.execute('event.set()\nprint(background.cancelled())')
        self.assertEqual(following["content"][0]["text"], "True\n")

    async def test_health_requires_capabilities(self):
        with patch.object(self.runtime, "cua", return_value=SimpleNamespace(is_error=True)):
            self.assertFalse((await self.runtime.handle({"operation": "health"}))["ok"])

    async def test_invalid_requests(self):
        for request in (None, {}, {"operation": "execute", "code": 42}):
            self.assertFalse((await self.runtime.handle(request))["ok"])

    def test_frame_bounds(self):
        self.assertEqual(read_message(io.BytesIO(b'{"operation":"info"}\n'), MAX_REQUEST), {"operation": "info"})
        for value in (b"{}", b" " * MAX_REQUEST + b"\n"):
            with self.assertRaises(ValueError):
                read_message(io.BytesIO(value), MAX_REQUEST)


if __name__ == "__main__":
    unittest.main()
