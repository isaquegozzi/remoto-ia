const WebSocket = require('ws');

class RelayClient {
  constructor({ url, hostId, token, onRequest, onStatus }) {
    this.url = url; this.hostId = hostId; this.token = token; this.onRequest = onRequest; this.onStatus = onStatus;
    this.ws = null; this.timer = null;
  }
  start() { if (!this.url) return; this.connect(); }
  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => {
      this.onStatus?.('online');
      this.ws.send(JSON.stringify({ type: 'hello', role: 'host', hostId: this.hostId, token: this.token }));
    });
    this.ws.on('message', async raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type !== 'request') return;
      try {
        const result = await this.onRequest(msg.request || {});
        this.send({ type: 'response', id: msg.id, result });
      } catch (err) {
        this.send({ type: 'response', id: msg.id, error: err.message });
      }
    });
    this.ws.on('close', () => this.reconnect());
    this.ws.on('error', () => {});
  }
  reconnect() { this.onStatus?.('offline'); clearTimeout(this.timer); this.timer = setTimeout(() => this.connect(), 3000); }
  send(obj) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  event(event) { this.send({ type: 'event', event }); }
}
module.exports = { RelayClient };
