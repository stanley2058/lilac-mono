import { expect, test } from "bun:test";

test("the test preload keeps the model catalog refresh off the network", async () => {
  const response = await fetch("https://models.dev/api.json");
  expect(response.status).toBe(503);
});
