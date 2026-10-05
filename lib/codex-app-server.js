const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

class CodexAppServer extends EventEmitter {
  constructor({ cwd = process.cwd() } = {}) {
    super();
    this.cwd = cwd;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.starting = null;
    this.activeTurns = new Map();
    this.turnToThread = new Map();
    this.queues = new Map();
  }

  async start() {
    if (this.ready && this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this._start();
    try { await this.starting; } finally { this.starting = null; }
  }

  async _start() {
    const isWin = process.platform === 'win32';
    const command = isWin ? 'codex app-server' : 'codex';
    const args = isWin ? [] : ['app-server'];
    this.proc = spawn(command, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
      windowsHide: true,
      env: process.env
    });

    this.proc.on('error', (err) => this._die(err));
    this.proc.on('exit', (code, signal) => this._die(new Error(`codex app-server encerrou (${code ?? signal})`)));
    this.proc.stderr.on('data', (d) => this.emit('diagnostic', String(d)));

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      try { this._onMessage(JSON.parse(line)); }
      catch (err) { this.emit('diagnostic', `JSON inválido do Codex: ${err.message}\n${line}`); }
    });

    await this.request('initialize', {
      clientInfo: { name: 'remoto-ia', title: 'Remoto IA', version: '2.0.0' },
      capabilities: {}
    }, 15000);
    this.notify('initialized', {});
    this.ready = true;
    this.emit('ready');
  }

  _die(err) {
    this.ready = false;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
    this.emit('offline', err);
  }

  _onMessage(msg) {
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method && Object.prototype.hasOwnProperty.call(msg, 'id')) {
      this.emit('serverRequest', {
        agent: 'codex', requestId: msg.id, method: msg.method, params: msg.params || {}
      });
      return;
    }

    if (msg.method) {
      const params = { ...(msg.params || {}) };
      const turnId = params.turnId || params.turn?.id;
      if (!params.threadId && turnId && this.turnToThread.has(turnId)) params.threadId = this.turnToThread.get(turnId);
      const event = { agent: 'codex', method: msg.method, params };
      this._trackLifecycle(event);
      this.emit('event', event);
    }
  }

  _trackLifecycle(event) {
    const p = event.params || {};
    const turnId = p.turnId || p.turn?.id;
    const threadId = p.threadId || (turnId ? this.turnToThread.get(turnId) : null);
    if (event.method === 'turn/started' && threadId && turnId) {
      this.activeTurns.set(threadId, turnId);
      this.turnToThread.set(turnId, threadId);
    }
    if (event.method === 'turn/completed' && threadId) {
      this.activeTurns.delete(threadId);
      if (turnId) this.turnToThread.delete(turnId);
      const queue = this.queues.get(threadId) || [];
      const next = queue.shift();
      if (queue.length) this.queues.set(threadId, queue); else this.queues.delete(threadId);
      if (next) this.startTurn(threadId, next.prompt, next.options).catch(err => this.emit('diagnostic', err.message));
    }
  }

  _write(obj) {
    if (!this.proc?.stdin?.writable) throw new Error('Codex App Server não está conectado.');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout em ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) { this._write({ jsonrpc: '2.0', method, params }); }

  async accountRead() { await this.start(); return this.request('account/read', {}); }
  async startDeviceLogin() { await this.start(); return this.request('account/login/start', { type: 'chatgptDeviceCode' }); }

  async listThreads(cursor = null) {
    await this.start();
    return this.request('thread/list', { limit: 50, cursor, sourceKinds: ['cli', 'vscode', 'appServer'] });
  }

  async startThread({ cwd, model, approvalPolicy = 'unlessTrusted', sandbox = 'workspaceWrite' } = {}) {
    await this.start();
    const params = { cwd: cwd || this.cwd, approvalPolicy, sandbox, serviceName: 'remoto_ia' };
    if (model) params.model = model;
    return this.request('thread/start', params);
  }

  async resumeThread(threadId) { await this.start(); return this.request('thread/resume', { threadId }); }
  async readThread(threadId) { await this.start(); return this.request('thread/read', { threadId, includeTurns: true }); }

  async startTurn(threadId, prompt, options = {}) {
    await this.start();
    const params = {
      threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: options.approvalPolicy || 'unlessTrusted'
    };
    if (options.sandboxPolicy) params.sandboxPolicy = options.sandboxPolicy;
    const result = await this.request('turn/start', params, 60000);
    const turnId = result?.turn?.id || result?.turnId;
    if (turnId) {
      this.activeTurns.set(threadId, turnId);
      this.turnToThread.set(turnId, threadId);
    }
    return result;
  }

  async send(threadId, prompt, mode = 'queue', options = {}) {
    await this.start();
    const activeTurnId = this.activeTurns.get(threadId);
    if (activeTurnId && mode === 'steer') {
      return this.request('turn/steer', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        expectedTurnId: activeTurnId
      });
    }
    if (activeTurnId) {
      const q = this.queues.get(threadId) || [];
      q.push({ prompt, options });
      this.queues.set(threadId, q);
      return { queued: true, position: q.length };
    }
    return this.startTurn(threadId, prompt, options);
  }

  async interrupt(threadId) {
    await this.start();
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) return { interrupted: false, reason: 'no_active_turn' };
    return this.request('turn/interrupt', { threadId, turnId });
  }

  respondServerRequest(requestId, result) {
    this._write({ jsonrpc: '2.0', id: requestId, result });
  }

  getStatus() {
    return { installed: !!this.proc || this.ready, ready: this.ready, activeTurns: this.activeTurns.size };
  }
}

module.exports = { CodexAppServer };
