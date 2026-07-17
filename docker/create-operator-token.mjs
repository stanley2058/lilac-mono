import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";

const operatorToken = randomBytes(32).toString("base64url");
const operatorTokenSha256 = createHash("sha256").update(operatorToken).digest("hex");

mkdirSync("/run/lilac", { recursive: true, mode: 0o755 });
const temporaryTokenPath = `/run/lilac/operator-token.${process.pid}`;
writeFileSync(temporaryTokenPath, operatorToken, { mode: 0o600 });
renameSync(temporaryTokenPath, "/run/lilac/operator-token");

process.stdout.write(operatorTokenSha256);
