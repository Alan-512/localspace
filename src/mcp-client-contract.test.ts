import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { standardToolError } from "./server.js";

const server = new McpServer({
  name: "localspace-contract-test-server",
  version: "1.0.0",
});

const outputSchema = {
  result: z.string(),
  scope: z.string(),
};

server.registerTool(
  "contract_success",
  { inputSchema: {}, outputSchema },
  async () => ({
    content: [{ type: "text" as const, text: "success" }],
    structuredContent: {
      result: "success",
      scope: "test",
    },
  }),
);

server.registerTool(
  "contract_error",
  { inputSchema: {}, outputSchema },
  async () => standardToolError(
    "contract_error",
    "CONTRACT_FAILURE",
    "Expected contract failure.",
    {
      recoverable: true,
      retryable: false,
      nextAction: "Correct the test input.",
    },
  ),
);

const client = new Client({
  name: "localspace-contract-test-client",
  version: "1.0.0",
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();

  const success = await client.callTool({
    name: "contract_success",
    arguments: {},
  }) as CallToolResult;
  assert.equal(success.isError, undefined);
  assert.deepEqual(success.structuredContent, {
    result: "success",
    scope: "test",
  });

  const failure = await client.callTool({
    name: "contract_error",
    arguments: {},
  }) as CallToolResult;
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent, undefined);
  const error = (failure._meta as { error?: Record<string, unknown> } | undefined)?.error;
  assert.equal(error?.code, "CONTRACT_FAILURE");
  assert.equal(error?.recoverable, true);
  assert.match(
    failure.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
    /Tool error \[CONTRACT_FAILURE\]/,
  );
} finally {
  await client.close();
  await server.close();
}
