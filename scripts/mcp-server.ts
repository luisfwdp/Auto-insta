import { createLocalMcpServer } from "@/lib/mcp/local-server";

const DEFAULT_PORT = 3333;

function configuredPort(value: string | undefined) {
  if (value === undefined || value === "") return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) {
    throw new Error("PINGCHAT_MCP_PORT must be a numeric TCP port");
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("PINGCHAT_MCP_PORT must be between 1024 and 65535");
  }
  return port;
}

async function main() {
  const localServer = createLocalMcpServer();
  const address = await localServer.listen(
    configuredPort(process.env.PINGCHAT_MCP_PORT)
  );

  console.info(
    JSON.stringify({
      level: "info",
      event: "mcp_server_started",
      mcpUrl: address.mcpUrl,
      healthUrl: address.healthUrl,
    })
  );

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(
      JSON.stringify({ level: "info", event: "mcp_server_stopping", signal })
    );
    try {
      await localServer.close();
    } catch (error) {
      process.exitCode = 1;
      console.error(
        JSON.stringify({
          level: "error",
          event: "mcp_server_shutdown_failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
        })
      );
    }
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  process.exitCode = 1;
  console.error(
    JSON.stringify({
      level: "error",
      event: "mcp_server_start_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    })
  );
});
