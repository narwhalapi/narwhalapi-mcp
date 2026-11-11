# Changelog

## 0.1.1 — 2026-11-11

- README lists the product's key pages as full URLs. No code change.
- Cursor plugin: `.cursor-plugin/plugin.json` and `mcp.json` connect Cursor to the
  hosted server with Narwhal sign-in. No code change.

## 0.1.0 — 2026-10-09

- Stdio bridge for MCP clients that launch local commands with `npx`.
- Requests forwarded to the hosted MCP server with Bearer authentication.
- Tool list supplied by the server; no local tool definitions.
- Configurable base URL and timeout, with logs sent only to stderr.
