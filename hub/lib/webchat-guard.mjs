import path from 'node:path';
import { pathToFileURL } from 'node:url';

// b4a51da otherwise opens a visible browser and waits on a challenge.
// Restrict the owned process only; never edit the external installation.
const { WebChatSession, WebChatError } = await import(pathToFileURL(path.join(path.dirname(process.argv[1]), 'session.js')).href);
if (typeof WebChatSession?.prototype?.passChallenge !== 'function' || typeof WebChatError !== 'function') {
  throw Error('webchat_guard_unavailable');
}
Object.defineProperty(WebChatSession.prototype, 'passChallenge', {
  value: async function () { throw new WebChatError('Hub stopped at a verification screen', 'challenge_required'); },
});

// Upstream statusAsync only reads an existing page. A fresh stdio process has
// no page, so load the temporary chat without opening or selecting a model.
// Patch only this Hub-owned process; keep the external installation unchanged.
const statusAsync = WebChatSession.prototype.statusAsync;
if (typeof statusAsync !== 'function' || ['launch', 'currentPage', 'openForUse'].some(name => typeof WebChatSession.prototype[name] !== 'function')) {
  throw Error('webchat_guard_unavailable');
}
Object.defineProperty(WebChatSession.prototype, 'statusAsync', {
  value: async function (provider) {
    if (provider === 'chatgpt') {
      const cold = !this.browserRunning;
      await this.launch();
      let page = this.currentPage(provider);
      if (cold || !page || page.url() === 'about:blank') {
        try { page = await this.openForUse(provider, 60000); }
        catch (e) { if (e.code !== 'logged_out') throw e; page = this.currentPage(provider); }
      }
      const title = page ? await page.title() : '';
      if (/just a moment|attention required|checking your browser|verify you are human|請稍候|请稍候|お待ちください/i.test(title)) {
        throw new WebChatError('Hub stopped at a verification screen', 'challenge_required');
      }
    }
    return statusAsync.call(this, provider);
  },
});

// ask opens a fresh page (or takes a warmed page) after Hub's status check.
// Upstream reads these states on the exact asking page before typing, but
// permits guests/unknown privacy. Require confirmation on that page as well.
for (const [name, code] of [['loginState', 'login_unconfirmed'], ['temporaryState', 'temporary_chat_unconfirmed']]) {
  const read = WebChatSession.prototype[name];
  if (typeof read !== 'function') throw Error('webchat_guard_unavailable');
  Object.defineProperty(WebChatSession.prototype, name, {
    value: async function (page, provider) {
      const state = await read.call(this, page, provider);
      if (provider === 'chatgpt' && this.asking === page && state !== true) {
        throw new WebChatError('Hub stopped before sending on an unconfirmed chat page', code);
      }
      return state;
    },
  });
}
