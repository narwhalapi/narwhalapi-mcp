#!/usr/bin/env node

// @narwhalapi/mcp: stdio to Streamable HTTP bridge for the Narwhal API Model
// Context Protocol server. Thin proxy: the bridge holds no tool definitions,
// schemas or business logic. It opens a stdio MCP server for the local client
// and forwards every JSON-RPC method to https://api.narwhalapi.com/mcp with the
// caller's API key as a Bearer token.
//
// Docs: https://narwhalapi.com/docs/mcp
//
// Design posture:
//   - Logs only to stderr. Stdout is the stdio MCP channel and must stay
//     clean of anything that isn't framed JSON-RPC.
//   - No telemetry. No retry storms. One forwarded call per client call.
//   - HTTP-level failures (401 / 403 / 429) surface as MCP errors so the
//     calling agent gets a descriptive message instead of silence.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CLIENT_ID, PACKAGE_NAME, PACKAGE_VERSION } from "./package-info.js";

const DEFAULT_BASE_URL = "https://api.narwhalapi.com";

type Stderr = (message: string) => void;

const log: Stderr = (message) => {
  // Trailing newline for line-buffered stderr consumers (desktop MCP clients
  // show MCP server stderr in their logs).
  process.stderr.write(`[${PACKAGE_NAME}] ${message}\n`);
};

function resolveEndpoint(base: string): URL {
  let trimmed = base.trim().replace(/\/+$/, "");
  if (!trimmed) trimmed = DEFAULT_BASE_URL;
  if (!trimmed.endsWith("/mcp")) {
    trimmed = trimmed + "/mcp";
  }
  return new URL(trimmed);
}

// Wraps an upstream call so HTTP failures and native errors surface as
// typed MCP errors to the stdio client.
async function forward<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof McpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/\b401\b/.test(message)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unauthorized (${operation}) — check that NARWHAL_API_KEY is a valid API key. See https://narwhalapi.com/docs/mcp`,
      );
    }
    if (/\b403\b/.test(message)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Forbidden (${operation}) — your plan does not include this data. Plans at https://narwhalapi.com/pricing`,
      );
    }
    if (/\b429\b/.test(message)) {
      throw new McpError(
        ErrorCode.InternalError,
        `Rate limited (${operation}) — back off and retry. Plan limits at https://narwhalapi.com/pricing`,
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Upstream error (${operation}): ${message}`,
    );
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.NARWHAL_API_KEY;

  const baseUrl = process.env.NARWHAL_BASE_URL ?? DEFAULT_BASE_URL;
  const endpoint = resolveEndpoint(baseUrl);

  const timeoutMs = Number.parseInt(process.env.NARWHAL_TIMEOUT ?? "10000", 10);
  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    log(
      `NARWHAL_TIMEOUT must be a positive integer in milliseconds. Got: ${process.env.NARWHAL_TIMEOUT}`,
    );
    process.exit(1);
    return;
  }

  // Every Narwhal API call needs a key; there is no anonymous mode.
  if (!apiKey) {
    log(
      "NARWHAL_API_KEY is required. Set it in your MCP client config:\n" +
        '  "env": { "NARWHAL_API_KEY": "your-key-here" }\n' +
        "Get a key at https://narwhalapi.com/pricing. The Free plan includes MCP.",
    );
    process.exit(1);
    return;
  }

  const headers: Record<string, string> = {
    "User-Agent": `${CLIENT_ID}/${PACKAGE_VERSION} (stdio-bridge)`,
    Authorization: `Bearer ${apiKey}`,
  };

  // 1. Connect to upstream HTTP MCP.
  const upstream = new Client(
    { name: `${CLIENT_ID}-bridge`, version: PACKAGE_VERSION },
    { capabilities: {} },
  );

  const upstreamTransport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers },
  });

  try {
    // timeoutMs bounds the initialize handshake and, below, every forwarded
    // request — without the option the SDK default (60s) silently applies.
    await upstream.connect(upstreamTransport, { timeout: timeoutMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to connect to ${endpoint.href}: ${message}`);
    if (/\b401\b|\b403\b|invalid_api_key|unauthorized|forbidden/i.test(message)) {
      log(
        "Check that NARWHAL_API_KEY is a valid API key (not a truncated copy).",
      );
    }
    process.exit(1);
    return;
  }

  log(`Connected to ${endpoint.href} (timeout ${timeoutMs}ms).`);

  // 2. Introspect upstream capabilities so the stdio handshake advertises
  //    only what the backend actually supports.
  const serverCapabilities = upstream.getServerCapabilities() ?? {};
  const bridgeCapabilities: Record<string, Record<string, unknown>> = {};
  if (serverCapabilities.tools) bridgeCapabilities.tools = {};
  if (serverCapabilities.resources) bridgeCapabilities.resources = {};
  if (serverCapabilities.prompts) bridgeCapabilities.prompts = {};
  if (serverCapabilities.logging) bridgeCapabilities.logging = {};
  if (serverCapabilities.completions) bridgeCapabilities.completions = {};

  const bridge = new Server(
    { name: "narwhal", version: PACKAGE_VERSION },
    { capabilities: bridgeCapabilities },
  );

  // 3. Wire JSON-RPC method forwarders. One handler per MCP method we
  //    proxy; unsupported methods fall through to the SDK default
  //    (returns MethodNotFound), so unadvertised capabilities stay
  //    honest.
  if (serverCapabilities.tools) {
    bridge.setRequestHandler(ListToolsRequestSchema, async () =>
      forward("tools/list", () => upstream.listTools(undefined, { timeout: timeoutMs })),
    );
    bridge.setRequestHandler(CallToolRequestSchema, async (request) =>
      forward(`tools/call(${request.params.name})`, () =>
        upstream.callTool(request.params, undefined, { timeout: timeoutMs }),
      ),
    );
  }

  if (serverCapabilities.resources) {
    bridge.setRequestHandler(ListResourcesRequestSchema, async () =>
      forward("resources/list", () => upstream.listResources(undefined, { timeout: timeoutMs })),
    );
    bridge.setRequestHandler(ListResourceTemplatesRequestSchema, async () =>
      forward("resources/templates/list", () =>
        upstream.listResourceTemplates(undefined, { timeout: timeoutMs }),
      ),
    );
    bridge.setRequestHandler(ReadResourceRequestSchema, async (request) =>
      forward(`resources/read(${request.params.uri})`, () =>
        upstream.readResource(request.params, { timeout: timeoutMs }),
      ),
    );
  }

  if (serverCapabilities.prompts) {
    bridge.setRequestHandler(ListPromptsRequestSchema, async () =>
      forward("prompts/list", () => upstream.listPrompts(undefined, { timeout: timeoutMs })),
    );
    bridge.setRequestHandler(GetPromptRequestSchema, async (request) =>
      forward(`prompts/get(${request.params.name})`, () =>
        upstream.getPrompt(request.params, { timeout: timeoutMs }),
      ),
    );
  }

  if (serverCapabilities.completions) {
    bridge.setRequestHandler(CompleteRequestSchema, async (request) =>
      forward("completion/complete", () =>
        upstream.complete(request.params, { timeout: timeoutMs }),
      ),
    );
  }

  // 4. Connect stdio transport.
  const stdio = new StdioServerTransport();
  await bridge.connect(stdio);

  // 5. Graceful shutdown — close both transports on SIGINT / SIGTERM so
  //    open SSE streams don't linger after the local client disconnects.
  const shutdown = async (signal: string) => {
    log(`Received ${signal}, shutting down.`);
    try {
      await bridge.close();
    } catch {
      /* noop */
    }
    try {
      await upstream.close();
    } catch {
      /* noop */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log(`Fatal: ${message}`);
  process.exit(1);
});
