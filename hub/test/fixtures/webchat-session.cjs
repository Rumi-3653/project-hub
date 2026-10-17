'use strict';
// No browser: the fallback would be reached if the process guard were absent.
const fs = require('node:fs'), path = require('node:path');
const settings = () => JSON.parse(fs.readFileSync(path.join(path.dirname(__dirname), 'fake.json'), 'utf8'));
exports.WebChatSession = class {
  page = null;
  get browserRunning() { return Boolean(this.page); }
  async passChallenge() { throw Error('unsafe_fallback_reached'); }
  async launch() {
    if (!this.page && settings().restoredPage) this.page = { url: () => 'https://chatgpt.com/', title: async () => 'ChatGPT' };
  }
  currentPage() { return this.page; }
  async openForUse() {
    const s = settings();
    fs.appendFileSync(path.join(path.dirname(__dirname), 'calls.jsonl'), JSON.stringify({ sessionOpen: true }) + '\n');
    if (s.challenge) await this.passChallenge();
    if (s.statusError) throw new exports.WebChatError(s.statusError.message, s.statusError.error);
    this.page = { url: () => 'https://chatgpt.com/?temporary-chat=true', title: async () => 'ChatGPT' };
    return this.page;
  }
  async statusAsync() {
    const s = settings();
    return { loggedIn: s.statusUnknown || this.answered && s.afterStatusUnknown ? 'unknown' : s.loggedIn !== false,
      temporaryChat: s.temporaryUnknown || this.answered && s.afterTemporaryUnknown ? 'unknown' : s.temporaryChat !== false };
  }
  async loginState(page) {
    const s = settings();
    return this.asking === page && Object.hasOwn(s, 'askLoggedIn') ? s.askLoggedIn : s.statusUnknown ? 'unknown' : s.loggedIn !== false;
  }
  async temporaryState(page) {
    const s = settings();
    return this.asking === page && Object.hasOwn(s, 'askTemporary') ? s.askTemporary : s.temporaryUnknown ? 'unknown' : s.temporaryChat !== false;
  }
  async ask(provider) {
    const page = await this.openForUse(provider);
    this.asking = page;
    try {
      await Promise.all([this.loginState(page, provider), this.temporaryState(page, provider)]);
      fs.appendFileSync(path.join(path.dirname(__dirname), 'calls.jsonl'), JSON.stringify({ transportSent: true }) + '\n');
      this.answered = true;
    } finally { this.asking = null; }
  }
};
exports.WebChatError = class extends Error { constructor(message, code) { super(message); this.code = code; } };
