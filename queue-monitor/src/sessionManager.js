import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { QueueSession } from './queueSession.js';
import { dirs } from './config.js';

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.autoReloadEnabled = true;
    fs.mkdirSync(path.join(dirs.dataDir, 'profiles'), { recursive: true });
    fs.mkdirSync(path.join(dirs.dataDir, 'screenshots'), { recursive: true });
  }

  bootstrap() {}

  list() {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      label: session.label,
      state: session.state,
    }));
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  create(config, options = {}) {
    const { autoStart = true } = options;
    if (!config.queueUrl) {
      throw new Error('queueUrl is required');
    }
    const id = config.id || this.generateId(config.queueUrl);
    if (this.sessions.has(id)) {
      throw new Error(`Session with id ${id} already exists`);
    }
    const sessionConfig = {
      id,
      label: config.label || `Queue ${this.sessions.size + 1}`,
      queueUrl: config.queueUrl,
      sourceUrl: config.sourceUrl,
      autoReloadMs: config.autoReloadMs,
    };
    const session = new QueueSession(sessionConfig);
    session.setGlobalAutoReload(this.autoReloadEnabled);
    this.sessions.set(id, session);
    session.on('state', (state) => this.emit('state', state));
    session.on('error', (error) => this.emit('error', { id: session.id, error }));
    if (autoStart) {
      session.start();
    }
    return session;
  }

  generateId(queueUrl) {
    const slug = queueUrl.split('queue=').pop()?.split('&')[0] || 'session';
    return `${slug}-${randomUUID().slice(0, 8)}`;
  }

  async bringToFront(id) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    await session.bringToFront();
    return session.state;
  }

  async reload(id) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    await session.reload();
    return session.state;
  }

  async screenshot(id) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    await session.captureScreenshot();
    return session.state;
  }

  async submitCaptcha(id, answer) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    await session.submitCaptcha(answer);
    return session.state;
  }

  async refreshCaptcha(id) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    await session.refreshCaptcha();
    return session.state;
  }

  setSessionAutoReload(id, enabled) {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.setAutoReloadEnabled(enabled);
    return session.state;
  }

  setGlobalAutoReload(enabled) {
    this.autoReloadEnabled = enabled;
    this.sessions.forEach((session) => session.setGlobalAutoReload(enabled));
    this.emit('settings', this.getSettings());
  }

  getSettings() {
    return { autoReloadEnabled: this.autoReloadEnabled };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manager = new SessionManager();
  manager.bootstrap();
  manager.on('state', (state) => console.log('[state]', state.id, state.status, state.message));
}
