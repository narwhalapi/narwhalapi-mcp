# Narwhal API MCP bridge

`@narwhalapi/mcp` connects MCP clients that launch local commands to the hosted
Narwhal API MCP server. It runs as a stdio bridge and forwards every request to
`https://api.narwhalapi.com/mcp`, using the API key as a Bearer token. The bridge
holds no tools itself; the tool list comes from the server.

## Install

Requires Node.js 20 or newer.

```sh
npm install @narwhalapi/mcp
```

## Quickstart

Add this configuration to an MCP client that supports local commands:

```json
{
  "mcpServers": {
    "narwhal": {
      "command": "npx",
      "args": ["-y", "@narwhalapi/mcp"],
      "env": {
        "NARWHAL_API_KEY": "your-key"
      }
    }
  }
}
```

Replace `your-key` with your API key. The MCP client launches the bridge with
`npx` and communicates with it over stdio. Requests then go to the hosted
server with that key.

## Configuration

`NARWHAL_API_KEY` is required. Without it, the bridge exits with a message.
`NARWHAL_BASE_URL` defaults to `https://api.narwhalapi.com`.
`NARWHAL_TIMEOUT` sets the request timeout in milliseconds and defaults to
`10000`. Logs go to stderr only, leaving stdout for MCP communication.

## Remote connection

MCP clients that support remote servers can connect directly to
`https://api.narwhalapi.com/mcp`. Configure the header
`Authorization: Bearer <key>` with your API key. A direct connection uses the
hosted server without launching a local bridge. Choose the connection method
supported by your MCP client.

Links: [Documentation](https://narwhalapi.com/docs/mcp)

MIT licensed
