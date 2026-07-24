const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const rawSource = fs.readFileSync('discord-privacy-eraser.user.js', 'utf8');
const exportBlock = `
  globalThis.__DPE_TEST__ = {
    acceptToken,
    apiRequest,
    compileFilters,
    confirmDeletion,
    configSignature,
    defaultPrefs,
    diagnosticExportText,
    debugId,
    emptyRunState,
    getCurrentUser: () => currentUser,
    getRunState: () => runState,
    getRuntime: () => runtime,
    historyPageDiagnostics,
    finishDeletionConfirmation,
    isolatePanelEvents,
    isDeletableOwnedMessage,
    isDeleteEverythingConfig,
    markShadowHostAsTextEntry,
    matchesMessage,
    prepareQueue,
    recordInvalidRequest,
    resolveCurrentUser,
    retryAfterMs,
    setCurrentUser: (value) => { currentUser = value; },
    setRunState: (value) => { runState = value; },
    setShadow: (value) => { shadow = value; },
    startDelete,
    startContinuousDeletion,
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
  type = 0,
  call,
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
    type,
    ...(call ? { call } : {}),
    edited_timestamp: null,
  };
}

function makeHarness(prefsOverride = {}, storedSeed = null) {
  const stored = storedSeed ? new Map(storedSeed) : new Map();
  const calls = [];
  const prompts = [];
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
    prompt: (text) => {
      prompts.push(text);
      return text.match(/Type exactly: (.+)/)?.[1]?.trim() || '';
    },
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
    includePinned: true,
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
    scanBatchSize: 500,
    matchLogMode: 'full',
    anchorLookupMode: 'history',
    emptyPageConfirmations: 1,
    maxInvalidRequestsPer10Minutes: 20,
    pauseOnNavigate: true,
    autoResume: false,
    riskAccepted: true,
    ...prefsOverride,
  };
  if (!stored.has('dpe:prefs:v4')) {
    stored.set('dpe:prefs:v4', JSON.stringify(prefs));
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
    prompts,
    setFetchHandler(handler) {
      fetchHandler = handler;
    },
    stored,
    test: context.__DPE_TEST__,
  };
}

function historyBefore(url) {
  return new URL(url).searchParams.get('before');
}

function testPanelEditingEventsStayInsideUserscript() {
  const harness = makeHarness();
  const host = {};
  harness.test.markShadowHostAsTextEntry(host);
  assert.equal(host.contentEditable, 'true');
  assert.equal(host.spellcheck, false);

  const listeners = new Map();
  const panel = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  harness.test.isolatePanelEvents(panel);

  for (const type of ['keydown', 'beforeinput', 'input', 'paste', 'compositionupdate']) {
    let stopped = false;
    let stoppedImmediately = false;
    listeners.get(type)({
      stopPropagation() {
        stopped = true;
      },
      stopImmediatePropagation() {
        stoppedImmediately = true;
      },
    });
    assert.equal(stopped, true, `${type} should not bubble into Discord's global handlers`);
    assert.equal(
      stoppedImmediately,
      true,
      `${type} should not reach later Discord listeners on the event path`,
    );
  }
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
  harness.setFetchHandler(async ({ method }) => {
    if (method === 'GET') return response([]);
    throw new Error(`Unexpected ${method}`);
  });

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
  await harness.test.apiRequest(
    `/channels/${TARGET_CHANNEL}/messages?limit=50&before=123`,
  );
  harness.test.setCurrentUser(USER_A);
  harness.test.setRunState({
    ...harness.test.emptyRunState(),
    target: { guildId: '@me', channelId: TARGET_CHANNEL, kind: 'DM / group DM' },
    userId: USER_A.id,
  });
  await harness.test.apiRequest(
    `/channels/${TARGET_CHANNEL}/messages/search?author_id=${USER_A.id}&sort_by=timestamp&sort_order=desc&offset=0&limit=25`,
  );
  await harness.test.apiRequest(
    `/channels/${TARGET_CHANNEL}/messages/search?author_id=${USER_A.id}&sort_by=timestamp&sort_order=desc&max_id=123&offset=0&limit=25`,
  );
  await assert.rejects(
    () => harness.test.apiRequest(
      `/channels/${TARGET_CHANNEL}/messages/search?author_id=${USER_B.id}&sort_by=timestamp&sort_order=desc&offset=0&limit=25`,
    ),
    /Blocked an unexpected Discord API method, path, or body/,
  );
  await assert.rejects(
    () => harness.test.apiRequest(
      `/channels/${TARGET_CHANNEL}/messages/search?author_id=${USER_A.id}&sort_by=timestamp&sort_order=desc&max_id=not-a-snowflake&offset=0&limit=25`,
    ),
    /Blocked an unexpected Discord API method, path, or body/,
  );
  await assert.rejects(
    () => harness.test.apiRequest(
      `/channels/${TARGET_CHANNEL}/messages/search?author_id=${USER_A.id}&sort_by=timestamp&sort_order=desc&max_id=123&max_id=122&offset=0&limit=25`,
    ),
    /Blocked an unexpected Discord API method, path, or body/,
  );
  await assert.rejects(
    () => harness.test.apiRequest(
      `/channels/${TARGET_CHANNEL}/messages?limit=101&before=123`,
    ),
    /Blocked an unexpected Discord API method, path, or body/,
  );
  assert.equal(
    harness.calls.length,
    3,
    'only canonical history and exact account/target-bound author lookups may reach the network',
  );
}

async function testCappedScanAndDelete() {
  const harness = makeHarness({
    maxMessages: 1,
    deleteOrder: 'oldest',
    includePinned: false,
  });
  const newest = '2026-07-03T12:00:00.000Z';
  const middle = '2026-07-02T12:00:00.000Z';
  const oldest = '2026-07-01T12:00:00.000Z';
  const history = [
    message({ id: '300', content: 'newest own', timestamp: newest }),
    message({ id: '250', author: USER_B, content: 'not ours', timestamp: newest }),
    message({ id: '200', content: 'middle own', timestamp: middle }),
    message({ id: '150', content: 'protected pin', pinned: true, timestamp: middle }),
    message({ id: '100', content: 'oldest own', timestamp: oldest }),
  ];

  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response(historyBefore(url) ? [] : history);
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
  assert.match(
    harness.prompts[0],
    new RegExp(`Type exactly: DELETE 1 FROM ${TARGET_CHANNEL}`),
    'the irreversible confirmation must encode the locked channel',
  );
  const diagnostics = harness.test.getRuntime().debugLogs.map((line) => JSON.parse(line));
  for (const event of [
    'deletion-entry',
    'deletion-preflight-start',
    'deletion-preflight-passed',
    'deletion-confirmation-shown',
    'deletion-confirmation-result',
    'deletion-started',
    'delete-request',
    'delete-response',
    'deletion-finished',
  ]) {
    assert.ok(diagnostics.some((entry) => entry.event === event), `${event} must be diagnosed`);
  }
  assert.ok(
    harness.test.getRuntime().logs.some((entry) => /Deleted 1 total/.test(entry.message)),
    'successful deletion progress must be visible in the local activity log',
  );
}

async function testInPanelConfirmationDrivesUiTriggeredDeletion() {
  const harness = makeHarness({ scanDelayMs: 0 });
  const history = [
    message({
      id: '901',
      content: 'inline confirmation target',
      timestamp: '2026-07-01T12:00:00.000Z',
    }),
  ];
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response(historyBefore(url) ? [] : history);
    }
    if (method === 'DELETE' && url.endsWith('/messages/901')) return response(null, 204);
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();

  let focused = false;
  const elements = new Map([
    ['dpe-confirm-overlay', { hidden: true }],
    ['dpe-confirm-details', { textContent: '' }],
    ['dpe-confirm-phrase', { textContent: '' }],
    ['dpe-confirm-input', {
      value: '',
      focus() { focused = true; },
    }],
    ['dpe-confirm-start', { disabled: true }],
  ]);
  harness.test.setShadow({
    getElementById(id) {
      return elements.get(id) || null;
    },
  });

  const deletion = harness.test.startContinuousDeletion();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (harness.test.getRuntime().deletionConfirmation) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const pending = harness.test.getRuntime().deletionConfirmation;
  assert.ok(pending, 'the UI-triggered deletion must wait on the in-panel confirmation');
  assert.equal(elements.get('dpe-confirm-overlay').hidden, false);
  assert.equal(focused, true);
  assert.equal(
    harness.calls.filter((call) => call.method === 'DELETE').length,
    0,
    'no delete request may start before the typed confirmation resolves',
  );
  assert.equal(elements.get('dpe-confirm-phrase').textContent, pending.phrase);

  elements.get('dpe-confirm-input').value = 'wrong phrase';
  assert.equal(harness.test.finishDeletionConfirmation(true), false);
  await deletion;
  assert.equal(harness.test.getRunState().queue.length, 1);
  assert.equal(
    harness.calls.filter((call) => call.method === 'DELETE').length,
    0,
    'a mismatched in-panel phrase must leave the reviewed queue untouched',
  );

  const confirmedDeletion = harness.test.startContinuousDeletion();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (harness.test.getRuntime().deletionConfirmation) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const confirmedPending = harness.test.getRuntime().deletionConfirmation;
  assert.ok(confirmedPending);
  elements.get('dpe-confirm-input').value = confirmedPending.phrase;
  assert.equal(harness.test.finishDeletionConfirmation(true), true);
  await confirmedDeletion;

  const state = harness.test.getRunState();
  assert.equal(state.status, 'complete');
  assert.equal(state.deleted, 1);
  assert.equal(state.queue.length, 0);
  assert.equal(elements.get('dpe-confirm-overlay').hidden, true);
  assert.equal(harness.test.getRuntime().batchLoop, false);
  assert.equal(
    harness.calls.filter((call) => call.method === 'DELETE').length,
    1,
  );
}

async function testShortPagesContinueUntilConfirmedEmpty() {
  const harness = makeHarness({ emptyPageConfirmations: 2 });
  let terminalEmptyResponses = 0;
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      const before = historyBefore(url);
      if (!before) {
        return response([
          message({ id: '300', timestamp: '2026-07-03T00:00:00.000Z' }),
          message({ id: '250', timestamp: '2026-07-02T00:00:00.000Z' }),
        ]);
      }
      if (before === '250') {
        return response([
          message({ id: '100', timestamp: '2026-07-01T00:00:00.000Z' }),
        ]);
      }
      if (before === '100') {
        terminalEmptyResponses += 1;
        return response([]);
      }
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.equal(state.status, 'scanned');
  assert.deepEqual(
    Array.from(state.queue, (item) => item.id),
    ['100', '250', '300'],
    'a short non-empty page must not be treated as the end of history',
  );
  assert.equal(terminalEmptyResponses, 2, 'end-of-history should require confirmation');
}

async function testTransientEmptyPageDoesNotEndScan() {
  const harness = makeHarness({ emptyPageConfirmations: 2 });
  let initialAttempts = 0;
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      const before = historyBefore(url);
      if (!before) {
        initialAttempts += 1;
        if (initialAttempts === 1) return response([]);
        return response([
          message({ id: '600', timestamp: '2026-07-01T00:00:00.000Z' }),
        ]);
      }
      return response([]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.equal(state.status, 'scanned');
  assert.deepEqual(Array.from(state.queue, (item) => item.id), ['600']);
  assert.equal(initialAttempts, 2);
}

async function testNewScanIgnoresStaleCheckpointTarget() {
  const harness = makeHarness();
  harness.test.setRunState({
    ...harness.test.emptyRunState(),
    status: 'scanned',
    target: {
      guildId: '@me',
      channelId: '999999999999999999',
      kind: 'DM / group DM',
    },
    config: { ...harness.prefs },
  });
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      if (historyBefore(url)) return response([]);
      return response([
        message({ id: '610', timestamp: '2026-07-01T00:00:00.000Z' }),
      ]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.equal(state.status, 'scanned');
  assert.equal(state.target.channelId, TARGET_CHANNEL);
  assert.deepEqual(Array.from(state.queue, (item) => item.id), ['610']);
}

async function testFailedScanPreflightPreservesExistingCheckpoint() {
  const harness = makeHarness();
  const oldTarget = {
    guildId: '@me',
    channelId: '999999999999999999',
    kind: 'DM / group DM',
  };
  harness.test.setRunState({
    ...harness.test.emptyRunState(),
    status: 'scanned',
    target: oldTarget,
    config: { ...harness.prefs },
    queue: [{
      id: '777',
      channelId: oldTarget.channelId,
      timestamp: '2026-07-01T00:00:00.000Z',
    }],
  });
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) {
      return response({ message: 'Unauthorized' }, 401);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.equal(state.status, 'scanned');
  assert.equal(state.target.channelId, oldTarget.channelId);
  assert.deepEqual(Array.from(state.queue, (item) => item.id), ['777']);
}

async function testOldestCapBoundsWorkingQueue() {
  const harness = makeHarness({ maxMessages: 2, deleteOrder: 'oldest' });
  let checkedWorkingSet = false;
  const makePage = (high, low) => Array.from(
    { length: high - low + 1 },
    (_, index) => message({
      id: String(high - index),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, high - index)).toISOString(),
    }),
  );
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      const before = historyBefore(url);
      if (!before) return response(makePage(300, 201));
      if (before === '201') {
        assert.ok(
          harness.test.getRunState().queue.length <= 2,
          'capped oldest-first scans must prune the working queue after each page',
        );
        checkedWorkingSet = true;
        return response(makePage(200, 101));
      }
      if (before === '101') return response([]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.equal(checkedWorkingSet, true);
  assert.deepEqual(Array.from(state.queue, (item) => item.id), ['101', '102']);
}

async function testContinuousFiveHundredMessageBatches() {
  const harness = makeHarness({ scanBatchSize: 500, text: 'delete-me' });
  const ownIds = new Set(['700', '600', '500', '400', '300', '200']);
  const page = (high) => Array.from({ length: 100 }, (_, index) => {
    const id = String(high - index);
    const item = message({
      id,
      author: USER_A,
      content: ownIds.has(id) ? 'delete-me' : 'preserve',
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, high - index)).toISOString(),
    });
    if (id === '700') {
      item.pinned = true;
      item.edited_timestamp = '2026-01-01T01:00:00.000Z';
    }
    return item;
  });
  const pages = new Map([
    ['', page(700)],
    ['601', page(600)],
    ['501', page(500)],
    ['401', page(400)],
    ['301', page(300)],
    ['201', page(200)],
    ['101', []],
  ]);
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      const before = historyBefore(url) || '';
      if (!pages.has(before)) throw new Error(`Unexpected batch cursor ${before}`);
      return response(pages.get(before));
    }
    if (method === 'DELETE') {
      const id = url.split('/').at(-1);
      if (!ownIds.has(id)) throw new Error(`Attempted to delete non-owned message ${id}`);
      return response(null, 204);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  let state = harness.test.getRunState();
  assert.equal(state.status, 'scanned');
  assert.equal(state.scannedMessages, 500);
  assert.equal(state.historyComplete, false);
  assert.equal(state.batchOwnedMessages, 500);
  assert.equal(state.batchFilterMatches, 5);
  assert.deepEqual(
    Array.from(state.queue, (item) => item.id),
    ['300', '400', '500', '600', '700'],
  );

  await harness.test.startContinuousDeletion();
  state = harness.test.getRunState();
  assert.equal(state.status, 'complete');
  assert.equal(state.historyComplete, true);
  assert.equal(state.scannedMessages, 600);
  assert.equal(state.deleted, 6);

  const firstDeleteIndex = harness.calls.findIndex((call) => call.method === 'DELETE');
  const sixthHistoryIndex = harness.calls.findIndex(
    (call) => call.method === 'GET' && historyBefore(call.url) === '201',
  );
  assert.ok(firstDeleteIndex > 0 && firstDeleteIndex < sixthHistoryIndex);
}

async function testCustomBatchNeverOvershoots() {
  const harness = makeHarness({ scanBatchSize: 150 });
  const requestedLimits = [];
  const page = (high, count) => Array.from({ length: count }, (_, index) => message({
    id: String(high - index),
    author: USER_A,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, high - index)).toISOString(),
  }));
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      requestedLimits.push(Number(new URL(url).searchParams.get('limit')));
      return response(historyBefore(url) ? page(50, 50) : page(150, 100));
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.deepEqual(requestedLimits, [100, 100]);
  assert.equal(state.scannedMessages, 150);
  assert.equal(state.batchScannedMessages, 150);
  assert.equal(state.status, 'scanned');
}

async function testOwnedBatchDoesNotStopAtOneMatchInFirstFiveHundredHistoryMessages() {
  const harness = makeHarness({ scanBatchSize: 100, scanDelayMs: 0, matchLogMode: 'full' });
  const page = (high, authorForIndex) => Array.from({ length: 100 }, (_, index) => {
    const id = String(high - index);
    const author = authorForIndex(index);
    return message({
      id,
      author,
      content: author.id === USER_A.id ? `owned message ${id}` : `partner message ${id}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, high - index)).toISOString(),
    });
  });
  const partner = () => USER_B;
  const pages = new Map([
    ['', page(1000, (index) => (index === 0 ? USER_A : USER_B))],
    ['901', page(900, partner)],
    ['801', page(800, partner)],
    ['701', page(700, partner)],
    ['601', page(600, partner)],
    ['501', page(500, () => USER_A)],
  ]);
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      const before = historyBefore(url) || '';
      if (!pages.has(before)) throw new Error(`Unexpected sparse-history cursor ${before}`);
      return response(pages.get(before));
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  const runtime = harness.test.getRuntime();

  assert.equal(state.status, 'scanned');
  assert.equal(state.batchOwnedMessages, 100);
  assert.equal(state.batchFilterMatches, 100);
  assert.equal(state.queue.length, 100);
  assert.equal(state.scannedMessages, 599);
  assert.equal(state.scanCursor, '402');
  assert.equal(runtime.matchLogs.length, 100);
  assert.match(runtime.matchLogs[0], /owned message 1000/);
  assert.match(runtime.matchLogs.at(-1), /owned message 402/);

  const diagnostics = runtime.debugLogs.map((line) => JSON.parse(line));
  const historyPages = diagnostics.filter((entry) => entry.event === 'history-page');
  assert.equal(historyPages.length, 6);
  assert.equal(historyPages[0].owned, 1);
  assert.equal(historyPages[0].authors[0].count, 99);
  assert.match(historyPages[0].authors[0].author, /^id#[0-9a-f]{8}:18d$/);
  assert.equal(historyPages[0].authors[1].author, 'self');
  assert.equal(historyPages[0].authors[1].count, 1);
  assert.ok(
    diagnostics.some((entry) => entry.event === 'suspicious-ownership-count'),
    'sparse ownership should make the copyable diagnostic warning explicit',
  );
  const exportedDiagnostics = harness.test.diagnosticExportText();
  assert.doesNotMatch(exportedDiagnostics, /owned message \d|partner message \d/);
  assert.doesNotMatch(exportedDiagnostics, new RegExp(USER_A.id));
  assert.doesNotMatch(exportedDiagnostics, new RegExp(USER_B.id));
  assert.doesNotMatch(exportedDiagnostics, new RegExp(TARGET_CHANNEL));
  assert.match(exportedDiagnostics, /message content.*raw account\/channel\/message IDs.*omitted/i);
}

async function testFastAuthorLookupSnapsToLatestOwnedMessage() {
  const harness = makeHarness({
    scanBatchSize: 100,
    scanDelayMs: 0,
    anchorLookupMode: 'search',
  });
  const anchor = message({
    id: '1000',
    content: 'latest owned message',
    timestamp: '2026-01-01T00:16:40.000Z',
  });
  anchor.hit = true;
  const older = Array.from({ length: 100 }, (_, index) => message({
    id: String(999 - index),
    content: `older owned message ${999 - index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 999 - index)).toISOString(),
  }));
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes('/messages/search?')) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('author_id'), USER_A.id);
      assert.equal(parsed.searchParams.get('sort_by'), 'timestamp');
      assert.equal(parsed.searchParams.get('sort_order'), 'desc');
      assert.equal(parsed.searchParams.get('offset'), '0');
      assert.equal(parsed.searchParams.get('limit'), '25');
      assert.equal(parsed.searchParams.get('max_id'), null);
      return response({ total_results: 100, messages: [[anchor]] });
    }
    if (
      method === 'GET'
      && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)
      && historyBefore(url) === '1000'
    ) {
      return response(older);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  const runtime = harness.test.getRuntime();

  assert.equal(state.status, 'scanned');
  assert.equal(state.anchorMethod, 'search');
  assert.equal(state.skippedNewerMessages, 0);
  assert.equal(state.batchOwnedMessages, 100);
  assert.equal(state.batchFilterMatches, 100);
  assert.equal(state.queue.length, 100);
  assert.equal(state.scannedMessages, 100);
  assert.equal(state.scanCursor, '901');
  assert.equal(
    harness.calls.filter((call) => call.url.includes('/messages/search?')).length,
    1,
  );
  assert.equal(
    harness.calls.filter(
      (call) => call.url.includes(`/channels/${TARGET_CHANNEL}/messages?`) && !historyBefore(call.url),
    ).length,
    0,
    'fast lookup must not walk newer combined history before the owned anchor',
  );
  const searchDiagnostic = runtime.debugLogs
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'search-response');
  assert.equal(searchDiagnostic.hitCount, 1);
  assert.equal(searchDiagnostic.ownedHitCount, 1);
  assert.equal(searchDiagnostic.selectedAuthorMatches, true);
  assert.match(searchDiagnostic.selectedAnchor, /^id#[0-9a-f]{8}:4d$/);
}

async function testCallEventsAreIgnoredAndSparseWindowsJumpToNextDeletableMessage() {
  const harness = makeHarness({
    scanBatchSize: 100,
    scanDelayMs: 0,
    anchorLookupMode: 'search',
  });
  const latestCall = message({
    id: '1100',
    type: 3,
    author: USER_A,
    timestamp: '2026-01-01T00:18:20.000Z',
    call: { participants: [USER_A.id, USER_B.id] },
  });
  latestCall.hit = true;
  const latestText = message({
    id: '1000',
    type: 0,
    author: USER_A,
    content: 'latest real text',
    timestamp: '2026-01-01T00:16:40.000Z',
  });
  latestText.hit = true;
  const nextText = message({
    id: '800',
    type: 0,
    author: USER_A,
    content: 'next real text after sparse window',
    timestamp: '2026-01-01T00:13:20.000Z',
  });
  nextText.hit = true;

  const sparsePage = Array.from({ length: 100 }, (_, index) => message({
    id: String(999 - index),
    type: index === 0 ? 3 : 0,
    author: index === 0 ? USER_A : USER_B,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 999 - index)).toISOString(),
    ...(index === 0 ? { call: { participants: [USER_A.id] } } : {}),
  }));
  const olderOwnedPage = Array.from({ length: 100 }, (_, index) => message({
    id: String(799 - index),
    type: 0,
    author: USER_A,
    content: `older owned ${799 - index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 799 - index)).toISOString(),
  }));

  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes('/messages/search?')) {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('author_id'), USER_A.id);
      assert.equal(parsed.searchParams.get('limit'), '25');
      const maxId = parsed.searchParams.get('max_id');
      if (!maxId) {
        return response({ total_results: 2, messages: [[latestCall], [latestText]] });
      }
      assert.equal(maxId, '900');
      return response({ total_results: 1, messages: [[nextText]] });
    }
    if (
      method === 'GET'
      && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)
      && historyBefore(url) === '1000'
    ) {
      return response(sparsePage);
    }
    if (
      method === 'GET'
      && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)
      && historyBefore(url) === '800'
    ) {
      return response(olderOwnedPage);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  assert.equal(harness.test.isDeletableOwnedMessage(latestCall, USER_A.id), false);
  assert.equal(harness.test.isDeletableOwnedMessage(latestText, USER_A.id), true);
  assert.equal(
    harness.test.isDeletableOwnedMessage(
      message({ id: '1099', type: 19, author: USER_A, timestamp: '2026-01-01T00:18:19.000Z' }),
      USER_A.id,
    ),
    true,
  );
  assert.equal(
    harness.test.isDeletableOwnedMessage(
      message({ id: '1097', type: 6, author: USER_A, timestamp: '2026-01-01T00:18:17.000Z' }),
      USER_A.id,
    ),
    false,
    'deletable system notifications must not be treated as authored content',
  );
  assert.equal(
    harness.test.isDeletableOwnedMessage(
      message({ id: '1098', type: 999, author: USER_A, timestamp: '2026-01-01T00:18:18.000Z' }),
      USER_A.id,
    ),
    false,
    'unknown future message types must fail closed',
  );

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  const runtime = harness.test.getRuntime();

  assert.equal(state.status, 'scanned');
  assert.equal(state.anchorMethod, 'search');
  assert.equal(state.batchOwnedMessages, 100);
  assert.equal(state.batchIgnoredOwnedSystemMessages, 1);
  assert.equal(state.sparseSearchJumps, 1);
  assert.equal(state.queue.length, 100);
  assert.equal(state.scannedMessages, 200);
  assert.equal(state.scanCursor, '702');
  assert.ok(!state.queue.some((item) => item.id === latestCall.id));
  assert.ok(!state.queue.some((item) => item.id === '999'));
  assert.ok(state.queue.some((item) => item.id === latestText.id));
  assert.ok(state.queue.some((item) => item.id === nextText.id));
  assert.equal(
    harness.calls.filter((call) => call.url.includes('/messages/search?')).length,
    2,
  );

  const diagnostics = runtime.debugLogs.map((line) => JSON.parse(line));
  const initialSearch = diagnostics.find(
    (entry) => entry.event === 'search-response' && entry.maxId === 'missing',
  );
  assert.equal(initialSearch.ownedHitCount, 1);
  assert.equal(initialSearch.ignoredOwnedSystemHits, 1);
  assert.equal(initialSearch.selectedType, 0);
  assert.ok(diagnostics.some((entry) => entry.event === 'sparse-window-jump'));
}

async function testSparseJumpRejectsOutOfBoundsHitAndContinuesDirectHistory() {
  const harness = makeHarness({
    scanBatchSize: 100,
    scanDelayMs: 0,
    anchorLookupMode: 'search',
  });
  const latestText = message({
    id: '1000',
    author: USER_A,
    content: 'latest real text',
    timestamp: '2026-01-01T00:16:40.000Z',
  });
  latestText.hit = true;
  const outOfBoundsHit = message({
    id: '950',
    author: USER_A,
    content: 'must be rejected because it is newer than max_id',
    timestamp: '2026-01-01T00:15:50.000Z',
  });
  outOfBoundsHit.hit = true;
  const sparsePage = Array.from({ length: 100 }, (_, index) => message({
    id: String(999 - index),
    author: USER_B,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 999 - index)).toISOString(),
  }));
  const directOlderPage = Array.from({ length: 100 }, (_, index) => message({
    id: String(899 - index),
    author: USER_A,
    content: `direct older ${899 - index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 899 - index)).toISOString(),
  }));

  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes('/messages/search?')) {
      const maxId = new URL(url).searchParams.get('max_id');
      return response({
        total_results: 1,
        messages: [[maxId ? outOfBoundsHit : latestText]],
      });
    }
    if (
      method === 'GET'
      && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)
      && historyBefore(url) === '1000'
    ) {
      return response(sparsePage);
    }
    if (
      method === 'GET'
      && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)
      && historyBefore(url) === '900'
    ) {
      return response(directOlderPage);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  const diagnostics = harness.test.getRuntime().debugLogs.map((line) => JSON.parse(line));

  assert.equal(state.status, 'scanned');
  assert.equal(state.sparseSearchJumps, 0);
  assert.equal(state.batchOwnedMessages, 100);
  assert.equal(state.queue.length, 100);
  assert.ok(!state.queue.some((item) => item.id === outOfBoundsHit.id));
  assert.ok(harness.calls.some(
    (call) => call.url.includes(`/channels/${TARGET_CHANNEL}/messages?`)
      && historyBefore(call.url) === '900',
  ));
  assert.ok(!diagnostics.some((entry) => entry.event === 'sparse-window-jump'));
}

async function testFastAuthorLookupFallsBackOnInvalidHit() {
  const harness = makeHarness({
    scanBatchSize: 100,
    scanDelayMs: 0,
    anchorLookupMode: 'search',
  });
  const invalidHit = message({
    id: '1000',
    author: USER_B,
    timestamp: '2026-01-01T00:16:40.000Z',
  });
  invalidHit.hit = true;
  const directHistory = Array.from({ length: 100 }, (_, index) => message({
    id: String(900 - index),
    content: `direct fallback ${900 - index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 900 - index)).toISOString(),
  }));
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes('/messages/search?')) {
      return response({ total_results: 1, messages: [[invalidHit]] });
    }
    if (
      method === 'GET'
      && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)
      && !historyBefore(url)
    ) {
      return response(directHistory);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();

  assert.equal(state.status, 'scanned');
  assert.equal(state.anchorMethod, 'history');
  assert.equal(state.batchOwnedMessages, 100);
  assert.equal(state.queue.length, 100);
  assert.equal(
    harness.calls.filter((call) => call.url.includes('/messages/search?')).length,
    1,
  );
  assert.equal(
    harness.calls.filter(
      (call) => call.url.includes(`/channels/${TARGET_CHANNEL}/messages?`) && !historyBefore(call.url),
    ).length,
    1,
  );
}

async function testFirstBatchAnchorsAtLatestOwnedMessage() {
  const harness = makeHarness({ scanBatchSize: 100, scanDelayMs: 0 });
  const page = (high, count, ownIds = new Set()) => Array.from(
    { length: count },
    (_, index) => {
      const id = String(high - index);
      return message({
        id,
        author: ownIds.has(id) ? USER_A : USER_B,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, high - index)).toISOString(),
      });
    },
  );
  const pages = new Map([
    ['', page(1000, 100)],
    ['901', page(900, 100)],
    ['801', page(800, 100)],
    ['701', page(700, 100, new Set(['650', '620']))],
    ['601', page(600, 100, new Set(Array.from({ length: 100 }, (_, index) => String(600 - index))))],
  ]);
  const requestedLimits = [];
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      requestedLimits.push(Number(new URL(url).searchParams.get('limit')));
      const before = historyBefore(url) || '';
      if (!pages.has(before)) throw new Error(`Unexpected anchor cursor ${before}`);
      return response(pages.get(before));
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();

  assert.equal(state.status, 'scanned');
  assert.equal(state.anchorFound, true);
  assert.equal(state.skippedNewerMessages, 350);
  assert.equal(state.scannedMessages, 498);
  assert.equal(state.batchScannedMessages, 148);
  assert.equal(state.batchOwnedMessages, 100);
  assert.equal(state.batchFilterMatches, 100);
  assert.deepEqual(requestedLimits, [100, 100, 100, 100, 100]);
  assert.equal(state.queue.length, 100);
  assert.equal(state.queue.at(-1).id, '650');
  assert.equal(state.scanCursor, '503');
}

async function testLatestMessageSeekHasNoFixedDelay() {
  const harness = makeHarness({ scanBatchSize: 100, scanDelayMs: 60000 });
  const page = (high, author, allOwned = false) => Array.from({ length: 100 }, (_, index) => message({
    id: String(high - index),
    author: allOwned ? author : (index === 0 ? author : USER_B),
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, high - index)).toISOString(),
  }));
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response(historyBefore(url) ? page(100, USER_A, true) : page(200, USER_B));
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  const startedAt = Date.now();
  await harness.test.startScan();
  const elapsedMs = Date.now() - startedAt;
  const state = harness.test.getRunState();

  assert.equal(state.skippedNewerMessages, 100);
  assert.equal(state.batchScannedMessages, 100);
  assert.ok(
    elapsedMs < 5000,
    `latest-message seek should not apply the configured 60s batch delay (took ${elapsedMs}ms)`,
  );
}

async function testLatestMessageSeekCompletesWhenNoOwnedMessageExists() {
  const harness = makeHarness({ scanDelayMs: 0 });
  const partnerPage = Array.from({ length: 100 }, (_, index) => message({
    id: String(200 - index),
    author: USER_B,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 200 - index)).toISOString(),
  }));
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response(historyBefore(url) ? [] : partnerPage);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();

  assert.equal(state.status, 'complete');
  assert.equal(state.anchorFound, false);
  assert.equal(state.skippedNewerMessages, 100);
  assert.equal(state.queue.length, 0);
}

async function testContinuousBatchingStopsOnUnchangedPreflightFailure() {
  const harness = makeHarness({ scanBatchSize: 500 });
  let identityRequests = 0;
  const page = (high) => Array.from({ length: 100 }, (_, index) => message({
    id: String(high - index),
    author: high === 500 && index === 0 ? USER_A : USER_B,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, high - index)).toISOString(),
  }));
  const pages = new Map([
    ['', page(500)],
    ['401', page(400)],
    ['301', page(300)],
    ['201', page(200)],
    ['101', page(100)],
  ]);
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) {
      identityRequests += 1;
      return response(identityRequests <= 2 ? USER_A : USER_B);
    }
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      const before = historyBefore(url) || '';
      return response(pages.get(before));
    }
    if (method === 'DELETE' && url.endsWith('/messages/500')) return response(null, 204);
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  await harness.test.startContinuousDeletion();
  const state = harness.test.getRunState();

  assert.equal(identityRequests, 3, 'an unchanged failed preflight must not spin');
  assert.equal(state.status, 'batch-complete');
  assert.equal(state.operation, 'batching');
  assert.equal(state.deleted, 1);
}

async function testCompletedBoundaryCheckpointDoesNotOverscan() {
  const harness = makeHarness({ scanBatchSize: 100 });
  let historyRequests = 0;
  const firstPage = Array.from({ length: 100 }, (_, index) => message({
    id: String(100 - index),
    author: USER_A,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - index)).toISOString(),
  }));
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      historyRequests += 1;
      if (historyRequests === 1) return response(firstPage);
      throw new Error('A resumed completed batch must not fetch another history message.');
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const interrupted = harness.test.getRunState();
  harness.test.setRunState({
    ...interrupted,
    status: 'stopped',
    operation: 'scanning',
  });

  await harness.test.startScan({ resume: true });
  const state = harness.test.getRunState();
  assert.equal(historyRequests, 1);
  assert.equal(state.status, 'scanned');
  assert.equal(state.queue.length, 100);
  assert.equal(state.queue.at(-1).id, '100');
}

async function testEmptyDeletionCheckpointAdvancesSafely() {
  const harness = makeHarness({ scanBatchSize: 100 });
  const firstPage = Array.from({ length: 100 }, (_, index) => message({
    id: String(100 - index),
    author: USER_A,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - index)).toISOString(),
  }));
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response(historyBefore(url) ? [] : firstPage);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const interrupted = harness.test.getRunState();
  harness.test.setRunState({
    ...interrupted,
    status: 'deleting',
    operation: 'deleting',
    confirmed: true,
    queue: [],
    queueDigest: '',
    deleted: 1,
    batchProcessed: 1,
  });

  await harness.test.startContinuousDeletion({ continueFromCheckpoint: true });
  const state = harness.test.getRunState();
  assert.equal(state.status, 'complete');
  assert.equal(state.historyComplete, true);
  assert.equal(state.deleted, 1);
  assert.equal(state.scannedMessages, 100);
}

async function testCompactCheckpointRestoresLockedChannel() {
  const first = makeHarness();
  first.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      if (historyBefore(url)) return response([]);
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
  delete serialized.config.emptyPageConfirmations;
  delete serialized.config.maxInvalidRequestsPer10Minutes;
  delete serialized.config.scanBatchSize;
  delete serialized.config.matchLogMode;
  delete serialized.config.anchorLookupMode;
  delete serialized.anchorMethod;
  delete serialized.historyComplete;
  serialized.signature = first.test.configSignature(
    serialized.config,
    serialized.target,
    serialized.userId,
  );
  serialized.queueDigest = 'stale-checksum-from-an-older-config-signature';
  first.stored.set('dpe:run:v1', JSON.stringify(serialized));

  const reloaded = makeHarness({}, first.stored);
  const restored = reloaded.test.getRunState();
  assert.equal(restored.status, 'scanned');
  assert.equal(restored.queue.length, 1);
  assert.equal(restored.queue[0].id, '400');
  assert.equal(restored.queue[0].channelId, TARGET_CHANNEL);
  assert.equal(restored.config.emptyPageConfirmations, 2);
  assert.equal(restored.config.maxInvalidRequestsPer10Minutes, 20);
  assert.equal(restored.config.scanBatchSize, 500);
  assert.equal(restored.config.matchLogMode, 'full');
  assert.equal(restored.config.anchorLookupMode, 'search');
  assert.equal(restored.batchMode, 'owned');
  assert.equal(
    restored.historyComplete,
    true,
    'a migrated checkpoint without a history marker must not expand its reviewed scope',
  );
  assert.notEqual(
    restored.queueDigest,
    'stale-checksum-from-an-older-config-signature',
    'migrated checkpoints must receive a checksum bound to the migrated signature',
  );
  assert.equal(
    restored.signature,
    reloaded.test.configSignature(restored.config, restored.target, restored.userId),
    'adding safe defaults must migrate the checkpoint signature',
  );
}

function testPreEligibilityCheckpointIsInvalidated() {
  const harness = makeHarness();
  const oldCheckpoint = {
    ...harness.test.emptyRunState(),
    status: 'scanned',
    target: { guildId: '@me', channelId: TARGET_CHANNEL, kind: 'DM / group DM' },
    userId: USER_A.id,
    queue: [['999', '2026-01-01T00:00:00.000Z']],
  };
  delete oldCheckpoint.eligibilityVersion;
  harness.stored.set('dpe:run:v1', JSON.stringify(oldCheckpoint));

  const reloaded = makeHarness({}, harness.stored);
  const restored = reloaded.test.getRunState();
  assert.equal(restored.status, 'idle');
  assert.equal(restored.queue.length, 0);
  assert.equal(restored.eligibilityVersion, 2);
}

async function testPersistedCooldownSurvivesReload() {
  const first = makeHarness();
  first.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      if (historyBefore(url)) return response([]);
      return response([
        message({ id: '410', content: 'cool down', timestamp: '2026-07-01T12:00:00.000Z' }),
      ]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });
  first.test.acceptToken(TOKEN_A);
  await first.test.startScan();

  const saved = JSON.parse(first.stored.get('dpe:run:v1'));
  const cooldownUntil = Date.now() + 650;
  saved.rateLimitUntil = cooldownUntil;
  saved.learnedDeleteDelayMs = 900;
  first.stored.set('dpe:run:v1', JSON.stringify(saved));

  const reloaded = makeHarness({}, first.stored);
  let firstRequestAt = 0;
  reloaded.setFetchHandler(async ({ url, method }) => {
    if (!firstRequestAt) firstRequestAt = Date.now();
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'DELETE' && url.endsWith('/messages/410')) return response(null, 204);
    throw new Error(`Unexpected ${method} ${url}`);
  });
  reloaded.test.acceptToken(TOKEN_A);
  const startedAt = Date.now();
  await reloaded.test.startDelete();

  assert.ok(
    firstRequestAt - startedAt >= 550,
    'a reload must not discard an active Discord cooldown window',
  );
  assert.ok(
    reloaded.test.getRuntime().adaptiveDeleteDelayMs >= 900,
    'learned deletion pacing should survive reload',
  );
}

async function testAccountSwitchFailsClosed() {
  const harness = makeHarness();
  let activeIdentity = USER_A;
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) {
      return response(activeIdentity);
    }
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      if (historyBefore(url)) return response([]);
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
  assert.equal(harness.test.isDeleteEverythingConfig(base), true);
  assert.equal(
    matchesMessageForConfig(harness, {
      ...candidate,
      pinned: true,
      edited_timestamp: '2026-07-01T12:30:00.000Z',
    }, base),
    true,
    'the default no-filter scope must include pinned and edited messages',
  );
  assert.equal(
    harness.test.isDeleteEverythingConfig({ ...base, includePinned: false }),
    false,
  );
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

  const oldCandidate = {
    ...candidate,
    timestamp: '2020-01-01T00:00:00.000Z',
  };
  assert.equal(
    harness.test.matchesMessage(
      oldCandidate,
      { ...base, minMessageAgeHours: 1 },
      null,
      [],
      new Date('2020-01-01T02:00:00.000Z').getTime(),
    ),
    true,
    'age filtering should use the dry-run reference time instead of wall-clock drift',
  );
}

function matchesMessageForConfig(harness, candidate, config) {
  const compiled = harness.test.compileFilters(config);
  return harness.test.matchesMessage(
    candidate,
    config,
    compiled.compiledRegex,
    compiled.excludedTerms,
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
  assert.doesNotThrow(
    () => harness.test.validateConfig({ ...valid, scanDelayMs: 0 }),
    'zero artificial batch-scan delay remains protected by live Discord rate-limit handling',
  );
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

function testInvalidRequestClassificationAndWindowPruning() {
  const harness = makeHarness({ maxInvalidRequestsPer10Minutes: 2 });
  harness.test.setRunState({
    ...harness.test.emptyRunState(),
    config: { ...harness.prefs, maxInvalidRequestsPer10Minutes: 2 },
    invalidRequestTimes: [Date.now() - (11 * 60 * 1000)],
  });

  assert.deepEqual(
    { ...harness.test.recordInvalidRequest(429, 'shared') },
    { count: 0, tripped: false },
    'shared-resource 429 responses do not count toward Discord invalid requests',
  );
  assert.deepEqual(
    { ...harness.test.recordInvalidRequest(403) },
    { count: 1, tripped: false },
    'expired timestamps should be pruned from the rolling window',
  );
  assert.deepEqual(
    { ...harness.test.recordInvalidRequest(429, 'user') },
    { count: 2, tripped: true },
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

async function testOutOfOrderHistoryFailsClosed() {
  const harness = makeHarness();
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response([
        message({ id: '100', timestamp: '2026-07-01T00:00:00.000Z' }),
        message({ id: '200', timestamp: '2026-07-02T00:00:00.000Z' }),
      ]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.equal(state.status, 'paused');
  assert.equal(state.operation, 'scanning');
  assert.equal(state.queue.length, 0, 'an invalid page must never partially populate the queue');
}

async function testCrossChannelHistoryFailsClosed() {
  const harness = makeHarness();
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      return response([
        message({
          id: '350',
          timestamp: '2026-07-03T00:00:00.000Z',
          channelId: '999999999999999999',
        }),
      ]);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  const state = harness.test.getRunState();
  assert.equal(state.status, 'paused');
  assert.equal(state.queue.length, 0);
}

async function testCorruptedQueueFailsClosed() {
  const harness = makeHarness();
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      if (historyBefore(url)) return response([]);
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
  state.queue[0].id = '851';
  await harness.test.startDelete();

  assert.equal(state.status, 'scanned');
  assert.equal(state.queue.length, 1);
  assert.equal(
    harness.calls.filter((call) => call.method === 'DELETE').length,
    0,
  );
}

async function testRateLimitRecoveryWaits() {
  const harness = makeHarness({ baseDeleteDelayMs: 1000 });
  let deleteAttempts = 0;
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      if (historyBefore(url)) return response([]);
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
  assert.ok(
    elapsed >= 1500,
    `adaptive fallback must extend an unrealistically short Retry-After (${elapsed}ms).`,
  );
  assert.ok(state.learnedDeleteDelayMs >= 1500);
  assert.ok(state.rateLimitUntil > 0);
}

async function testFatalAuthenticationStopsImmediately() {
  const harness = makeHarness({ stopAfterErrors: 10 });
  let deleteAttempts = 0;
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      if (historyBefore(url)) return response([]);
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

async function testInvalidRequestCircuitBreakerSurvivesMixedSuccess() {
  const harness = makeHarness({
    maxInvalidRequestsPer10Minutes: 2,
    stopAfterErrors: 10,
  });
  harness.setFetchHandler(async ({ url, method }) => {
    if (method === 'GET' && url.endsWith('/users/@me')) return response(USER_A);
    if (method === 'GET' && url.includes(`/channels/${TARGET_CHANNEL}/messages?`)) {
      if (historyBefore(url)) return response([]);
      return response([
        message({ id: '300', timestamp: '2026-07-03T00:00:00.000Z' }),
        message({ id: '200', timestamp: '2026-07-02T00:00:00.000Z' }),
        message({ id: '100', timestamp: '2026-07-01T00:00:00.000Z' }),
      ]);
    }
    if (method === 'DELETE' && url.endsWith('/messages/100')) {
      return response({ message: 'Cannot delete this entry.' }, 403);
    }
    if (method === 'DELETE' && url.endsWith('/messages/200')) return response(null, 204);
    if (method === 'DELETE' && url.endsWith('/messages/300')) {
      return response({ message: 'Cannot delete this entry.' }, 403);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });

  harness.test.acceptToken(TOKEN_A);
  await harness.test.startScan();
  await harness.test.startDelete();
  const state = harness.test.getRunState();

  assert.equal(state.status, 'paused');
  assert.deepEqual(
    Array.from(state.queue, (item) => item.id),
    ['300'],
    'the threshold request must remain queued for later review',
  );
  assert.equal(state.invalidRequestTimes.length, 2);
}

async function main() {
  testPanelEditingEventsStayInsideUserscript();
  await testCredentialSnifferIgnoresThirdParties();
  await testApiAllowlistBindsMethodPathAndBody();
  await testCappedScanAndDelete();
  await testInPanelConfirmationDrivesUiTriggeredDeletion();
  await testShortPagesContinueUntilConfirmedEmpty();
  await testTransientEmptyPageDoesNotEndScan();
  await testNewScanIgnoresStaleCheckpointTarget();
  await testFailedScanPreflightPreservesExistingCheckpoint();
  await testOldestCapBoundsWorkingQueue();
  await testContinuousFiveHundredMessageBatches();
  await testCustomBatchNeverOvershoots();
  await testOwnedBatchDoesNotStopAtOneMatchInFirstFiveHundredHistoryMessages();
  await testFastAuthorLookupSnapsToLatestOwnedMessage();
  await testCallEventsAreIgnoredAndSparseWindowsJumpToNextDeletableMessage();
  await testSparseJumpRejectsOutOfBoundsHitAndContinuesDirectHistory();
  await testFastAuthorLookupFallsBackOnInvalidHit();
  await testFirstBatchAnchorsAtLatestOwnedMessage();
  await testLatestMessageSeekHasNoFixedDelay();
  await testLatestMessageSeekCompletesWhenNoOwnedMessageExists();
  await testContinuousBatchingStopsOnUnchangedPreflightFailure();
  await testCompletedBoundaryCheckpointDoesNotOverscan();
  await testEmptyDeletionCheckpointAdvancesSafely();
  await testCompactCheckpointRestoresLockedChannel();
  testPreEligibilityCheckpointIsInvalidated();
  await testPersistedCooldownSurvivesReload();
  testFilterMatrix();
  testQueueOrderingAndConfigValidation();
  testInvalidRequestClassificationAndWindowPruning();
  await testMalformedHistoryCursorFailsClosed();
  await testOutOfOrderHistoryFailsClosed();
  await testCrossChannelHistoryFailsClosed();
  await testAccountSwitchFailsClosed();
  await testCorruptedQueueFailsClosed();
  await testRateLimitRecoveryWaits();
  await testFatalAuthenticationStopsImmediately();
  await testInvalidRequestCircuitBreakerSurvivesMixedSuccess();
  console.log('Userscript scan/delete integration tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
