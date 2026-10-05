const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class StateStore {
  constructor(rootDir) {
    this.file = path.join(rootDir, '.remoto-state.json');
    this.state = this.load();
    if (!this.state.pairingToken) {
      this.state.pairingToken = crypto.randomBytes(32).toString('hex');
      this.save();
    }
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { pairingToken: null, codexMeta: {}, claudeThreads: {} };
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get token() { return process.env.REMOTO_PAIRING_TOKEN || this.state.pairingToken; }
  get codexMeta() { return this.state.codexMeta ||= {}; }
  get claudeThreads() { return this.state.claudeThreads ||= {}; }

  setCodexMeta(id, patch) {
    this.codexMeta[id] = { ...(this.codexMeta[id] || {}), ...patch };
    this.save();
    return this.codexMeta[id];
  }

  setClaudeThread(id, patch) {
    this.claudeThreads[id] = { ...(this.claudeThreads[id] || {}), ...patch };
    this.save();
    return this.claudeThreads[id];
  }
}

module.exports = { StateStore };
