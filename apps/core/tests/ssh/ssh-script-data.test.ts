import { expect, it } from "bun:test";
import { buildRemoteScript } from "../../src/ssh/ssh-exec";

it("keeps heredoc markers inside command data", async () => {
  const command = "cat <<'DATA'\n__LILAC_CMD__\nDATA";
  const script = buildRemoteScript({ cmd: command, cwd: "/tmp" });
  expect(script).not.toContain(command);
  // Core keeps stdin open for the whole call; closing it would cancel the command.
  const child = Bun.spawn(["bash", "--noprofile", "--norc", "-s"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(script);
  await child.stdin.flush();
  expect(await new Response(child.stdout).text()).toBe("__LILAC_CMD__\n");
  expect(await child.exited).toBe(0);
  await child.stdin.end();
});
