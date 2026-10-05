const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ service: 'remoto-ia-relay', status: 'online' }));
});
const wss = new WebSocketServer({ server });
const hosts = new Map();
const clients = new Map();

function key(hostId) { return String(hostId || '').trim(); }
function group(hostId) { if (!clients.has(hostId)) clients.set(hostId, new Set()); return clients.get(hostId); }
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

wss.on('connection', (ws) => {
  ws.meta = null;
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return send(ws, { type: 'error', error: 'invalid_json' }); }
    if (msg.type === 'hello') {
      const hostId = key(msg.hostId);
      if (!hostId || !msg.token || String(msg.token).length < 32) return ws.close(1008, 'Credenciais inválidas');
      ws.meta = { role: msg.role, hostId, token: String(msg.token) };
      if (msg.role === 'host') {
        const previous = hosts.get(hostId); if (previous && previous !== ws) previous.close(1012, 'Host reconectado');
        hosts.set(hostId, ws);
      } else if (msg.role === 'client') {
        const host = hosts.get(hostId);
        if (!host?.meta || host.meta.token !== String(msg.token)) return ws.close(1008, 'Pareamento inválido');
        group(hostId).add(ws);
      } else return ws.close(1008, 'Papel inválido');
      return send(ws, { type: 'hello/ok', hostId });
    }
    if (!ws.meta) return ws.close(1008, 'hello obrigatório');
    if (ws.meta.role === 'client' && msg.type === 'request') {
      const host = hosts.get(ws.meta.hostId);
      if (!host || host.readyState !== 1) return send(ws, { type: 'response', id: msg.id, error: 'host_offline' });
      if (host.meta.token !== ws.meta.token) return ws.close(1008, 'Pareamento inválido');
      send(host, msg);
    } else if (ws.meta.role === 'host' && (msg.type === 'response' || msg.type === 'event')) {
      for (const client of group(ws.meta.hostId)) send(client, msg);
    }
  });
  ws.on('close', () => {
    if (!ws.meta) return;
    if (ws.meta.role === 'host' && hosts.get(ws.meta.hostId) === ws) hosts.delete(ws.meta.hostId);
    if (ws.meta.role === 'client') group(ws.meta.hostId).delete(ws);
  });
});

server.listen(PORT, () => console.log(`REMOTO IA Relay: ws://0.0.0.0:${PORT}`));
