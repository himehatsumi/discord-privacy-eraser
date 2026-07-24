const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const rawSource = fs.readFileSync('discord-privacy-eraser.user.js', 'utf8');
const exportBlock = `
  globalThis.__DPE_TEST__ = {
    acceptToken,
    apiRequest,
    compileFilters,
    configSignature,
    defaultPrefs,
    emptyRunState,
    getCurrentUser: () => currentUser,
    getRunState: () => runState,
    getRuntime: () => runtime,
    matchesMessage,
    prepareQueue,
    resolveCurrentUser,
    retryAfterMs,
    setCurrentUser: (value) => { currentUser = value; },
    setRunState: (value) => { runState = value; },
    startDelete,
    startScan,
    validateConfig,
  };
})();`;

const instrumentedSource = rawSource.replace(/\}\)\(\);\s*$/, exportBlock);
if (instrumentedSource === rawSource) {
  throw new Error('Could not instrument the userscript test build.');
}

const TARGET_CHANNEL = '123456789012345678';
const USER_A = { id: '111111111111111111', username: 'alice' };
const USER_B = { id: '222222222222222222', username: 'bob' };
const TOKEN_A = 'test.token.value.for.user.a.that.is-long-enough';
const TOKEN_B = 'test.token.value.for.user.b.that-is-different';

function response(data, status = 200, headers = {}) {
  return new Response(
    status === 204 ? null : JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    },
  );
}

function message({
  id,
  author = USER_A,
  content = '',
  pinned = false,
  timestamp,
  channelId = TARGET_CHANNEL,
  attachments = [],
  embeds = [],
}) {
  return {
    id: String(id),
    channel_id: String(channelId),
    author,
    content,
    pinned,
    timestamp,
    attachments,
    embeds,
    edited_timestamp: null,
  };
}

function makeHarness(prefsOverride = {}, storedSeed = null) {
  const stored = storedSeed ? new Map(storedSeed) : new Map();
  const calls = [];
  let fetchHandler = async () => {
    throw new Error('Unexpected fetch call.');
  };

  class FakeXhr {
    open() {}
    setRequestHeader() {}
    send() {}
  }

  const pageWindow = {
    fetch: async (url, options = {}) => {
      const call = {
        url: String(url),
        method: options.method || 'GET',
        headers: options.headers || {},
      };
      calls.push(call);
      return fetchHandler(call);
    },
    XMLHttpRequest: FakeXhr,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    prompt: (text) => text.match(/Type exactly: (DELETE \d+)/)?.[1] || '',
    confirm: () => true,
  };

  const prefs = {
    afterDate: '',
    beforeDate: '',
    text: '',
    regex: false,
    caseSensitive: false,
    excludeTerms: '',
    attachmentMode: 'any',
    linkMode: 'any',
    includePinned: false,
    includeEdited: true,
    minMessageAgeHours: 0,
    maxMessages: 0,
    deleteOrder: 'oldest',
    scanDelayMs: 250,
    baseDeleteDelayMs: 250,
    maxAdaptiveDelayMs: 5000,
    jitterPercent: 0,
    maxRetries: 2,
    stopAfterErrors: 2,
    checkpointEvery: 1,
    pauseOnNavigate: true,
    autoResume: false,
    riskAccepted: true,
    ...prefsOverride,
  };
  if (!stored.has('dpe:prefs:v1')) {
    stored.set('dpe:prefs:v1', JSON.stringify(prefs));
  }

  const context = {
    unsafeWindow: pageWindow,
    window: pageWindow,
    location: {
      href: `https://discord.com/channels/@me/${TARGET_CHANNEL}`,
      origin: 'https://discord.com',
      pathname: `/channels/@me/${TARGET_CHANNEL}`,
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
    Headers,
    Response,
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };

  vm.createContext(context);
  vm.runInContext(instrumentedSource, context, {
    filename: 'discord-privacy-eraser.user.js',
    timeout: 5000,
  });

  return {
    calls,
    pageWindow,
    prefs,
    setFetchHandler(handler) {
      fetchHandler = handler;
    },
    stored,
    test: context.__DPE_TEST__,
  };
}

async function testCredentialSnifferIgnoresThirdParties() {
  const harness = makeHarness();
  harness.setFetchHandler(async () => response({ ok: true }));
  harness.test.acceptToken(TOKEN_A);
  harness.test.setCurrentUser(USER_A);

  await harness.pageWindow.fetch('https://example.test/private', {
    headers: { Authorization: TOKEN_B },
  });

  assert.equal(
    harness.test.getCurrentUser().id,
    USER_A.id,
    'third-party Authorization headers must not alter the Discord session identity',
  );
}

async function testApiAllowlistBindsMethodPathAndBody() {
  const harness = makeHarness();
  harness.test.acceptToken(TOKEN_A);

  await assert.rejects(
    () => harness.test.apiRequest('/users/@me', { method: 'DELETE' }),
    /Blocked an unexpected Discord API method, path, or body/,
  );
  await assert.rejects(
    () => harness.test.apiRequest(
      `/channels/${TARGET_CHANNEL}/messages/123`,
      { method: 'POST', body: { content: 'must never send' } },
    ),
    /Blocked an unexpected Discord API method, path, or body/,
  );
  assert.equal(harness.calls.length, 0, 'blocked requests must fail before network access');
}

async function testCappedScanAndDelete() {
  const harness = makeHarness({ maxMessages: 1, deleteOrder: 'oldest' });
  const newest = '2026-07-03T12:00:00.000Z';
  const middle = '2026-07-02T12:00:00.000Z';
  const oldest = '2026-07-01T12:00:00.000Z';
  const history = [
    message({
      id: '350',
      content: 'wrong channel',
      timestamp: newest,
      channelId: '999999999999999999',
    }),
    message({ id: '300', content: 'newest own', timestamp: newest }),
    message({ id: '250', author: USER_B, content: 'not ours', timestamp: newest }),
    message({ id: '200', content: 'middle own', timestamp: middle }),
    message({ id: '150', content: 'protected pin', pinned: true, timestamp: middle }),
    message({ id: '100', content: 'oldest own', timestamp: oldest }),
  ];

  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response(history);
    }
    if (method === 'DELETE' && url.endsWith('/messages/100')) return response(null, 204);
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  let state = harness.test.getRunState();
  assert.equal(state.status, 'scanned');
  assert.equal(state.initialMatches, 1);
  assert.deepEqual(
    Array.from(state.queue, (item) => item.id),
    ['100'],
    'oldest-first maximum should select the oldest matching message',
  );
  assert.equal(
    state.firstTimestamp,
    oldest,
    'summary newest timestamp should describe the selected queue, not discarded matches',
  );
  assert.equal(
    state.lastTimestamp,
    oldest,
    'summary oldest timestamp should describe the selected queue, not discarded matches',
  );

  await harness.test.startDelete();
  state = harness.test.getRunState();
  assert.equal(state.status, 'complete');
  assert.equal(state.deleted, 1);
  assert.equal(state.queue.length, 0);
  assert.equal(
    harness.calls.filter((call) => call.method === 'DELETE').length,
    1,
  );
}

async function testCompactCheckpointRestoresLockedChannel() {
  const first = makeHarness();
  first.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response([
        message({ id: '400', content: 'recover me', timestamp: '2026-07-01T12:00:00.000Z' }),
      ]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });
  first.test.acceptToken(TOKEN_A);
  await first.test.startScan();

  const serialized = JSON.parse(first.stored.get('dpe:run:v1'));
  assert.ok(Array.isArray(serialized.queue[0]), 'stored queues should use the compact tuple format');
  assert.equal(serialized.queue[0].length, 2);

  const reloaded = makeHarness({}, first.stored);
  const restored = reloaded.test.getRunState();
  assert.equal(restored.status, 'scanned');
  assert.equal(restored.queue.length, 1);
  assert.equal(restored.queue[0].id, '400');
  assert.equal(restored.queue[0].channelId, TARGET_CHANNEL);
}

async function testAccountSwitchFailsClosed() {
  const harness = makeHarness();
  let activeIdentity = USER_A;
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) {
      return response(activeIdentity);
    }
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response([
        message({ id: '500', content: 'owned by A', timestamp: '2026-07-01T12:00:00.000Z' }),
      ]);
    }
    if (method === 'DELETE') throw new Error('Deletion must not happen after an account switch.');
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  assert.equal(harness.test.getRunState().status, 'scanned');
  activeIdentity = USER_B;
  harness.test.acceptToken(TOKEN_B);
  await harness.test.startDelete();

  const state = harness.test.getRunState();
  assert.equal(state.status, 'scanned');
  assert.equal(state.queue.length, 1);
  assert.equal(
    harness.calls.filter((call) => call.method === 'DELETE').length,
    0,
  );
}

function testFilterMatrix() {
  const harness = makeHarness();
  harness.test.setCurrentUser(USER_A);
  const base = {
    ...harness.test.defaultPrefs,
    riskAccepted: true,
  };
  const candidate = message({
    id: '800',
    content: 'Private Photo https://example.test',
    timestamp: '2026-07-01T12:00:00.000Z',
    attachments: [{ filename: 'photo.png', content_type: 'image/png' }],
  });

  const matches = (config) => {
    const compiled = harness.test.compileFilters(config);
    return harness.test.matchesMessage(
      candidate,
      config,
      compiled.compiledRegex,
      compiled.excludedTerms,
    );
  };

  assert.equal(matches(base), true);
  assert.equal(matches({ ...base, text: 'private photo' }), true);
  assert.equal(matches({ ...base, text: '^Private\\s+Photo', regex: true }), true);
  assert.equal(matches({ ...base, text: '^private', regex: true, caseSensitive: true }), false);
  assert.equal(matches({ ...base, excludeTerms: 'photo' }), false);
  assert.equal(matches({ ...base, attachmentMode: 'images' }), true);
  assert.equal(matches({ ...base, attachmentMode: 'without' }), false);
  assert.equal(matches({ ...base, linkMode: 'with' }), true);
  assert.equal(matches({ ...base, linkMode: 'without' }), false);
  assert.equal(matches({ ...base, afterDate: '2026-07-01T12:00:00.000Z' }), true);
  assert.equal(matches({ ...base, afterDate: '2026-07-01T12:00:01.000Z' }), false);
  assert.equal(
    harness.test.matchesMessage(
      { ...candidate, author: USER_B },
      base,
      null,
      [],
    ),
    false,
    'messages from another author must never match',
  );
  assert.throws(
    () => harness.test.compileFilters({ ...base, text: '[', regex: true }),
    /Invalid regular expression/,
  );
}

function testQueueOrderingAndConfigValidation() {
  const harness = makeHarness();
  const items = [
    { id: '10', timestamp: '2026-07-03T00:00:00.000Z' },
    { id: '2', timestamp: '2026-07-01T00:00:00.000Z' },
    { id: '5', timestamp: '2026-07-02T00:00:00.000Z' },
    { id: '5', timestamp: '2026-07-02T00:00:00.000Z' },
  ];
  assert.deepEqual(
    Array.from(
      harness.test.prepareQueue(items, { deleteOrder: 'oldest', maxMessages: 2 }),
      (item) => item.id,
    ),
    ['2', '5'],
  );
  assert.deepEqual(
    Array.from(
      harness.test.prepareQueue(items, { deleteOrder: 'newest', maxMessages: 2 }),
      (item) => item.id,
    ),
    ['10', '5'],
  );

  const valid = { ...harness.test.defaultPrefs, riskAccepted: true };
  assert.doesNotThrow(() => harness.test.validateConfig(valid));
  assert.throws(
    () => harness.test.validateConfig({ ...valid, baseDeleteDelayMs: 0 }),
    /outside its safe range/,
  );
  assert.throws(
    () => harness.test.validateConfig({
      ...valid,
      baseDeleteDelayMs: 2000,
      maxAdaptiveDelayMs: 1000,
    }),
    /at least the base deletion delay/,
  );
}

async function testMalformedHistoryCursorFailsClosed() {
  const harness = makeHarness();
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response([
        message({
          id: 'not-a-snowflake',
          content: 'malformed',
          timestamp: '2026-07-01T12:00:00.000Z',
        }),
      ]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.equal(state.status, 'paused');
  assert.equal(state.operation, 'scanning');
  assert.equal(state.queue.length, 0);
}

async function testCorruptedQueueFailsClosed() {
  const harness = makeHarness();
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response([
        message({ id: '850', content: 'owned', timestamp: '2026-07-01T12:00:00.000Z' }),
      ]);
    }
    if (method === 'DELETE') throw new Error('A corrupted queue must never be deleted.');
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  state.queue[0].channelId = '999999999999999999';
  await harness.test.startDelete();

  assert.equal(state.status, 'scanned');
  assert.equal(state.queue.length, 1);
  assert.equal(
    harness.calls.filter((call) => call.method === 'DELETE').length,
    0,
  );
}

async function testRateLimitRecoveryWaits() {
  const harness = makeHarness();
  let deleteAttempts = 0;
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response([
        message({ id: '700', content: 'rate limited', timestamp: '2026-07-01T12:00:00.000Z' }),
      ]);
    }
    if (method === 'DELETE' && url.endsWith('/messages/700')) {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        return response(
          { message: 'You are being rate limited.', retry_after: 0.01, global: false },
          429,
          {
            'Retry-After': '0.01',
            'X-RateLimit-Reset-After': '0.01',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Scope': 'user',
          },
        );
      }
      return response(null, 204);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const startedAt = Date.now();
  await harness.test.startDelete();
  const elapsed = Date.now() - startedAt;
  const state = harness.test.getRunState();

  assert.equal(deleteAttempts, 2);
  assert.equal(state.status, 'complete');
  assert.equal(state.rateLimits, 1);
  assert.ok(elapsed >= 1000, `Retry-After minimum was not respected (${elapsed}ms).`);
}

async function testFatalAuthenticationStopsImmediately() {
  const harness = makeHarness({ stopAfterErrors: 10 });
  let deleteAttempts = 0;
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response([
        message({ id: '900', content: 'auth failure', timestamp: '2026-07-01T12:00:00.000Z' }),
      ]);
    }
    if (method === 'DELETE') {
      deleteAttempts += 1;
      return response({ message: '401: Unauthorized' }, 401);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  await harness.test.startDelete();
  const state = harness.test.getRunState();

  assert.equal(deleteAttempts, 1, 'fatal authentication failures must not enter the normal retry loop');
  assert.equal(state.status, 'paused');
  assert.equal(state.queue.length, 1);
}

async function main() {
  await testCredentialSnifferIgnoresThirdParties();
  await testApiAllowlistBindsMethodPathAndBody();
  await testCappedScanAndDelete();
  await testCompactCheckpointRestoresLockedChannel();
  testFilterMatrix();
  testQueueOrderingAndConfigValidation();
  await testMalformedHistoryCursorFailsClosed();
  await testAccountSwitchFailsClosed();
  await testCorruptedQueueFailsClosed();
  await testRateLimitRecoveryWaits();
  await testFatalAuthenticationStopsImmediately();
  console.log('Userscript scan/delete integration tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
