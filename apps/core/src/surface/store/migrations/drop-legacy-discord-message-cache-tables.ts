import { Database } from "bun:sqlite";
import { getCoreConfig, resolveDiscordDbPath } from "@stanley2058/lilac-utils";

export function dropLegacyDiscordMessageCacheTables(db: Database) {
  db.run("DROP INDEX IF EXISTS idx_discord_messages_channel_ts;");
  db.run("DROP INDEX IF EXISTS idx_discord_messages_channel_author_ts;");
  db.run("DROP INDEX IF EXISTS idx_discord_reactions_msg;");

  db.run("DROP TABLE IF EXISTS discord_messages;");
  db.run("DROP TABLE IF EXISTS discord_message_reactions;");
}

async function main() {
  const cfg = await getCoreConfig();
  const dbPath = resolveDiscordDbPath(cfg);

  const db = new Database(dbPath);
  dropLegacyDiscordMessageCacheTables(db);
  db.close();

  console.log(`Dropped legacy Discord cache tables from ${dbPath}`);
}

if (import.meta.main) {
  await main();
}
