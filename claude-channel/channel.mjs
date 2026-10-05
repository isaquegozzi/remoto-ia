import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const PORT = Number(process.env.REMOTO_CLAUDE_CHANNEL_PORT || 8788);
const TOKEN = process.env.REMOTO_CLAUDE_CHANNEL_TOKEN || '';
const listeners = new Set();
let nextId = 1;

function send(payload) {
  const text = JSON.stringify(payload);
  for (const res of [...listeners]) {
    try { res.write(`data: ${text}\n\n`); } catch { listeners.delete(res); }
  }
}

const mcp = new Server(
  { name: 'remoto-ia', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {}
      },
      tools: {}
    },
    instructions: 'Mensagens chegam como <channel source="remoto-ia" chat_id="...">. Execute a solicitação e use a ferramenta reply para enviar a resposta final de volta, preservando o chat_id.'
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Enviar uma resposta final para a interface Remoto IA',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' }
      },
      required: ['chat_id', 'text']
    }
  }]
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') throw new Error(`Ferramenta desconhecida: ${req.params.name}`);
  const { chat_id, text } = req.params.arguments || {};
  send({ type: 'reply', chat_id, text });
  return { content: [{ type: 'text', text: 'Resposta enviada ao Remoto IA.' }] };
});

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string()
  })
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  send({ type: 'permission_request', ...params });
});

await mcp.connect(new StdioServerTransport());

const permissionRe = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/events') {
    if (TOKEN && req.headers['x-remoto-token'] !== TOKEN) return res.writeHead(403).end('forbidden');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n'); listeners.add(res); req.on('close', () => listeners.delete(res)); return;
  }
  if (req.method !== 'POST') return res.writeHead(404).end('not found');
  if (!TOKEN || req.headers['x-remoto-token'] !== TOKEN) return res.writeHead(403).end('forbidden');
  let body=''; for await (const c of req) body += c;
  const m = permissionRe.exec(body);
  if (m) {
    await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: m[2].toLowerCase(), behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny' } });
    return res.end('verdict recorded');
  }
  const chat_id = String(nextId++);
  await mcp.notification({ method: 'notifications/claude/channel', params: { content: body, meta: { chat_id } } });
  res.end(JSON.stringify({ ok: true, chat_id }));
});
server.listen(PORT, '127.0.0.1');
