import { acquireDatabaseLock } from "../../src/main";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("Expected a database path");
}

const lock = await acquireDatabaseLock(databasePath);

process.once("SIGINT", () => {
  void lock.release().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
});

process.stdout.write("ready\n");
setInterval(() => {}, 60_000);
