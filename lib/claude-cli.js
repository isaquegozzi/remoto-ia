const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable']);

class ClaudeCli extends EventEmitter {
  constructor({ store, cwd = process.cwd() }) {
    super();
    this.store = store;
    this.cwd = cwd;
    this.running = new Map();
  }

  async checkInstalled() {
    const run = (suffix) => new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? `claude ${suffix}` : 'claude';
      const args = isWin ? [] : suffix.split(' ');
      const p = spawn(cmd, args, { shell: isWin, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => out += d);
      p.on('error', () => resolve({ code: -1, out: '' }));
      p.on('close', code => resolve({ code, out: out.trim() }));
    });
    const version = await run('--version');
    if (version.code !== 0) return { installed: false };
    const auth = await run('auth status');
    let authData = null;
    try { authData = JSON.parse(auth.out); } catch {}
    return { installed: true, version: version.out || null, authenticated: auth.code === 0, auth: authData };
  }

  listThreads() {
    return Object.values(this.store.claudeThreads).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  createThread({ cwd, title, model }) {
    const id = `claude-${crypto.randomUUID()}`;
    const thread = {
      id,
      title: title || 'Nova tarefa Claude',
      cwd: cwd || this.cwd,
      model: MODELS.has(model) ? model : 'sonnet',
      sessionId: null,
      status: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: []
    };
    this.store.setClaudeThread(id, thread);
    return thread;
  }

  getThread(id) { return this.store.claudeThreads[id] || null; }

  async send(id, prompt, { model } = {}) {
    const thread = this.getThread(id);
    if (!thread) throw new Error('Sessão Claude não encontrada.');
    if (this.running.has(id)) throw new Error('Esta sessão Claude já está executando. Interrompa antes de enviar outra mensagem.');

    const selectedModel = MODELS.has(model) ? model : (MODELS.has(thread.model) ? thread.model : 'sonnet');
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', selectedModel];
    if (thread.sessionId) args.push('--resume', thread.sessionId);

    const isWin = process.platform === 'win32';
    const command = isWin ? `claude ${args.map(a => /^[A-Za-z0-9_.:-]+$/.test(a) ? a : JSON.stringify(a)).join(' ')}` : 'claude';
    const spawnArgs = isWin ? [] : args;
    const proc = spawn(command, spawnArgs, {
      cwd: thread.cwd || this.cwd,
      shell: isWin,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    this.running.set(id, proc);

    const now = new Date().toISOString();
    thread.messages ||= [];
    thread.messages.push({ role: 'user', content: prompt, at: now });
    this.store.setClaudeThread(id, { messages: thread.messages, status: 'working', model: selectedModel, updatedAt: now });
    this.emit('event', { agent: 'claude', method: 'turn/started', params: { threadId: id } });

    let stdoutBuffer = '';
    let stderr = '';
    let finalText = '';

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      for (const line of lines) this._consumeLine(id, line, (text) => { finalText = text || finalText; });
    });
    proc.stderr.on('data', d => { stderr += d.toString(); this.emit('diagnostic', d.toString()); });

    proc.stdin.write(prompt);
    proc.stdin.end();

    return new Promise((resolve, reject) => {
      proc.on('error', (err) => {
        this.running.delete(id);
        this.store.setClaudeThread(id, { status: 'error', updatedAt: new Date().toISOString() });
        reject(err);
      });
      proc.on('close', (code) => {
        if (stdoutBuffer.trim()) this._consumeLine(id, stdoutBuffer.trim(), (text) => { finalText = text || finalText; });
        this.running.delete(id);
        const current = this.getThread(id);
        if (code === 0) {
          if (finalText && !current.messages.some(m => m.role === 'assistant' && m.content === finalText)) current.messages.push({ role: 'assistant', content: finalText, at: new Date().toISOString() });
          this.store.setClaudeThread(id, { messages: current.messages, status: 'idle', updatedAt: new Date().toISOString() });
          this.emit('event', { agent: 'claude', method: 'turn/completed', params: { threadId: id } });
          resolve({ success: true, threadId: id });
        } else {
          const message = stderr.trim() || `Claude encerrou com código ${code}`;
          current.messages.push({ role: 'system', content: message, at: new Date().toISOString() });
          this.store.setClaudeThread(id, { messages: current.messages, status: 'error', updatedAt: new Date().toISOString() });
          this.emit('event', { agent: 'claude', method: 'turn/error', params: { threadId: id, message } });
          reject(new Error(message));
        }
      });
    });
  }

  _consumeLine(threadId, line, setFinal) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const thread = this.getThread(threadId);
    const sessionId = msg.session_id || msg.sessionId;
    if (sessionId && sessionId !== thread.sessionId) this.store.setClaudeThread(threadId, { sessionId });

    if (msg.type === 'stream_event') {
      const ev = msg.event || {};
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        this.emit('event', { agent: 'claude', method: 'item/agentMessage/delta', params: { threadId, delta: ev.delta.text } });
      }
      return;
    }

    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') this.emit('event', { agent: 'claude', method: 'item/toolUse', params: { threadId, name: block.name, input: block.input } });
      }
      return;
    }

    if (msg.type === 'result') {
      const text = typeof msg.result === 'string' ? msg.result : '';
      if (text) setFinal(text);
      if (msg.session_id) this.store.setClaudeThread(threadId, { sessionId: msg.session_id });
    }
  }

  interrupt(id) {
    const proc = this.running.get(id);
    if (!proc) return { interrupted: false };
    proc.kill('SIGTERM');
    this.running.delete(id);
    this.store.setClaudeThread(id, { status: 'idle', updatedAt: new Date().toISOString() });
    return { interrupted: true };
  }
}

module.exports = { ClaudeCli };
