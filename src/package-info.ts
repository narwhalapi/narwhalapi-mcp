import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { name: string; version: string };

export const PACKAGE_NAME = packageJson.name;
export const PACKAGE_VERSION = packageJson.version;

/**
 * Wire identity for the User-Agent and MCP clientInfo. It is a literal, not
 * `packageJson.name`, so a future rename on npm never reads as a new client in
 * API analytics. Change it only when the client's behaviour changes.
 */
export const CLIENT_ID = "narwhalapi-mcp";
