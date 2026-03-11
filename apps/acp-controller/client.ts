import { main } from "./controller.ts";

const exitCode = await main(process.argv.slice(2));
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
