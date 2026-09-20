import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SIRUS_VERSION } from '../../version';
import { errorMessage } from './arguments';
import { isVisible, toolRegistry, visibleTools } from './index';
import type { SubagentHost, ToolAudience } from './types';

// The one MCP server inside the Sirus process. Every participant runtime
// lists it in `session/new`, so the memory and delegation tools reach Claude
// and Codex the same way. It listens on loopback at an ephemeral port; a
// request carries a per-session bearer token and the requester's name, so a
// tool call knows which session it runs in and who issued it.

export interface ToolSessionBinding {
  // Where this session's tool calls run.
  directory: string;
  // Live lookup, so /memory on and off apply to the next request.
  memoryEnabled: () => boolean;
  // The participant's own delegation port; null when it may not delegate.
  hostFor(participant: string): SubagentHost | null;
}

interface ToolSession {
  binding: ToolSessionBinding;
  token: string;
}

const sessions = new Map<string, ToolSession>();

// Registering again replaces the binding and keeps the token, so the runtimes
// already holding it in their headers stay valid.
export function registerToolSession(sessionId: string, binding: ToolSessionBinding): void {
  const token = sessions.get(sessionId)?.token ?? randomBytes(32).toString('base64url');
  sessions.set(sessionId, { binding, token });
}

export function unregisterToolSession(sessionId: string): void {
  sessions.delete(sessionId);
}

let server: http.Server | null = null;
let listening: Promise<string> | null = null;

// What a runtime lists in `session/new`: the URL and the two headers that
// identify the caller. The requester is the participant's name, or
// `subagent:<id>` for a worker. Starts the server on first use.
export async function sirusMcpServerEntry(
  sessionId: string,
  requester: string,
): Promise<{ name: 'sirus'; url: string; headers: { name: string; value: string }[] }> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Tool session ${sessionId} is not registered`);
  listening ??= listen();
  return {
    name: 'sirus',
    url: await listening,
    headers: [
      { name: 'Authorization', value: `Bearer ${session.token}` },
      { name: 'X-Sirus-Requester', value: requester },
    ],
  };
}

// App shutdown. Idempotent; the next entry request starts a fresh server.
export function stopSirusMcpServer(): void {
  server?.close();
  server?.closeAllConnections();
  server = null;
  listening = null;
}

function listen(): Promise<string> {
  const created = http.createServer((req, res) => { void handle(req, res); });
  // Never the reason the process stays alive: the app stops the server when
  // Ink exits, and an exit that skips that must not hang on it.
  created.unref();
  server = created;
  return new Promise((resolve, reject) => {
    created.once('error', reject);
    created.listen(0, '127.0.0.1', () => {
      const { port } = created.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Stateless: every request is a POST carrying its own message. The GET
  // notification stream and the DELETE that ends a session have nothing here
  // to attach to.
  if (req.method !== 'POST') return refuse(res, 405, 'Method not allowed.');
  const session = sessionFor(req.headers.authorization);
  if (!session) return refuse(res, 401, 'Unauthorized: unknown or missing bearer token.');
  const requester = req.headers['x-sirus-requester'];
  if (typeof requester !== 'string' || !requester) return refuse(res, 400, 'Missing X-Sirus-Requester header.');

  // A fresh server per request: nothing is kept between calls, and the tool
  // list is computed as the memory switch stands right now.
  const mcp = serverFor(session.binding, requester);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  // Closing aborts the handlers still running, so a call whose caller went
  // away stops waiting (CheckAgent with wait true).
  res.on('close', () => { void mcp.close(); });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) refuse(res, 500, errorMessage(error));
  }
}

function refuse(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function sessionFor(authorization: string | undefined): ToolSession | null {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (!token) return null;
  for (const session of sessions.values()) {
    if (tokenMatches(session.token, token)) return session;
  }
  return null;
}

// Constant time, so a wrong token does not say how wrong it was.
function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MEMORY_DISABLED = 'Memory access is disabled. Use /memory on to enable it.';

function serverFor(binding: ToolSessionBinding, requester: string): Server {
  // A worker gets the subagent audience and no delegation port, whoever
  // spawned it: a subagent cannot spawn a grandchild.
  const worker = requester.startsWith('subagent:');
  const audience: ToolAudience = worker ? { subagent: true } : {};
  const subagents = worker ? null : binding.hostFor(requester);

  const mcp = new Server({ name: 'sirus', version: SIRUS_VERSION }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools(toolRegistry, audience, binding.memoryEnabled).map(tool => ({
      name: tool.name,
      description: tool.description,
      // The argument schemas are JSON Schema as written; every argument is
      // declared required, as every provider declared them before.
      inputSchema: { type: 'object', properties: tool.args, required: Object.keys(tool.args) },
    })),
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    const tool = toolRegistry.find(candidate => candidate.name === params.name);
    // A switched-off capability is named as such, so the model is told how
    // to get it back rather than that the tool does not exist.
    if (tool?.requires === 'memory' && !binding.memoryEnabled()) return failure(MEMORY_DISABLED);
    // Otherwise a tool this caller was never offered does not exist for it:
    // a subagent asking for SpawnAgent is refused here by the same predicate
    // that hid it from the listing, not by the listing alone.
    if (!tool || !isVisible(tool, audience, binding.memoryEnabled)) {
      return failure(`Unknown tool: ${params.name}`);
    }
    try {
      const result = await tool.run(params.arguments ?? {}, {
        directory: binding.directory,
        callId: randomUUID(),
        signal: extra.signal,
        ...(subagents ? { subagents } : {}),
      });
      return { content: [{ type: 'text', text: formatToolResult(result) }] };
    } catch (error) {
      return failure(errorMessage(error));
    }
  });
  return mcp;
}

function failure(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function formatToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return 'Tool completed successfully.';
  return JSON.stringify(result) ?? String(result);
}
