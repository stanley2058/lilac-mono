import { expect, it } from "bun:test";
import { buildRemoteScript } from "../../src/ssh/ssh-exec";

it("keeps heredoc markers inside command data", async () => {
  const command = "cat <<'DATA'\n__LILAC_CMD__\nDATA";
  const script = buildRemoteScript({ cmd: command, cwd: "/tmp" });
  expect(script).not.toContain(command);
  const child = Bun.spawn(["bash", "--noprofile", "--norc", "-s"], {
    stdin: new Blob([script]),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(child.stdout).text()).toBe("__LILAC_CMD__\n");
  expect(await child.exited).toBe(0);
});
