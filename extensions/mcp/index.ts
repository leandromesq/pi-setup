/**
 * MCP Client Extension for Pi
 *
 * Connects to MCP servers via stdio transport and exposes their tools,
 * resources, and prompts as Pi tools.
 *
 * Configuration:
 *   Project:  .pi/mcp-servers.json
 *   Global:   ~/.pi/agent/mcp-servers.json
 *
 * Each server entry:
 *   {
 *     "name": "my-server",
 *     "command": "node",
 *     "args": ["path/to/server.js"],
 *     "env": { "KEY": "value" }  // optional
 *   }
 *
 * Tools are registered as: mcp__<server>__<tool>
 * Resources are available via: mcp_read_resource
 * Prompts are available via: mcp_get_prompt
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ── Types ──────────────────────────────────────────────────────────────────────

interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type McpMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface McpServerState {
  config: McpServerConfig;
  proc: ChildProcess | null;
  nextId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  connected: boolean;
  serverInfo?: { name: string; version: string };
  buffer: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function readConfigs(cwd: string): McpServerConfig[] {
  const configs: McpServerConfig[] = [];
  const globalConfig = path.join(os.homedir(), ".pi", "agent", "mcp-servers.json");
  const projectConfig = path.join(cwd, ".pi", "mcp-servers.json");

  for (const configPath of [globalConfig, projectConfig]) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const entries = JSON.parse(raw);
        const list = Array.isArray(entries) ? entries : [entries];
        for (const entry of list) {
          if (entry.name && entry.command) {
            configs.push({
              name: entry.name,
              command: entry.command,
              args: entry.args || [],
              env: entry.env,
            });
          }
        }
      } catch (e) {
        // Skip malformed configs
      }
    }
  }

  return configs;
}

function makeEnv(serverConfig: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (serverConfig.env) {
    Object.assign(env, serverConfig.env);
  }
  return env;
}

// ── MCP Client Logic ───────────────────────────────────────────────────────────

function connectServer(config: McpServerConfig): McpServerState {
  const state: McpServerState = {
    config,
    proc: null,
    nextId: 1,
    pending: new Map(),
    tools: [],
    resources: [],
    prompts: [],
    connected: false,
    buffer: "",
  };

  const env = makeEnv(config);

  const proc = spawn(config.command, config.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    shell: process.platform === "win32",
  });

  state.proc = proc;

  // Read JSON-RPC messages from stdout, one per line
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    try {
      const msg: McpMessage = JSON.parse(line);
      handleMessage(state, msg);
    } catch {
      // Skip non-JSON lines (e.g., debug output)
    }
  });

  proc.stderr?.on("data", (_chunk: Buffer) => {
    // MCP servers should not write to stderr for protocol messages.
    // We silently consume it; some servers write logs here.
  });

  proc.on("exit", (code: number | null, signal: string | null) => {
    state.connected = false;
    // Reject all pending requests
    for (const [, pending] of state.pending) {
      pending.reject(new Error(`Server ${config.name} exited with code ${code} signal ${signal}`));
    }
    state.pending.clear();
  });

  proc.on("error", (err: Error) => {
    state.connected = false;
    for (const [, pending] of state.pending) {
      pending.reject(err);
    }
    state.pending.clear();
  });

  return state;
}

function sendRequest(state: McpServerState, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!state.proc || state.proc.exitCode !== null) {
      reject(new Error(`Server ${state.config.name} is not running`));
      return;
    }

    const id = state.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    state.pending.set(id, { resolve, reject });

    const line = JSON.stringify(request) + "\n";
    state.proc.stdin!.write(line, (err) => {
      if (err) {
        state.pending.delete(id);
        reject(err);
      }
    });
  });
}

function sendNotification(state: McpServerState, method: string, params?: Record<string, unknown>): void {
  if (!state.proc || state.proc.exitCode !== null) return;
  const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
  const line = JSON.stringify(notification) + "\n";
  state.proc.stdin!.write(line);
}

function handleMessage(state: McpServerState, msg: McpMessage): void {
  if ("id" in msg && ("result" in msg || "error" in msg)) {
    // Response (success or error)
    const pending = state.pending.get(msg.id);
    if (pending) {
      state.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(`MCP error [${msg.error.code}]: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  } else if ("id" in msg && "method" in msg) {
    // Request from server (we don't handle server-initiated requests yet)
    // Could handle sampling/createMessage, etc.
  } else if ("method" in msg) {
    // Notification from server
    // Could handle notifications/progress, etc.
  }
}

// ── Server Lifecycle ───────────────────────────────────────────────────────────

async function initializeServer(state: McpServerState): Promise<void> {
  const result = (await sendRequest(state, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
    clientInfo: {
      name: "pi-mcp-client",
      version: "1.0.0",
    },
  })) as Record<string, unknown>;

  state.serverInfo = {
    name: (result.serverInfo as Record<string, string>)?.name || state.config.name,
    version: (result.serverInfo as Record<string, string>)?.version || "unknown",
  };

  sendNotification(state, "notifications/initialized", {});

  // Discover tools
  try {
    const toolsResult = (await sendRequest(state, "tools/list", {})) as { tools?: McpTool[] };
    state.tools = toolsResult.tools || [];
  } catch {
    state.tools = [];
  }

  // Discover resources
  try {
    const resourcesResult = (await sendRequest(state, "resources/list", {})) as { resources?: McpResource[] };
    state.resources = resourcesResult.resources || [];
  } catch {
    state.resources = [];
  }

  // Discover prompts
  try {
    const promptsResult = (await sendRequest(state, "prompts/list", {})) as { prompts?: McpPrompt[] };
    state.prompts = promptsResult.prompts || [];
  } catch {
    state.prompts = [];
  }

  state.connected = true;
}

function shutdownServer(state: McpServerState): void {
  state.connected = false;
  if (state.proc) {
    state.proc.kill();
    state.proc = null;
  }
}

// ── Schema Conversion ──────────────────────────────────────────────────────────

/**
 * Converts a JSON Schema object from MCP to TypeBox-compatible shape.
 * Simple conversion: maps JSON Schema types to TypeBox types.
 * We use a flat object approach and let the LLM fill in args based on description.
 */
function mcpSchemaToTypeBoxParams(tool: McpTool) {
  const properties: Record<string, unknown> = {};

  if (tool.inputSchema?.properties) {
    for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
      const propSchema = prop as Record<string, unknown>;
      const propType = propSchema.type as string;
      const description = propSchema.description as string | undefined;
      const isRequired =
        Array.isArray(tool.inputSchema.required) &&
        tool.inputSchema.required.includes(key);

      // Build the base type with description if available
      const opts = description ? { description } : {};

      let fieldType: unknown;
      if (propType === "string") {
        fieldType = Type.String(opts);
      } else if (propType === "number" || propType === "integer") {
        fieldType = Type.Number(opts);
      } else if (propType === "boolean") {
        fieldType = Type.Boolean(opts);
      } else if (propType === "array") {
        fieldType = Type.Array(Type.Unknown(), opts);
      } else {
        fieldType = Type.Unknown(opts);
      }

      // All MCP tool parameters are registered as optional in Pi.
      // The LLM fills in needed values based on the description field.
      // This avoids fragile TypeBox internal unwrapping for required fields.
      properties[key] = Type.Optional(fieldType as any);
    }
  }

  return Type.Object(properties);
}

// ── Safe tool name ─────────────────────────────────────────────────────────────

function mcpToolName(serverName: string, toolName: string): string {
  // Sanitize: replace non-alphanumeric with underscore, lowercase
  const safeServer = serverName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  const safeTool = toolName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  return `mcp__${safeServer}__${safeTool}`;
}

// ── Extension ──────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const servers: Map<string, McpServerState> = new Map();

  // ── Initialize on session start ────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const configs = readConfigs(ctx.cwd);

    // Clean up any existing connections
    for (const [, state] of servers) {
      shutdownServer(state);
    }
    servers.clear();

    for (const config of configs) {
      try {
        const state = connectServer(config);
        await initializeServer(state);
        servers.set(config.name, state);

        if (state.tools.length > 0) {
          ctx.ui.notify(
            `MCP "${config.name}": ${state.tools.length} tool(s), ${state.resources.length} resource(s), ${state.prompts.length} prompt(s) loaded`,
            "info"
          );
        }
      } catch (err: any) {
        ctx.ui.notify(`MCP "${config.name}" failed to initialize: ${err.message}`, "error");
      }
    }

    // Register tools from all connected servers
    registerMcpTools(pi, servers);
  });

  // ── Cleanup on shutdown ────────────────────────────────────────────────────
  pi.on("session_shutdown", async () => {
    for (const [, state] of servers) {
      shutdownServer(state);
    }
    servers.clear();
  });

  // ── MCP status command ─────────────────────────────────────────────────────
  pi.registerCommand("mcp", {
    description: "Show MCP server status and available tools",
    handler: async (_args, ctx) => {
      if (servers.size === 0) {
        ctx.ui.notify(
          "No MCP servers configured. Add a .pi/mcp-servers.json file with server configurations.",
          "info"
        );
        return;
      }

      let lines: string[] = [];
      for (const [, state] of servers) {
        const status = state.connected ? "connected" : "disconnected";
        const info = state.serverInfo
          ? ` (${state.serverInfo.name} v${state.serverInfo.version})`
          : "";
        lines.push(`## ${state.config.name} [${status}]${info}`);

        if (state.tools.length > 0) {
          lines.push("  Tools:");
          for (const tool of state.tools) {
            lines.push(`    - ${tool.name}: ${tool.description || "(no description)"}`);
          }
        }

        if (state.resources.length > 0) {
          lines.push("  Resources:");
          for (const res of state.resources) {
            lines.push(`    - ${res.name} (${res.uri})`);
          }
        }

        if (state.prompts.length > 0) {
          lines.push("  Prompts:");
          for (const prompt of state.prompts) {
            lines.push(`    - ${prompt.name}: ${prompt.description || "(no description)"}`);
          }
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Global read-resource tool ──────────────────────────────────────────────
  pi.registerTool({
    name: "mcp_read_resource",
    label: "MCP Read Resource",
    description:
      "Read a resource from a connected MCP server. Use /mcp to see available resources.",
    promptSnippet: "Read a resource from an MCP server",
    promptGuidelines: [
      "Use mcp_read_resource when the user asks to fetch data exposed by an MCP server, such as documentation, database schemas, or file contents managed by the server.",
    ],
    parameters: Type.Object({
      server: Type.String({ description: "MCP server name (as configured in mcp-servers.json)" }),
      uri: Type.String({ description: "Resource URI to read" }),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      const state = servers.get(params.server as string);
      if (!state) {
        return {
          content: [
            {
              type: "text",
              text: `Error: MCP server "${params.server}" not found or not connected.`,
            },
          ],
          details: { error: "server_not_found" },
        };
      }

      if (!state.connected) {
        return {
          content: [
            {
              type: "text",
              text: `Error: MCP server "${params.server}" is not connected.`,
            },
          ],
          details: { error: "server_disconnected" },
        };
      }

      try {
        const result = (await sendRequest(state, "resources/read", {
          uri: params.uri,
        })) as { contents?: Array<{ uri: string; mimeType?: string; text?: string }> };

        const texts =
          result.contents?.map((c) => c.text || `[binary: ${c.mimeType}]`).join("\n") ||
          "Empty resource";
        return {
          content: [{ type: "text", text: texts }],
          details: { server: params.server, uri: params.uri },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading resource: ${err.message}` }],
          details: { error: "read_error", message: err.message },
        };
      }
    },
  });

  // ── Global get-prompt tool ─────────────────────────────────────────────────
  pi.registerTool({
    name: "mcp_get_prompt",
    label: "MCP Get Prompt",
    description:
      "Retrieve a prompt template from a connected MCP server. Use /mcp to see available prompts.",
    promptSnippet: "Get an MCP server prompt template",
    promptGuidelines: [
      "Use mcp_get_prompt when the user asks to use a prompt template from an MCP server.",
    ],
    parameters: Type.Object({
      server: Type.String({ description: "MCP server name (as configured in mcp-servers.json)" }),
      prompt: Type.String({ description: "Prompt name to retrieve" }),
    }),
    async execute(_callId, params, _signal, _onUpdate, _ctx) {
      const state = servers.get(params.server as string);
      if (!state || !state.connected) {
        return {
          content: [
            {
              type: "text",
              text: `Error: MCP server "${params.server}" not found or not connected.`,
            },
          ],
          details: { error: "server_not_found" },
        };
      }

      try {
        const result = (await sendRequest(state, "prompts/get", {
          name: params.prompt,
        })) as { messages?: Array<{ role: string; content: { type: string; text?: string } }> };

        const texts =
          result.messages
            ?.filter((m) => m.role === "user")
            .map((m) => m.content?.text || "")
            .join("\n") || "Empty prompt";
        return {
          content: [{ type: "text", text: texts }],
          details: { server: params.server, prompt: params.prompt },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error getting prompt: ${err.message}` }],
          details: { error: "get_error", message: err.message },
        };
      }
    },
  });
}

// ── Dynamic Tool Registration ──────────────────────────────────────────────────

function registerMcpTools(pi: ExtensionAPI, servers: Map<string, McpServerState>): void {
  for (const [, state] of servers) {
    if (!state.connected) continue;

    for (const tool of state.tools) {
      const piToolName = mcpToolName(state.config.name, tool.name);
      const schema = mcpSchemaToTypeBoxParams(tool);

      pi.registerTool({
        name: piToolName,
        label: `MCP: ${state.config.name}/${tool.name}`,
        description: `[MCP: ${state.config.name}] ${tool.description || tool.name}`,
        promptSnippet: `${tool.name} (via MCP server ${state.config.name})`,
        promptGuidelines: [
          `Use ${piToolName} when working with ${state.config.name} tools. ${tool.description || ""}`,
        ],
        parameters: schema,
        async execute(_callId, params, _signal, _onUpdate, _ctx) {
          if (!state.connected) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: MCP server "${state.config.name}" is no longer connected.`,
                },
              ],
              details: { error: "server_disconnected" },
            };
          }

          try {
            const result = (await sendRequest(state, "tools/call", {
              name: tool.name,
              arguments: params,
            })) as {
              content?: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
              isError?: boolean;
            };

            const textContent =
              result.content
                ?.map((c) => c.text || `[${c.type}: ${c.mimeType}]`)
                .join("\n") || "Tool executed with no output.";

            return {
              content: [{ type: "text", text: textContent }],
              details: {
                server: state.config.name,
                tool: tool.name,
                isError: result.isError || false,
              },
            };
          } catch (err: any) {
            return {
              content: [{ type: "text", text: `MCP tool error: ${err.message}` }],
              details: {
                error: "tool_execution_error",
                message: err.message,
                server: state.config.name,
                tool: tool.name,
              },
            };
          }
        },
      });
    }
  }
}
