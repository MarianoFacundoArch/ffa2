import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';
import { dirs } from './config.js';
import { launchFingerprintContext } from './fingerprintProvider.js';

const SCREENSHOT_INTERVAL_MS = 1_000;
const STATE_POLL_MS = 5_000;
const AUTO_RELOAD_MIN_MS = 60_000;
const MAX_FAILURES = 5;

export class QueueSession extends EventEmitter {
  constructor(config) {
    super();
    this.id = config.id;
    this.label = config.label || config.id;
    this.queueUrl = config.queueUrl;
    this.sourceUrl = config.sourceUrl || null;
    this.context = null;
    this.page = null;
    this.state = {
      status: 'idle',
      message: 'waiting to launch',
      admissionInfo: null,
      queueinfo: null,
      wr_error: null,
      countdownText: null,
      queuePosition: null,
      captchaRequired: false,
      captchaImage: null,
      captchaUpdatedAt: null,
      lastCaptchaSubmission: null,
      lastResponse: null,
      lastUpdated: null,
      screenshotPath: null,
      autoReloadEnabled: true,
      globalAutoReloadEnabled: true,
      fingerprintActive: false,
      fingerprintInfo: null,
    };
    this.failures = 0;
    this.timers = new Map();
    this.profileDir = path.join(dirs.dataDir, 'profiles', this.id);
    this.screenshotDir = path.join(dirs.dataDir, 'screenshots');
    this.waitingSince = null;
    this.lastReloadAt = 0;
    this.lastMaintenanceReloadAt = 0;
    this.lastCaptchaPromptAt = 0;
    this.autoReloadEnabled = true;
    this.globalAutoReloadEnabled = true;
    this.autoReloadMs = config.autoReloadMs || AUTO_RELOAD_MIN_MS;
    this.fingerprintInfo = null;
    this.lastCaptchaDataUrl = null;
    fs.mkdirSync(this.profileDir, { recursive: true });
    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  async start() {
    try {
      this.updateState({ status: 'launching', message: 'Starting Chromium…' });
      const baseLaunchOptions = {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
      };
      const baseContextOptions = {
        viewport: { width: 1280, height: 720 },
      };

      const fingerprintResult = await launchFingerprintContext({
        profileDir: this.profileDir,
        launchOptions: baseLaunchOptions,
        contextOptions: baseContextOptions,
      });

      if (fingerprintResult?.context) {
        this.context = fingerprintResult.context;
        const [existingPage] = this.context.pages();
        this.page = fingerprintResult.page
          || existingPage
          || (await this.context.newPage());
        this.fingerprintInfo = fingerprintResult.fingerprint ?? null;
        this.updateState({ fingerprintActive: true, fingerprintInfo: this.fingerprintInfo });
      } else {
        this.context = await chromium.launchPersistentContext(this.profileDir, {
          ...baseContextOptions,
          ...baseLaunchOptions,
        });
        const [page] = this.context.pages();
        this.page = page || (await this.context.newPage());
        this.fingerprintInfo = null;
        this.updateState({ fingerprintActive: false, fingerprintInfo: null });
      }
      await this.preparePage();
      await this.navigateToQueue();
      this.attachListeners();
      this.schedule('statePoll', () => this.pollState(), STATE_POLL_MS);
      this.schedule('screenshot', () => this.captureScreenshot(), SCREENSHOT_INTERVAL_MS);
      this.updateState({ status: 'running', message: 'Queue session active' });
    } catch (error) {
      this.failures += 1;
      this.updateState({
        status: 'error',
        message: `Failed to start (${this.failures}): ${error.message}`,
      });
      this.emit('error', error);
      if (this.failures < MAX_FAILURES) {
        setTimeout(() => this.start(), 5_000 * this.failures);
      }
    }
  }

  async preparePage() {
    this.page.setDefaultTimeout(45_000);
    this.page.on('dialog', async (dialog) => {
      await dialog.dismiss().catch(() => {});
    });
    this.page.on('close', () => {
      this.updateState({ status: 'stopped', message: 'Browser window closed by user' });
      this.clearTimers();
    });
    this.page.on('crash', () => {
      this.updateState({ status: 'error', message: 'Browser tab crashed' });
      this.restartSoon();
    });
    this.page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('/pkpcontroller/servlet.do')) {
        try {
          const text = await response.text();
          this.handleControllerPayload(text);
        } catch (error) {
          // ignore binary/empty payloads
        }
      }
    });
  }

  async navigateToQueue() {
    let targetUrl = this.queueUrl;
    if (this.sourceUrl && !this.queueUrl.includes('source=')) {
      const separator = this.queueUrl.includes('?') ? '&' : '?';
      targetUrl = `${this.queueUrl}${separator}source=${encodeURIComponent(this.sourceUrl)}`;
    }
    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await this.page.bringToFront();
  }

  attachListeners() {
    this.page.on('load', () => {
      this.updateState({ message: 'Page loaded' });
    });
    this.page.on('frameattached', () => this.pollState());
  }

  schedule(key, fn, delay) {
    this.clearTimer(key);
    const timer = setInterval(() => {
      fn().catch((error) => {
        this.updateState({ status: 'warning', message: `Task ${key} failed: ${error.message}` });
      });
    }, delay);
    this.timers.set(key, timer);
  }

  clearTimer(key) {
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
  }

  clearTimers() {
    for (const key of this.timers.keys()) {
      this.clearTimer(key);
    }
  }

  async pollState() {
    if (!this.page || this.page.isClosed()) {
      return;
    }
    try {
      const payload = await this.page.evaluate(async () => {
        const extractText = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return null;
          }
          return el.innerText.trim();
        };
        const captchaEl = document.querySelector('#captcha');
        const captchaVisible = captchaEl
          ? window.getComputedStyle(captchaEl).display !== 'none'
          : false;
        let captchaDataUrl = null;
        if (captchaVisible) {
          const captchaImg = document.querySelector('#img_captcha');
          if (captchaImg && captchaImg.complete && captchaImg.naturalWidth > 0) {
            try {
              const canvas = document.createElement('canvas');
              canvas.width = captchaImg.naturalWidth;
              canvas.height = captchaImg.naturalHeight;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(captchaImg, 0, 0);
              captchaDataUrl = canvas.toDataURL('image/png');
            } catch (error) {
              captchaDataUrl = null;
            }
          }
        }
        return {
          url: window.location.href,
          admissionInfo: window.admissionInfo ?? null,
          queueinfo: window.queueinfo ?? null,
          wr_error: window.wr_error ?? null,
          countdownText: extractText('#wait'),
          queuePosition: extractText('#queueposition'),
          statusMessage: extractText('#message') || extractText('#message_wait'),
          captchaVisible,
          captchaDataUrl,
          title: extractText('#titre'),
          infoBanner: extractText('#info') ?? null,
          timestamp: Date.now(),
        };
      });
      this.updateState({
        admissionInfo: payload.admissionInfo,
        queueinfo: payload.queueinfo,
        wr_error: payload.wr_error,
        countdownText: payload.countdownText,
        queuePosition: payload.queuePosition,
        captchaRequired: payload.captchaVisible,
        message: payload.statusMessage || this.state.message,
        infoBanner: payload.infoBanner,
        pageTitle: payload.title,
        lastUpdated: payload.timestamp,
        currentUrl: payload.url,
      });
      if (payload.captchaVisible) {
        if (payload.captchaDataUrl && payload.captchaDataUrl !== this.lastCaptchaDataUrl) {
          this.lastCaptchaDataUrl = payload.captchaDataUrl;
          this.updateState({
            captchaImage: payload.captchaDataUrl,
            captchaUpdatedAt: payload.timestamp,
          });
        }
      } else if (this.lastCaptchaDataUrl) {
        this.lastCaptchaDataUrl = null;
        this.updateState({ captchaImage: null, captchaUpdatedAt: null });
      }
      this.detectStalls();
    } catch (error) {
      this.updateState({ status: 'warning', message: `State poll failed: ${error.message}` });
    }
  }

  detectStalls() {
    const { admissionInfo } = this.state;
    if (!admissionInfo) {
      return;
    }

    if (this.hasMaintenanceBanner()) {
      this.handleMaintenanceBanner();
      return;
    }
    if (this.isCaptchaPromptMessage()) {
      this.handleCaptchaPrompt();
      return;
    }
    if (admissionInfo.needCaptcha === 'true') {
      this.updateState({ status: 'captcha', message: 'Captcha required' });
      this.page.bringToFront().catch(() => {});
      this.lastCaptchaPromptAt = Date.now();
      this.waitingSince = null;
      return;
    }
    if (admissionInfo.admissionURL && admissionInfo.admissionURL !== 'false') {
      this.updateState({ status: 'ready', message: 'Admission URL available, waiting for redirect' });
      this.waitingSince = null;
      return;
    }
    if (admissionInfo.genAT !== 'true') {
      this.updateState({ status: 'waiting', message: 'Queue not open yet (genAT≠true)' });
      this.maybeAutoReload();
    } else if (admissionInfo.canEnter === 'true') {
      this.updateState({ status: 'ready', message: 'Queue ready, waiting for ENTER action' });
      this.waitingSince = null;
    } else {
      this.updateState({ status: 'running', message: 'In queue' });
      this.waitingSince = null;
    }
  }

  hasMaintenanceBanner() {
    const target = 'we are currently performing scheduled maintenance';
    const candidates = [this.state.message, this.state.infoBanner];
    return candidates.some(
      (text) => typeof text === 'string' && text.toLowerCase().includes(target)
    );
  }

  handleMaintenanceBanner() {
    const now = Date.now();
    const cooldown = Math.min(this.autoReloadMs, 15_000);
    if (!this.autoReloadEnabled || !this.globalAutoReloadEnabled) {
      this.updateState({ status: 'waiting' });
      this.waitingSince = null;
      return;
    }
    if (now - this.lastMaintenanceReloadAt < cooldown) {
      this.updateState({
        status: 'waiting',
        message: 'Maintenance banner detected – waiting to retry',
      });
      return;
    }
    this.lastMaintenanceReloadAt = now;
    this.waitingSince = now;
    this.updateState({
      status: 'waiting',
      message: 'Maintenance banner detected – refreshing',
    });
    this.reload('Maintenance banner detected, refreshing').catch((error) => {
      this.updateState({ status: 'warning', message: `Maintenance reload failed: ${error.message}` });
    });
  }

  isCaptchaPromptMessage() {
    const prompts = [
      'enter the characters you see in the image below',
      'if you would like to join the queue',
      'thank you for waiting to have an opportunity to purchase ticket(s)',
    ];
    const candidates = [this.state.message, this.state.infoBanner];
    return candidates.some((text) =>
      typeof text === 'string' && prompts.some((prompt) => text.toLowerCase().includes(prompt))
    );
  }

  handleCaptchaPrompt() {
    const now = Date.now();
    if (now - this.lastCaptchaPromptAt > 5_000) {
      this.page?.bringToFront().catch(() => {});
      this.lastCaptchaPromptAt = now;
    }
    this.waitingSince = null;
    this.updateState({ status: 'captcha' });
  }

  maybeAutoReload() {
    const now = Date.now();
    const waitingTime = this.state.admissionInfo?.waitingTime;
    const numericWaiting = Number(waitingTime);
    const hasConcreteWait = Number.isFinite(numericWaiting) && numericWaiting > 0;
    if (!this.autoReloadEnabled || !this.globalAutoReloadEnabled) {
      return;
    }
    if (this.state.captchaRequired || this.isCaptchaPromptMessage()) {
      return;
    }
    if (hasConcreteWait) {
      this.waitingSince = null;
      return;
    }
    if (!this.waitingSince) {
      this.waitingSince = now;
    }
    if (now - this.waitingSince < this.autoReloadMs) {
      return;
    }
    if (now - this.lastReloadAt < this.autoReloadMs) {
      return;
    }
    this.lastReloadAt = now;
    this.waitingSince = now;
    this.updateState({ status: 'waiting', message: 'Queue closed, refreshing to retry' });
    this.reload('Auto reload triggered (queue closed)').catch((error) => {
      this.updateState({ status: 'warning', message: `Auto-reload failed: ${error.message}` });
    });
  }

  async captureScreenshot() {
    if (!this.page || this.page.isClosed()) {
      return;
    }
    try {
      const screenshotPath = path.join(this.screenshotDir, `${this.id}.png`);
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      this.updateState({ screenshotPath });
    } catch (error) {
      this.updateState({ status: 'warning', message: `Screenshot failed: ${error.message}` });
    }
  }

  handleControllerPayload(text) {
    if (!text) return;
    const locationMatch = text.match(/\{\s*"location"\s*:\s*"([^"]+)"\s*\}/);
    if (locationMatch) {
      this.updateState({ lastResponse: { location: locationMatch[1] } });
    }
    const admissionMatch = text.match(/\{\s*"admissionInfo"\s*:\s*\{[\s\S]*?\}\s*\}/);
    if (admissionMatch) {
      try {
        const info = JSON.parse(admissionMatch[0]);
        this.updateState({
          admissionInfo: info.admissionInfo,
          lastResponse: info,
        });
      } catch (error) {
        // ignore parse errors
      }
    }
  }

  async bringToFront() {
    if (!this.page || this.page.isClosed()) return;
    await this.page.bringToFront();
    await this.page.focus('body').catch(() => {});
  }

  async reload(messageOverride) {
    if (!this.page || this.page.isClosed()) return;
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    const message = messageOverride || 'Manual reload triggered';
    this.updateState({ message });
  }

  async submitCaptcha(answer) {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Browser page is not available');
    }
    const value = (answer ?? '').trim();
    if (!value) {
      throw new Error('Captcha answer is required');
    }
    try {
      await this.page.evaluate(async (inputValue) => {
        const input = document.querySelector('#secret');
        if (!input) {
          throw new Error('Captcha input not found');
        }
        input.value = inputValue;
        const submitButton = document.querySelector('#submit_button');
        if (submitButton) {
          submitButton.click();
          return;
        }
        if (typeof window.submitCaptcha === 'function') {
          window.submitCaptcha();
          return;
        }
        const form = document.querySelector('#form_captcha');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      }, value);
      this.updateState({
        message: 'Captcha answer submitted from dashboard',
        lastCaptchaSubmission: Date.now(),
      });
    } catch (error) {
      throw new Error(error.message || 'Captcha submission failed');
    }
  }

  async refreshCaptcha() {
    if (!this.page || this.page.isClosed()) {
      throw new Error('Browser page is not available');
    }
    try {
      await this.page.evaluate(() => {
        if (typeof window.newCaptcha === 'function') {
          window.newCaptcha();
          return;
        }
        const refreshButton = document.querySelector('#newcaptcha_button a, #newcaptcha_button');
        if (refreshButton instanceof HTMLElement) {
          refreshButton.click();
        }
      });
      this.updateState({ message: 'Captcha refresh requested from dashboard' });
    } catch (error) {
      throw new Error(error.message || 'Captcha refresh failed');
    }
  }

  async restartSoon() {
    this.clearTimers();
    await this.dispose();
    setTimeout(() => this.start(), 10_000);
  }

  async dispose() {
    this.clearTimers();
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this.updateState({ status: 'stopped', message: 'Session disposed' });
  }

  updateState(patch) {
    this.state = {
      ...this.state,
      ...patch,
      autoReloadEnabled: this.autoReloadEnabled,
      globalAutoReloadEnabled: this.globalAutoReloadEnabled,
    };
    this.emit('state', { id: this.id, label: this.label, ...this.state });
  }

  setAutoReloadEnabled(enabled) {
    if (this.autoReloadEnabled === enabled) {
      return;
    }
    this.autoReloadEnabled = enabled;
    if (!enabled) {
      this.waitingSince = null;
    }
    this.updateState({});
  }

  setGlobalAutoReload(enabled) {
    if (this.globalAutoReloadEnabled === enabled) {
      return;
    }
    this.globalAutoReloadEnabled = enabled;
    if (!enabled) {
      this.waitingSince = null;
    }
    this.updateState({});
  }
}
