const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(
  'discord-privacy-eraser.user.js',
  'utf8',
);

const stored = new Map();
const networkCalls = [];

class FakeXhr {
  open() {}
  setRequestHeader() {}
  send() {}
}

const pageWindow = {
  fetch: async (...args) => {
    networkCalls.push(args);
    return { ok: true };
  },
  XMLHttpRequest: FakeXhr,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
};

const context = {
  unsafeWindow: pageWindow,
  window: pageWindow,
  location: {
    href: 'https://discord.com/channels/@me/123456789012345678',
    origin: 'https://discord.com',
    pathname: '/channels/@me/123456789012345678',
  },
  document: {
    body: null,
    documentElement: {},
  },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  GM_getValue: (key) => stored.get(key),
  GM_setValue: (key, value) => stored.set(key, value),
  GM_deleteValue: (key) => stored.delete(key),
  fetch: pageWindow.fetch,
  AbortController,
  URL,
  URLSearchParams,
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
};

vm.createContext(context);
vm.runInContext(source, context, {
  filename: 'discord-privacy-eraser.user.js',
  timeout: 3000,
});

if (pageWindow.fetch === context.fetch) {
  throw new Error('Expected the page fetch function to be wrapped.');
}

pageWindow.fetch('/api/v9/test', {
  headers: {
    Authorization: 'test.token.value.that.is-long-enough-for-capture',
  },
});

if (networkCalls.length !== 1) {
  throw new Error(`Expected one delegated fetch, got ${networkCalls.length}.`);
}

console.log('Userscript initialization and page-network wrapper smoke test passed.');
