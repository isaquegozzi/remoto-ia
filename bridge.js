const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { StateStore } = require('./lib/state-store');
const { CodexAppServer } = require('./lib/codex-app-server');
const { ClaudeCli } = require('./lib/claude-cli');

const ROOT = __dirname;
const PORT = Number(process.env.REMOTO_PORT || 8081);
const HOST_ID = process.env.REMOTO_HOST_ID || os.hostname();
const store = new StateStore(ROOT);
const codex = new CodexAppServer({ cwd: process.cwd() });
const claude = new ClaudeCli({ store, cwd: process.cwd() });
const sseClients = new Set();
let relayStatus = process.env.REMOTO_RELAY_URL ? 'connecting' : 'disabled';

const allowedOrigins = new Set((process.env.REMOTO_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080,http://127.0.0.1:8080')
  .split(',').map(x => x.trim()).filter(Boolean));

function emitEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of [...sseClients]) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
  relay?.event(event);
}

codex.on('event', emitEvent);
codex.on('serverRequest', req => emitEvent({ ...req, approvalMethod: req.method, method: 'approval/request' }));
codex.on('diagnostic', text => emitEvent({ agent: 'codex', method: 'diagnostic', params: { text } }));
codex.on('offline', err => emitEvent({ agent: 'codex', method: 'host/offline', params: { message: err.message } }));
claude.on('event', emitEvent);
claude.on('diagnostic', text => emitEvent({ agent: 'claude', method: 'diagnostic', params: { text } }));

function json(status, body) { return { status, body }; }
function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} é obrigatório.`);
  return value.trim();
}
function extractThread(result) { return result?.thread || result?.data?.thread || result; }

async function codexStatus() {
  try {
    await codex.start();
    const account = await codex.accountRead();
    return { installed: true, ready: true, authenticated: !!(account?.account || account?.email || account?.type || account?.planType), account };
  } catch (err) {
    return { installed: false, ready: false, authenticated: false, error: err.message };
  }
}

async function handleApi(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const pathname = req.path || '/';
  const query = req.query || {};
  const body = req.body || {};

  if (pathname === '/api/status' && method === 'GET') {
    const [codexInfo, claudeInfo] = await Promise.all([codexStatus(), claude.checkInstalled()]);
    return json(200, {
      status: 'online', hostname: HOST_ID, platform: os.platform(), cwd: process.cwd(), relayStatus,
      agents: { codex: codexInfo, claude: { ...claudeInfo, authNote: 'A autenticação é lida por claude auth status no próprio host.' } }
    });
  }

  if (pathname === '/api/codex/login/device' && method === 'POST') {
    const result = await codex.startDeviceLogin();
    return json(200, result);
  }

  if (pathname === '/api/threads' && method === 'GET') {
    const agent = requireString(query.agent, 'agent');
    if (agent === 'claude') return json(200, { data: claude.listThreads() });
    if (agent !== 'codex') return json(400, { error: 'agent inválido' });
    const result = await codex.listThreads(query.cursor || null);
    const list = result?.data || result?.threads || [];
    const decorated = list.map(t => ({ ...t, ...(store.codexMeta[t.id] || {}) }));
    return json(200, { ...result, data: decorated });
  }

  if (pathname === '/api/threads' && method === 'POST') {
    const agent = requireString(body.agent, 'agent');
    const cwd = body.cwd ? path.resolve(body.cwd) : process.cwd();
    const title = (body.title || `Nova tarefa ${agent}`).trim();
    if (agent === 'claude') return json(201, claude.createThread({ cwd, title, model: body.model }));
    if (agent !== 'codex') return json(400, { error: 'agent inválido' });
    const result = await codex.startThread({ cwd, model: body.model });
    const thread = extractThread(result);
    const id = thread?.id || result?.threadId;
    if (!id) throw new Error('Codex não retornou o ID da thread.');
    store.setCodexMeta(id, { id, title, cwd, createdAt: new Date().toISOString() });
    return json(201, { ...thread, ...store.codexMeta[id] });
  }

  if (pathname === '/api/thread' && method === 'GET') {
    const agent = requireString(query.agent, 'agent');
    const id = requireString(query.id, 'id');
    if (agent === 'claude') {
      const thread = claude.getThread(id);
      return thread ? json(200, thread) : json(404, { error: 'Sessão Claude não encontrada.' });
    }
    if (agent !== 'codex') return json(400, { error: 'agent inválido' });
    const result = await codex.readThread(id);
    const thread = extractThread(result);
    return json(200, { ...thread, ...(store.codexMeta[id] || {}) });
  }

  if (pathname === '/api/message' && method === 'POST') {
    const agent = requireString(body.agent, 'agent');
    const threadId = requireString(body.threadId, 'threadId');
    const prompt = requireString(body.prompt, 'prompt');
    if (agent === 'claude') {
      claude.send(threadId, prompt, { model: body.model }).catch(err => emitEvent({ agent: 'claude', method: 'turn/error', params: { threadId, message: err.message } }));
      return json(202, { accepted: true, threadId });
    }
    if (agent !== 'codex') return json(400, { error: 'agent inválido' });
    const result = await codex.send(threadId, prompt, body.sendMode === 'steer' ? 'steer' : 'queue');
    return json(202, result);
  }

  if (pathname === '/api/interrupt' && method === 'POST') {
    const agent = requireString(body.agent, 'agent');
    const threadId = requireString(body.threadId, 'threadId');
    return json(200, agent === 'claude' ? claude.interrupt(threadId) : await codex.interrupt(threadId));
  }

  if (pathname === '/api/approval' && method === 'POST') {
    const agent = requireString(body.agent, 'agent');
    if (agent !== 'codex') return json(501, { error: 'Aprovação remota Claude exige o Channel preview incluído em claude-channel/.' });
    const requestId = body.requestId;
    if (requestId === undefined || requestId === null) return json(400, { error: 'requestId é obrigatório.' });
    const allowed = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
    const decision = allowed.has(body.decision) ? body.decision : 'decline';
    codex.respondServerRequest(requestId, { decision });
    return json(200, { ok: true, decision });
  }

  return json(404, { error: 'Endpoint não encontrado.' });
}

function isAuthorized(req, url) {
  const header = req.headers['x-pairing-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = header || url.searchParams.get('token');
  return token && token === store.token;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-pairing-token');
  return true;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error('Body muito grande.');
  }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const staticFiles = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8']
    };
    const staticPath = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (req.method === 'GET' && staticFiles[staticPath]) {
      const fs = require('fs');
      const [file, type] = staticFiles[staticPath];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(ROOT, file)).pipe(res);
    }
    if (!applyCors(req, res)) return res.writeHead(403).end('Origin não permitida');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!isAuthorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Pareamento inválido.' }));
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const result = await handleApi({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

const RelayClient = process.env.REMOTO_RELAY_URL ? require('./relay/relay-client').RelayClient : null;
const relay = process.env.REMOTO_RELAY_URL ? new RelayClient({
  url: process.env.REMOTO_RELAY_URL,
  hostId: HOST_ID,
  token: store.token,
  onRequest: async (request) => {
    if (request.token !== store.token) throw new Error('Pareamento inválido.');
    return handleApi(request);
  },
  onStatus: s => { relayStatus = s; }
}) : null;
relay?.start();

server.listen(PORT, '127.0.0.1', () => {
  console.log('=======================================================');
  console.log(' REMOTO IA V2 — HOST REAL');
  console.log(` Host: ${HOST_ID}`);
  console.log(` Local: http://127.0.0.1:${PORT}`);
  console.log(` Pairing token: ${store.token}`);
  console.log(` Relay: ${process.env.REMOTO_RELAY_URL || 'desativado'}`);
  console.log('=======================================================');
});
