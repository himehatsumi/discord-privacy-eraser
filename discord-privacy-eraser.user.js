// ==UserScript==
// @name         Discord Privacy Eraser (Current Channel / DM)
// @namespace    local.codex.discord-privacy-eraser
// @version      1.6.1
// @description  Preview, filter, and delete only your own messages in the currently open Discord channel or DM.
// @author       Codex
// @match        https://discord.com/channels/*
// @match        https://canary.discord.com/channels/*
// @match        https://ptb.discord.com/channels/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// ==/UserScript==

(() => {
  'use strict';

  /*
   * SECURITY MODEL
   * - Only runs on Discord channel pages.
   * - Only calls same-origin /api/v9 or /api/v10 endpoints.
   * - Never asks for, displays, logs, copies, exports, or persists the account token.
   * - Verifies every queued message was authored by /users/@me before deletion.
   * - Locks each run to the current channel/DM and requires a dry run + typed confirmation.
   * - Does not load remote code or fetch attachments.
   *
   * PLATFORM NOTE
   * Discord says automating a normal account is prohibited self-botting and may lead
   * to account action. This script is intentionally narrow, slow, and rate-limit-aware,
   * but that platform-policy risk cannot be removed by code.
   */

  const SCRIPT = Object.freeze({
    name: 'Discord Privacy Eraser',
    version: '1.6.1',
    prefsKey: 'dpe:prefs:v4',
    legacyPrefsKeys: ['dpe:prefs:v1', 'dpe:prefs:v2', 'dpe:prefs:v3'],
    runKey: 'dpe:run:v1',
    apiVersions: ['10', '9'],
    maxLogLines: 180,
    maxDebugLines: 2000,
    maxSavedFailures: 2000,
    invalidRequestWindowMs: 10 * 60 * 1000,
  });

  // Discord documents DEFAULT, REPLY, CHAT_INPUT_COMMAND, and
  // CONTEXT_MENU_COMMAND as normal user-content message types. Limit this
  // author-only tool to those types so calls and other authored system events
  // cannot anchor a batch or enter a deletion queue. Unknown future types fail
  // closed until they are reviewed explicitly.
  const OWNED_CONTENT_MESSAGE_TYPES = new Set([0, 19, 20, 23]);

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const nativeFetch = typeof pageWindow.fetch === 'function'
    ? pageWindow.fetch.bind(pageWindow)
    : fetch.bind(window);

  let authToken = '';
  let capturedSuperProperties = '';
  let apiVersion = SCRIPT.apiVersions[0];
  let currentUser = null;
  let rootHost = null;
  let shadow = null;
  let autoResumeTimer = null;
  let autoResumeInterval = null;
  let lastKnownUrl = location.href;
  let storageWarningShown = false;

  const runtime = {
    mode: 'idle',
    paused: false,
    stopped: false,
    pauseReason: '',
    wakeWaiters: [],
    adaptiveDeleteDelayMs: 0,
    headerDeleteDelayMs: 0,
    successesSinceLimit: 0,
    nextAllowedAt: 0,
    startedAt: 0,
    requestController: null,
    activeTarget: null,
    preflight: false,
    batchLoop: false,
    logs: [],
    matchLogs: [],
    debugLogs: [],
    debugEventCount: 0,
    suspiciousOwnershipWarningShown: false,
    deletionConfirmation: null,
  };

  class StopSignal extends Error {
    constructor() {
      super('Operation stopped');
      this.name = 'StopSignal';
    }
  }

  class FatalApiError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'FatalApiError';
      this.status = status;
    }
  }

  const defaultPrefs = Object.freeze({
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
    baseDeleteDelayMs: 1100,
    maxAdaptiveDelayMs: 30000,
    jitterPercent: 15,
    maxRetries: 12,
    stopAfterErrors: 5,
    checkpointEvery: 50,
    scanBatchSize: 500,
    matchLogMode: 'full',
    anchorLookupMode: 'search',
    emptyPageConfirmations: 2,
    maxInvalidRequestsPer10Minutes: 20,
    pauseOnNavigate: true,
    autoResume: false,
    riskAccepted: false,
  });

  function normalizeToken(value) {
    if (typeof value !== 'string') return '';
    let candidate = value.trim();
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'string') candidate = parsed.trim();
    } catch {}
    if (/^(Bot|Bearer)\s/i.test(candidate)) return '';
    if (candidate.length < 20 || /\s/.test(candidate)) return '';
    return candidate;
  }

  function acceptToken(value) {
    const normalized = normalizeToken(value);
    if (!normalized) return false;
    if (authToken && authToken !== normalized) {
      // Force a fresh identity check before further deletion if this Discord
      // tab changes accounts without doing a full page reload.
      currentUser = null;
    }
    authToken = normalized;
    updateAuthStatus();
    return true;
  }

  function acceptSuperProperties(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length >= 20 && trimmed.length <= 4096) {
      capturedSuperProperties = trimmed;
    }
  }

  function sniffHeaders(headers) {
    if (!headers) return;
    try {
      if (typeof headers.get === 'function') {
        acceptToken(headers.get('Authorization') || headers.get('authorization') || '');
        acceptSuperProperties(
          headers.get('X-Super-Properties') || headers.get('x-super-properties') || '',
        );
        return;
      }
      if (Array.isArray(headers)) {
        for (const entry of headers) {
          if (!Array.isArray(entry) || entry.length < 2) continue;
          const key = String(entry[0]).toLowerCase();
          if (key === 'authorization') acceptToken(String(entry[1]));
          if (key === 'x-super-properties') acceptSuperProperties(String(entry[1]));
        }
        return;
      }
      if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          const lower = key.toLowerCase();
          if (lower === 'authorization') acceptToken(String(value));
          if (lower === 'x-super-properties') acceptSuperProperties(String(value));
        }
      }
    } catch {}
  }

  function isSameOriginDiscordApi(input) {
    try {
      const rawUrl = typeof input === 'string' ? input : input?.url;
      if (!rawUrl) return false;
      const url = new URL(rawUrl, location.origin);
      return url.origin === location.origin && url.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  }

  function installCredentialSniffer() {
    try {
      const originalFetch = pageWindow.fetch;
      if (typeof originalFetch === 'function' && !originalFetch.__dpeWrapped) {
        const wrappedFetch = function (...args) {
          try {
            if (isSameOriginDiscordApi(args[0])) {
              sniffHeaders(args[0]?.headers);
              sniffHeaders(args[1]?.headers);
            }
          } catch {}
          return originalFetch.apply(this, args);
        };
        Object.defineProperty(wrappedFetch, '__dpeWrapped', { value: true });
        pageWindow.fetch = wrappedFetch;
      }
    } catch {}

    try {
      const proto = pageWindow.XMLHttpRequest?.prototype;
      if (!proto || proto.setRequestHeader.__dpeWrapped) return;
      const originalOpen = proto.open;
      const originalSetRequestHeader = proto.setRequestHeader;
      const originalSend = proto.send;

      proto.open = function (method, url, ...rest) {
        try {
          this.__dpeUrl = String(url);
          this.__dpeHeaders = {};
        } catch {}
        return originalOpen.call(this, method, url, ...rest);
      };

      const wrappedSetRequestHeader = function (key, value) {
        try {
          this.__dpeHeaders ||= {};
          this.__dpeHeaders[String(key).toLowerCase()] = String(value);
        } catch {}
        return originalSetRequestHeader.call(this, key, value);
      };
      Object.defineProperty(wrappedSetRequestHeader, '__dpeWrapped', { value: true });
      proto.setRequestHeader = wrappedSetRequestHeader;

      proto.send = function (...args) {
        try {
          const url = new URL(this.__dpeUrl, location.origin);
          if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
            acceptToken(this.__dpeHeaders?.authorization || '');
            acceptSuperProperties(this.__dpeHeaders?.['x-super-properties'] || '');
          }
        } catch {}
        return originalSend.apply(this, args);
      };
    } catch {}
  }

  function tryWebpackToken() {
    if (authToken) return authToken;
    try {
      const chunks = pageWindow.webpackChunkdiscord_app;
      if (!Array.isArray(chunks)) return '';
      let webpackRequire = null;
      const chunkId = `dpe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      chunks.push([[chunkId], {}, (requireFn) => { webpackRequire = requireFn; }]);
      chunks.pop();
      if (!webpackRequire?.c) return '';

      for (const moduleRecord of Object.values(webpackRequire.c)) {
        const exportsValue = moduleRecord?.exports;
        if (!exportsValue) continue;
        const candidates = [
          exportsValue,
          exportsValue.default,
          ...(
            typeof exportsValue === 'object'
              ? Object.values(exportsValue).slice(0, 30)
              : []
          ),
        ];
        for (const candidate of candidates) {
          if (!candidate) continue;
          for (const method of ['getToken', 'getAuthorizationToken']) {
            try {
              if (typeof candidate[method] !== 'function') continue;
              const value = candidate[method]();
              if (acceptToken(String(value || ''))) return authToken;
            } catch {}
          }
        }
      }
    } catch {}
    return '';
  }

  function readLegacyLocalToken() {
    if (authToken) return authToken;
    try {
      acceptToken(pageWindow.localStorage?.getItem('token') || '');
    } catch {}
    return authToken;
  }

  installCredentialSniffer();

  function parseJson(value, fallback) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function storageGet(key, fallback) {
    try {
      const value = GM_getValue(key);
      return value === undefined ? fallback : parseJson(value, fallback);
    } catch {
      return fallback;
    }
  }

  function storageSet(key, value) {
    const serialized = JSON.stringify(value);
    try {
      GM_setValue(key, serialized);
      return true;
    } catch {
      if (!storageWarningShown) {
        storageWarningShown = true;
        log('warn', 'Private checkpoint storage is unavailable or full; the run can continue, but reload recovery is unavailable.');
      }
      return false;
    }
  }

  function storageDelete(key) {
    try {
      GM_deleteValue(key);
    } catch {}
  }

  function removeLegacyPageState() {
    // Version 1.0 could fall back to Discord-origin localStorage if private
    // userscript storage failed. Remove only this script's old namespaced keys.
    try {
      pageWindow.localStorage?.removeItem(SCRIPT.prefsKey);
      for (const key of SCRIPT.legacyPrefsKeys) {
        pageWindow.localStorage?.removeItem(key);
      }
      pageWindow.localStorage?.removeItem(SCRIPT.runKey);
    } catch {}
  }

  removeLegacyPageState();

  function loadPrefs() {
    const saved = storageGet(SCRIPT.prefsKey, {});
    return { ...defaultPrefs, ...(saved && typeof saved === 'object' ? saved : {}) };
  }

  function savePrefs(prefs) {
    storageSet(SCRIPT.prefsKey, prefs);
  }

  function emptyRunState() {
    return {
      version: 1,
      eligibilityVersion: 2,
      status: 'idle',
      operation: '',
      savedAt: 0,
      target: null,
      userId: '',
      signature: '',
      config: null,
      queue: [],
      queueDigest: '',
      failures: [],
      scanCursor: '',
      historyComplete: false,
      anchorFound: false,
      anchorMethod: '',
      skippedNewerMessages: 0,
      sparseSearchJumps: 0,
      batchMode: 'owned',
      batchNumber: 1,
      batchScannedMessages: 0,
      batchOwnedMessages: 0,
      batchIgnoredOwnedSystemMessages: 0,
      batchFilterMatches: 0,
      batchProcessed: 0,
      scannedPages: 0,
      scannedMessages: 0,
      matchedMessages: 0,
      initialMatches: 0,
      deleted: 0,
      alreadyGone: 0,
      failed: 0,
      rateLimits: 0,
      confirmed: false,
      firstTimestamp: '',
      lastTimestamp: '',
      filterReferenceTime: 0,
      rateLimitUntil: 0,
      learnedDeleteDelayMs: 0,
      invalidRequestTimes: [],
    };
  }

  function loadRunState() {
    const saved = storageGet(SCRIPT.runKey, null);
    if (
      !saved
      || saved.version !== 1
      || saved.eligibilityVersion !== 2
      || saved.batchMode !== 'owned'
      || !Array.isArray(saved.queue)
    ) {
      return emptyRunState();
    }
    const targetChannelId = String(saved.target?.channelId || '');
    let config = saved.config;
    let signature = saved.signature;
    const addedConfigDefaults = {};
    for (const field of [
      'emptyPageConfirmations',
      'maxInvalidRequestsPer10Minutes',
      'scanBatchSize',
      'matchLogMode',
      'anchorLookupMode',
    ]) {
      if (config && config[field] === undefined) {
        addedConfigDefaults[field] = defaultPrefs[field];
      }
    }
    const configWasMigrated = config && Object.keys(addedConfigDefaults).length > 0;
    if (configWasMigrated) {
      config = { ...config, ...addedConfigDefaults };
      signature = configSignature(config, saved.target, saved.userId);
    }
    const unpack = (item) => {
      if (!Array.isArray(item)) return item;
      return {
        id: String(item[0] || ''),
        channelId: targetChannelId,
        timestamp: String(item[1] || ''),
      };
    };
    const loaded = {
      ...emptyRunState(),
      ...saved,
      config,
      signature,
      batchMode: 'owned',
      anchorFound: saved.anchorFound === undefined
        ? true
        : Boolean(saved.anchorFound),
      // Pre-1.3 runs were single-queue workflows. Treat their completed scan
      // scope as final so upgrading cannot silently expand a prior confirmation
      // into the new multi-batch behavior.
      historyComplete: saved.historyComplete === undefined
        ? true
        : Boolean(saved.historyComplete),
      filterReferenceTime: Number.isFinite(saved.filterReferenceTime)
        ? saved.filterReferenceTime
        : (Number.isFinite(saved.savedAt) ? saved.savedAt : 0),
      queue: saved.queue.map(unpack).filter((item) => item?.id),
      failures: Array.isArray(saved.failures)
        ? saved.failures.map(unpack).filter((item) => item?.id)
        : [],
      invalidRequestTimes: Array.isArray(saved.invalidRequestTimes)
        ? saved.invalidRequestTimes
          .filter((time) => Number.isFinite(time) && time > Date.now() - SCRIPT.invalidRequestWindowMs)
          .slice(-1000)
        : [],
    };
    if (
      (configWasMigrated || !loaded.queueDigest || saved.batchMode === undefined)
      && loaded.queue.length > 0
    ) {
      loaded.queueDigest = computeQueueDigest(
        loaded.queue,
        loaded.target,
        loaded.userId,
        loaded.signature,
        loaded.batchMode,
      );
    }
    return loaded;
  }

  let runState = loadRunState();

  function restorePersistedPacing(config = runState.config || defaultPrefs) {
    const configuredBase = Number(config?.baseDeleteDelayMs);
    const configuredMax = Number(config?.maxAdaptiveDelayMs);
    const baseDelay = Number.isFinite(configuredBase)
      ? configuredBase
      : defaultPrefs.baseDeleteDelayMs;
    const maximumDelay = Number.isFinite(configuredMax) && configuredMax >= baseDelay
      ? configuredMax
      : Math.max(baseDelay, defaultPrefs.maxAdaptiveDelayMs);
    const learnedDelay = Number(runState.learnedDeleteDelayMs);
    runtime.adaptiveDeleteDelayMs = clamp(
      Math.max(
        baseDelay,
        runtime.adaptiveDeleteDelayMs || 0,
        Number.isFinite(learnedDelay) ? learnedDelay : 0,
      ),
      baseDelay,
      maximumDelay,
    );
    const savedDeadline = Number(runState.rateLimitUntil);
    if (Number.isFinite(savedDeadline) && savedDeadline > Date.now()) {
      runtime.nextAllowedAt = Math.max(runtime.nextAllowedAt, savedDeadline);
    }
  }

  restorePersistedPacing();

  function saveRunState() {
    runState.savedAt = Date.now();
    runState.queueDigest = runState.queue.length > 0
      ? computeQueueDigest(
        runState.queue,
        runState.target,
        runState.userId,
        runState.signature,
        runState.batchMode,
      )
      : '';
    runState.rateLimitUntil = Math.max(
      Number.isFinite(runState.rateLimitUntil) ? runState.rateLimitUntil : 0,
      Number.isFinite(runtime.nextAllowedAt) ? runtime.nextAllowedAt : 0,
    );
    if (runtime.adaptiveDeleteDelayMs > 0) {
      runState.learnedDeleteDelayMs = Math.max(
        Number.isFinite(runState.learnedDeleteDelayMs)
          ? runState.learnedDeleteDelayMs
          : 0,
        runtime.adaptiveDeleteDelayMs,
      );
    }
    // The channel is already locked in runState.target, so repeating it for every
    // queued item would waste several megabytes in very long conversations.
    const pack = (item) => [String(item.id), String(item.timestamp || '')];
    storageSet(SCRIPT.runKey, {
      ...runState,
      queue: runState.queue.map(pack),
      failures: runState.failures.map(pack),
    });
    updateUi();
  }

  function parseTarget() {
    const match = location.pathname.match(/^\/channels\/(@me|\d{1,20})\/(\d{1,20})(?:\/|$)/);
    if (!match) return null;
    return {
      guildId: match[1],
      channelId: match[2],
      kind: match[1] === '@me' ? 'DM / group DM' : 'server channel',
    };
  }

  function sameTarget(a, b) {
    return Boolean(
      a && b
      && a.guildId === b.guildId
      && a.channelId === b.channelId,
    );
  }

  function formatTarget(target) {
    if (!target) return 'Open a channel or DM';
    return `${target.kind} · ${target.channelId}`;
  }

  function clamp(number, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, number));
  }

  function integer(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, minimum, maximum);
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function configSignature(config, target, userId) {
    return fnv1a(JSON.stringify({ config, target, userId }));
  }

  function computeQueueDigest(queue, target, userId, signature, batchMode = 'history') {
    return fnv1a(JSON.stringify({
      channelId: String(target?.channelId || ''),
      userId: String(userId || ''),
      signature: String(signature || ''),
      batchMode: String(batchMode || 'history'),
      eligibilityVersion: 2,
      items: queue.map((item) => [
        String(item?.id || ''),
        String(item?.timestamp || ''),
      ]),
    }));
  }

  function jitter(ms, percent) {
    if (ms <= 0 || percent <= 0) return Math.max(0, ms);
    const spread = ms * (percent / 100);
    return Math.max(0, Math.round(ms + ((Math.random() * 2 - 1) * spread)));
  }

  function redactSecrets(value) {
    return String(value)
      .replace(/mfa\.[\w-]+/gi, '[redacted token]')
      .replace(/[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}/g, '[redacted token]')
      .replace(/(authorization|token)\s*[:=]\s*[^\s,}\]]+/gi, '$1=[redacted]');
  }

  function log(level, message) {
    const safeMessage = redactSecrets(message);
    runtime.logs.push({
      at: new Date().toLocaleTimeString(),
      level,
      message: safeMessage,
    });
    if (runtime.logs.length > SCRIPT.maxLogLines) runtime.logs.shift();
    updateLog();
  }

  function debugId(value) {
    const text = String(value || '');
    return text ? `id#${fnv1a(text)}:${text.length}d` : 'missing';
  }

  function safeDebugValue(value, depth = 0) {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return redactSecrets(value).slice(0, 500);
    if (depth >= 3) return '[depth limited]';
    if (Array.isArray(value)) {
      return value.slice(0, 40).map((item) => safeDebugValue(item, depth + 1));
    }
    if (typeof value === 'object') {
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 60)) {
        output[String(key).slice(0, 80)] = safeDebugValue(item, depth + 1);
      }
      return output;
    }
    return String(value).slice(0, 100);
  }

  function debugLog(event, details = {}) {
    const entry = {
      at: new Date().toISOString(),
      event: String(event || 'unknown').slice(0, 80),
      ...safeDebugValue(details),
    };
    runtime.debugLogs.push(JSON.stringify(entry));
    runtime.debugEventCount += 1;
    if (runtime.debugLogs.length > SCRIPT.maxDebugLines) runtime.debugLogs.shift();
    if (
      runtime.debugEventCount <= 5
      || runtime.debugEventCount % 10 === 0
      || [
        'suspicious-ownership-count',
        'scan-finished',
        'scan-error',
        'deletion-entry',
        'deletion-blocked',
        'deletion-confirmation-shown',
        'deletion-confirmation-result',
        'deletion-started',
        'delete-response',
        'deletion-finished',
        'deletion-stopped-or-error',
      ].includes(entry.event)
    ) {
      updateDebugLog();
    }
  }

  function authorPageDiagnostics(messages, userId) {
    const authors = new Map();
    const types = new Map();
    const selfTypes = new Map();
    let missingAuthor = 0;
    let webhookMessages = 0;
    let authoredBySelf = 0;
    let eligibleOwned = 0;
    let ignoredOwnedSystem = 0;

    for (const message of messages) {
      const type = String(message?.type ?? 'missing');
      types.set(type, (types.get(type) || 0) + 1);
      if (message?.webhook_id) webhookMessages += 1;
      const authorId = String(message?.author?.id || '');
      if (!authorId) {
        missingAuthor += 1;
        continue;
      }
      const label = authorId === String(userId || '') ? 'self' : debugId(authorId);
      authors.set(label, (authors.get(label) || 0) + 1);
      if (label === 'self') {
        authoredBySelf += 1;
        selfTypes.set(type, (selfTypes.get(type) || 0) + 1);
        if (isDeletableOwnedMessage(message, userId)) eligibleOwned += 1;
        else ignoredOwnedSystem += 1;
      }
    }

    return {
      owned: eligibleOwned,
      authoredBySelf,
      eligibleOwned,
      ignoredOwnedSystem,
      missingAuthor,
      webhookMessages,
      authors: [...authors.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 12)
        .map(([author, count]) => ({ author, count })),
      messageTypes: [...types.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([type, count]) => ({ type, count })),
      selfMessageTypes: [...selfTypes.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([type, count]) => ({ type, count })),
    };
  }

  function historyPageDiagnostics(messages, {
    target,
    userId,
    before,
    pageNumber,
    anchorFound,
  }) {
    const newest = messages[0] || null;
    const oldest = messages[messages.length - 1] || null;
    return {
      page: pageNumber,
      requestedBefore: debugId(before),
      responseCount: messages.length,
      newestMessage: debugId(newest?.id),
      newestTimestamp: String(newest?.timestamp || ''),
      oldestMessage: debugId(oldest?.id),
      oldestTimestamp: String(oldest?.timestamp || ''),
      targetChannel: debugId(target?.channelId),
      authenticatedUser: debugId(userId),
      runtimeUser: debugId(currentUser?.id),
      identityStillMatches: String(currentUser?.id || '') === String(userId || ''),
      anchorFound: Boolean(anchorFound),
      ...authorPageDiagnostics(messages, userId),
    };
  }

  function diagnosticExportText() {
    const header = [
      'Discord Privacy Eraser diagnostics',
      `Script version: ${SCRIPT.version}`,
      `Generated: ${new Date().toISOString()}`,
      'Privacy: message content, usernames, raw account/channel/message IDs, credentials, and tokens are omitted or hashed.',
      'Format: one JSON object per line.',
      '',
    ];
    return [...header, ...runtime.debugLogs].join('\n');
  }

  function matchLogText(message, mode) {
    const prefix = `[${formatDate(message?.timestamp)}] ${String(message?.id || '')}`;
    if (mode === 'ids') return prefix;
    const rawContent = String(message?.content || '').replace(/\r\n?/g, '\n');
    const content = mode === 'preview' && rawContent.length > 300
        ? `${rawContent.slice(0, 300)}…`
        : rawContent;
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const stickers = Array.isArray(message?.sticker_items) ? message.sticker_items : [];
    const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
    const extras = [
      attachments.length ? `${attachments.length} attachment${attachments.length === 1 ? '' : 's'}` : '',
      stickers.length ? `${stickers.length} sticker${stickers.length === 1 ? '' : 's'}` : '',
      embeds.length ? `${embeds.length} embed${embeds.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    const body = content || (extras.length ? `[${extras.join(', ')}]` : '[empty message]');
    return redactSecrets(`${prefix} · ${body}`);
  }

  function logMatchedMessage(message, config) {
    const mode = config?.matchLogMode || defaultPrefs.matchLogMode;
    if (mode === 'none') return;
    runtime.matchLogs.push(matchLogText(message, mode));
  }

  function wakeRuntime() {
    const waiters = runtime.wakeWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async function controlPoint() {
    if (runtime.stopped) throw new StopSignal();

    const currentTarget = parseTarget();
    const lockedTarget = runtime.activeTarget || runState.target;
    if (
      runtime.mode !== 'idle'
      && runState.config?.pauseOnNavigate
      && lockedTarget
      && !sameTarget(currentTarget, lockedTarget)
      && !runtime.paused
    ) {
      runtime.paused = true;
      runtime.pauseReason = 'You navigated away from the locked target.';
      runState.status = 'paused';
      saveRunState();
      log('warn', 'Paused because the open channel changed. Return to the target, then resume.');
    }

    while (runtime.paused && !runtime.stopped) {
      await new Promise((resolve) => runtime.wakeWaiters.push(resolve));
    }
    if (runtime.stopped) throw new StopSignal();
  }

  async function interruptibleSleep(ms) {
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end) {
      await controlPoint();
      const remaining = end - Date.now();
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 400)));
    }
  }

  function abortActiveRequest() {
    try { runtime.requestController?.abort(); } catch {}
    runtime.requestController = null;
  }

  async function waitForAuth(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (authToken) return authToken;
      readLegacyLocalToken();
      tryWebpackToken();
      if (authToken) return authToken;
      await interruptibleSleep(500);
    }
    throw new FatalApiError(
      'Could not obtain the in-memory Discord session. Hard-refresh Discord after enabling the userscript, then open another channel once.',
    );
  }

  function safeResponseMessage(payload, fallback) {
    const message = typeof payload?.message === 'string' ? payload.message : '';
    return message ? message.slice(0, 220) : fallback;
  }

  async function responseJson(response) {
    try {
      return await response.clone().json();
    } catch {
      return null;
    }
  }

  function retryAfterMs(response, payload) {
    const bodySeconds = Number(payload?.retry_after);
    const headerSeconds = Number(response.headers.get('Retry-After'));
    const resetSeconds = Number(response.headers.get('X-RateLimit-Reset-After'));
    const seconds = [bodySeconds, headerSeconds, resetSeconds]
      .filter((value) => Number.isFinite(value) && value >= 0)
      .reduce((largest, value) => Math.max(largest, value), 0);
    return Math.ceil(seconds * 1000);
  }

  function recordInvalidRequest(status, scope = '') {
    if (![401, 403, 429].includes(status)) return { count: 0, tripped: false };
    if (status === 429 && scope === 'shared') return { count: 0, tripped: false };
    const now = Date.now();
    const cutoff = now - SCRIPT.invalidRequestWindowMs;
    const recent = Array.isArray(runState.invalidRequestTimes)
      ? runState.invalidRequestTimes.filter((time) => Number.isFinite(time) && time > cutoff)
      : [];
    recent.push(now);
    runState.invalidRequestTimes = recent;
    const limit = runState.config?.maxInvalidRequestsPer10Minutes
      || defaultPrefs.maxInvalidRequestsPer10Minutes;
    return {
      count: recent.length,
      tripped: recent.length >= limit,
    };
  }

  function invalidRequestCircuitError(count) {
    return new FatalApiError(
      `Paused after ${count} counted 401/403/429 responses within 10 minutes to avoid Discord's invalid-request restriction.`,
    );
  }

  function learnRateLimitHeaders(response, method) {
    const remainingRaw = response.headers.get('X-RateLimit-Remaining');
    const resetAfterRaw = response.headers.get('X-RateLimit-Reset-After');
    if (resetAfterRaw === null) return;
    const remaining = remainingRaw === null ? Number.NaN : Number(remainingRaw);
    const resetAfterSeconds = Number(resetAfterRaw);
    if (!Number.isFinite(resetAfterSeconds) || resetAfterSeconds < 0) return;

    const resetMs = Math.ceil(resetAfterSeconds * 1000);
    if (remaining === 0) {
      const deadline = Date.now() + resetMs + 150;
      runtime.nextAllowedAt = Math.max(runtime.nextAllowedAt, deadline);
      runState.rateLimitUntil = Math.max(runState.rateLimitUntil || 0, deadline);
    }
    if (method === 'DELETE' && Number.isFinite(remaining) && remaining > 0) {
      runtime.headerDeleteDelayMs = Math.ceil((resetMs / (remaining + 0.5)) * 1.15);
      runState.learnedDeleteDelayMs = Math.max(
        runState.learnedDeleteDelayMs || 0,
        runtime.headerDeleteDelayMs,
      );
    }
    if (remaining === 0) saveRunState();
  }

  function authorSearchPath(target, userId, maxId = '') {
    const query = new URLSearchParams({
      author_id: String(userId),
      ...(target.guildId === '@me' ? {} : { channel_id: String(target.channelId) }),
      sort_by: 'timestamp',
      sort_order: 'desc',
      ...(maxId ? { max_id: String(maxId) } : {}),
      offset: '0',
      limit: '25',
    });
    return target.guildId === '@me'
      ? `/channels/${target.channelId}/messages/search?${query.toString()}`
      : `/guilds/${target.guildId}/messages/search?${query.toString()}`;
  }

  function isAllowedAuthorSearchPath(path) {
    const target = runtime.activeTarget || runState.target;
    const userId = String(currentUser?.id || runState.userId || '');
    if (!target || !isSnowflake(target.channelId) || !isSnowflake(userId)) return false;
    try {
      if (!String(path).startsWith('/')) return false;
      const parsed = new URL(path, location.origin);
      if (parsed.origin !== location.origin || parsed.hash) return false;
      const maxIds = parsed.searchParams.getAll('max_id');
      if (maxIds.length > 1) return false;
      const maxId = maxIds[0] || '';
      if (maxId && !isSnowflake(maxId)) return false;
      return `${parsed.pathname}?${parsed.searchParams.toString()}`
        === authorSearchPath(target, userId, maxId);
    } catch {
      return false;
    }
  }

  async function apiRequest(path, options = {}) {
    const {
      method = 'GET',
      body = null,
      purpose = 'request',
      maxRetries = runState.config?.maxRetries ?? defaultPrefs.maxRetries,
    } = options;
    const requestMethod = String(method).toUpperCase();
    const allowedRequest = body === null && (
      (requestMethod === 'GET' && path === '/users/@me')
      || (
        requestMethod === 'GET'
        && /^\/channels\/\d{1,20}\/messages\?limit=(?:[1-9]|[1-9]\d|100)(?:&before=\d{1,20})?$/.test(path)
      )
      || (
        requestMethod === 'GET'
        && isAllowedAuthorSearchPath(path)
      )
      || (
        requestMethod === 'DELETE'
        && /^\/channels\/\d{1,20}\/messages\/\d{1,20}$/.test(path)
      )
    );
    if (!allowedRequest) {
      throw new FatalApiError(
        'Blocked an unexpected Discord API method, path, or body before sending it.',
      );
    }
    const token = await waitForAuth();
    let transientAttempt = 0;

    while (true) {
      await controlPoint();
      const proactiveWait = runtime.nextAllowedAt - Date.now();
      if (proactiveWait > 0) {
        log('rate', `Waiting ${formatDuration(proactiveWait)} for Discord's rate-limit window.`);
        await interruptibleSleep(proactiveWait);
      }

      runtime.requestController = new AbortController();
      const headers = {
        Accept: '*/*',
        Authorization: token,
      };
      if (body !== null) headers['Content-Type'] = 'application/json';
      if (capturedSuperProperties) headers['X-Super-Properties'] = capturedSuperProperties;

      let response;
      try {
        response = await nativeFetch(
          `${location.origin}/api/v${apiVersion}${path}`,
          {
            method: requestMethod,
            headers,
            body: body === null ? undefined : JSON.stringify(body),
            credentials: 'include',
            signal: runtime.requestController.signal,
            referrer: location.href,
          },
        );
      } catch (error) {
        runtime.requestController = null;
        if (runtime.stopped || error?.name === 'AbortError') throw new StopSignal();
        transientAttempt += 1;
        if (transientAttempt > maxRetries) {
          throw new Error(`${purpose} failed after ${maxRetries} network retries.`);
        }
        const waitMs = Math.min(30000, (2 ** Math.min(transientAttempt, 6)) * 700);
        debugLog('network-retry', {
          purpose,
          attempt: transientAttempt,
          maxRetries,
          waitMs,
          errorName: String(error?.name || 'Error').slice(0, 80),
        });
        log('warn', `${purpose} hit a network error; retrying in ${formatDuration(waitMs)}.`);
        await interruptibleSleep(jitter(waitMs, 20));
        continue;
      } finally {
        runtime.requestController = null;
      }

      learnRateLimitHeaders(response, requestMethod);

      if (response.status === 429) {
        const payload = await responseJson(response);
        const advertisedWait = retryAfterMs(response, payload);
        runState.rateLimits += 1;
        runtime.successesSinceLimit = 0;
        runtime.adaptiveDeleteDelayMs = clamp(
          Math.max(
            runtime.adaptiveDeleteDelayMs * 1.65,
            (runState.config?.baseDeleteDelayMs || defaultPrefs.baseDeleteDelayMs) * 1.5,
          ),
          runState.config?.baseDeleteDelayMs || defaultPrefs.baseDeleteDelayMs,
          runState.config?.maxAdaptiveDelayMs || defaultPrefs.maxAdaptiveDelayMs,
        );
        runState.learnedDeleteDelayMs = Math.max(
          runState.learnedDeleteDelayMs || 0,
          runtime.adaptiveDeleteDelayMs,
        );
        const minimumWait = Math.max(
          1000,
          advertisedWait,
          runtime.adaptiveDeleteDelayMs,
        );
        const scope = String(
          response.headers.get('X-RateLimit-Scope')
          || (payload?.global ? 'global' : 'route'),
        ).toLowerCase();
        // Retry-After is a hard minimum. Add only positive jitter so a large
        // rate-limit window can never be shortened by random pacing.
        const positiveJitter = Math.round(Math.random() * Math.min(1000, minimumWait * 0.05));
        const waitMs = minimumWait + 250 + positiveJitter;
        const deadline = Date.now() + waitMs;
        runtime.nextAllowedAt = Math.max(runtime.nextAllowedAt, deadline);
        runState.rateLimitUntil = Math.max(runState.rateLimitUntil || 0, deadline);
        const invalidRequests = recordInvalidRequest(429, scope);
        debugLog('rate-limit', {
          purpose,
          scope,
          advertisedWaitMs: advertisedWait,
          adaptiveDelayMs: runtime.adaptiveDeleteDelayMs,
          appliedWaitMs: waitMs,
          invalidRequestCount: invalidRequests.count,
        });
        saveRunState();
        if (invalidRequests.tripped) {
          throw invalidRequestCircuitError(invalidRequests.count);
        }
        log('rate', `Discord rate-limited the ${purpose} (${scope}); cooling down for ${formatDuration(waitMs)}.`);
        await interruptibleSleep(waitMs);
        continue;
      }

      if (response.status >= 500 && response.status <= 599) {
        transientAttempt += 1;
        if (transientAttempt > maxRetries) return response;
        const waitMs = Math.min(30000, (2 ** Math.min(transientAttempt, 6)) * 750);
        debugLog('server-retry', {
          purpose,
          status: response.status,
          attempt: transientAttempt,
          maxRetries,
          waitMs,
        });
        log('warn', `Discord returned ${response.status} for ${purpose}; retrying in ${formatDuration(waitMs)}.`);
        await interruptibleSleep(jitter(waitMs, 20));
        continue;
      }

      if (response.status === 401) {
        debugLog('authentication-rejected', { purpose, status: 401 });
        recordInvalidRequest(401);
        saveRunState();
        authToken = '';
        currentUser = null;
        updateAuthStatus();
        throw new FatalApiError(
          'Discord rejected the session (401). The run was paused; refresh Discord and resume.',
          401,
        );
      }

      if (response.status === 403) {
        const invalidRequests = recordInvalidRequest(403);
        debugLog('request-forbidden', {
          purpose,
          status: 403,
          invalidRequestCount: invalidRequests.count,
        });
        saveRunState();
        if (invalidRequests.tripped) {
          throw invalidRequestCircuitError(invalidRequests.count);
        }
      }

      return response;
    }
  }

  async function resolveCurrentUser({ force = false } = {}) {
    if (!force && currentUser?.id) return currentUser;
    let lastError = null;
    for (const version of SCRIPT.apiVersions) {
      apiVersion = version;
      try {
        const response = await apiRequest('/users/@me', {
          purpose: `API v${version} session check`,
          maxRetries: 2,
        });
        if (response.ok) {
          const user = await response.json();
          if (user?.id) {
            currentUser = user;
            updateAuthStatus();
            return currentUser;
          }
        }
        const payload = await responseJson(response);
        lastError = new FatalApiError(
          safeResponseMessage(payload, `Session check failed with HTTP ${response.status}.`),
          response.status,
        );
        if (response.status !== 404) break;
      } catch (error) {
        lastError = error;
        if (error.status !== 404) break;
      }
    }
    throw lastError || new FatalApiError('Could not identify the signed-in Discord account.');
  }

  function hasLink(message) {
    const content = String(message.content || '');
    if (/https?:\/\/\S+/i.test(content)) return true;
    return Array.isArray(message.embeds)
      && message.embeds.some((embed) => typeof embed?.url === 'string' && embed.url);
  }

  function isImageAttachment(attachment) {
    const contentType = String(attachment?.content_type || '');
    const filename = String(attachment?.filename || '');
    return contentType.startsWith('image/')
      || /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(filename);
  }

  function isAuthoredByUser(message, userId) {
    return Boolean(
      message?.author?.id
      && String(message.author.id) === String(userId || ''),
    );
  }

  function messageType(message) {
    const value = message?.type;
    if (value === undefined || value === null) return 0;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : Number.NaN;
  }

  function isDeletableOwnedMessage(message, userId) {
    return isAuthoredByUser(message, userId)
      && OWNED_CONTENT_MESSAGE_TYPES.has(messageType(message));
  }

  function matchesMessage(
    message,
    config,
    compiledRegex,
    excludedTerms,
    referenceTime = Date.now(),
  ) {
    if (!isDeletableOwnedMessage(message, currentUser?.id)) return false;
    if (!config.includePinned && message.pinned) return false;
    if (!config.includeEdited && message.edited_timestamp) return false;

    const timestamp = new Date(message.timestamp).getTime();
    if (!Number.isFinite(timestamp)) return false;
    if (config.afterDate && timestamp < new Date(config.afterDate).getTime()) return false;
    if (config.beforeDate && timestamp > new Date(config.beforeDate).getTime()) return false;
    if (config.minMessageAgeHours > 0) {
      const stableReferenceTime = Number.isFinite(referenceTime) ? referenceTime : Date.now();
      const newestAllowed = stableReferenceTime - (config.minMessageAgeHours * 60 * 60 * 1000);
      if (timestamp > newestAllowed) return false;
    }

    const content = String(message.content || '');
    const haystack = config.caseSensitive ? content : content.toLocaleLowerCase();
    if (config.text) {
      if (compiledRegex) {
        compiledRegex.lastIndex = 0;
        if (!compiledRegex.test(content)) return false;
      } else {
        const needle = config.caseSensitive ? config.text : config.text.toLocaleLowerCase();
        if (!haystack.includes(needle)) return false;
      }
    }

    if (excludedTerms.some((term) => haystack.includes(term))) return false;

    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (config.attachmentMode === 'with' && attachments.length === 0) return false;
    if (config.attachmentMode === 'without' && attachments.length > 0) return false;
    if (config.attachmentMode === 'images' && !attachments.some(isImageAttachment)) return false;
    if (config.attachmentMode === 'nonimages') {
      if (attachments.length === 0 || attachments.every(isImageAttachment)) return false;
    }

    const messageHasLink = hasLink(message);
    if (config.linkMode === 'with' && !messageHasLink) return false;
    if (config.linkMode === 'without' && messageHasLink) return false;
    return true;
  }

  function compileFilters(config) {
    let compiledRegex = null;
    if (config.regex && config.text) {
      try {
        compiledRegex = new RegExp(config.text, config.caseSensitive ? '' : 'i');
      } catch (error) {
        throw new Error(`Invalid regular expression: ${error.message}`);
      }
    }
    const excludedTerms = config.excludeTerms
      .split(/\r?\n/)
      .map((term) => term.trim())
      .filter(Boolean)
      .map((term) => (config.caseSensitive ? term : term.toLocaleLowerCase()));
    return { compiledRegex, excludedTerms };
  }

  function isDeleteEverythingConfig(config) {
    return Boolean(
      config
      && !config.afterDate
      && !config.beforeDate
      && !config.text
      && !config.excludeTerms.trim()
      && config.attachmentMode === 'any'
      && config.linkMode === 'any'
      && config.includePinned
      && config.includeEdited
      && config.minMessageAgeHours === 0
      && config.maxMessages === 0
    );
  }

  function validateConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('The saved settings are missing or invalid.');
    }
    const stringFields = ['afterDate', 'beforeDate', 'text', 'excludeTerms'];
    const booleanFields = [
      'regex',
      'caseSensitive',
      'includePinned',
      'includeEdited',
      'pauseOnNavigate',
      'autoResume',
      'riskAccepted',
    ];
    if (stringFields.some((field) => typeof config[field] !== 'string')) {
      throw new Error('One or more saved text settings are invalid. Start a new dry run.');
    }
    if (booleanFields.some((field) => typeof config[field] !== 'boolean')) {
      throw new Error('One or more saved toggle settings are invalid. Start a new dry run.');
    }
    const integerRanges = {
      minMessageAgeHours: [0, 876000],
      maxMessages: [0, 1000000],
      scanDelayMs: [0, 60000],
      baseDeleteDelayMs: [250, 60000],
      maxAdaptiveDelayMs: [1000, 600000],
      jitterPercent: [0, 50],
      maxRetries: [1, 50],
      stopAfterErrors: [1, 100],
      checkpointEvery: [1, 100],
      scanBatchSize: [100, 10000],
      emptyPageConfirmations: [1, 5],
      maxInvalidRequestsPer10Minutes: [2, 1000],
    };
    for (const [field, [minimum, maximum]] of Object.entries(integerRanges)) {
      if (
        !Number.isInteger(config[field])
        || config[field] < minimum
        || config[field] > maximum
      ) {
        throw new Error(`The saved “${field}” setting is outside its safe range.`);
      }
    }
    if (config.maxAdaptiveDelayMs < config.baseDeleteDelayMs) {
      throw new Error('Maximum adaptive delay must be at least the base deletion delay.');
    }
    if (!['any', 'with', 'without', 'images', 'nonimages'].includes(config.attachmentMode)) {
      throw new Error('The saved attachment filter is invalid.');
    }
    if (!['any', 'with', 'without'].includes(config.linkMode)) {
      throw new Error('The saved link filter is invalid.');
    }
    if (!['oldest', 'newest'].includes(config.deleteOrder)) {
      throw new Error('The saved deletion order is invalid.');
    }
    if (!['none', 'ids', 'preview', 'full'].includes(config.matchLogMode)) {
      throw new Error('The saved matched-message log mode is invalid.');
    }
    if (!['search', 'history'].includes(config.anchorLookupMode)) {
      throw new Error('The saved latest-message lookup mode is invalid.');
    }
    if (!config.riskAccepted) {
      throw new Error('Read and accept the irreversible-deletion and account-risk notice first.');
    }
    if (config.afterDate && Number.isNaN(new Date(config.afterDate).getTime())) {
      throw new Error('The “on or after” date is invalid.');
    }
    if (config.beforeDate && Number.isNaN(new Date(config.beforeDate).getTime())) {
      throw new Error('The “on or before” date is invalid.');
    }
    if (
      config.afterDate
      && config.beforeDate
      && new Date(config.afterDate).getTime() > new Date(config.beforeDate).getTime()
    ) {
      throw new Error('The start date must not be later than the end date.');
    }
    compileFilters(config);
  }

  function snowflakeCompare(a, b) {
    try {
      const left = BigInt(a.id);
      const right = BigInt(b.id);
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    } catch {
      return String(a.id).localeCompare(String(b.id));
    }
  }

  function isSnowflake(value) {
    return /^\d{1,20}$/.test(String(value || ''));
  }

  function validateHistoryPage(messages, target, before, requestedLimit = 100) {
    if (!Array.isArray(messages)) {
      throw new FatalApiError('Discord returned a non-array history response. The scan was paused safely.');
    }
    if (messages.length > requestedLimit) {
      throw new FatalApiError('Discord returned an oversized history page. The scan was paused safely.');
    }
    let previousId = before ? BigInt(before) : null;
    for (const message of messages) {
      if (
        !isSnowflake(message?.id)
        || String(message?.channel_id || '') !== String(target.channelId)
        || !Number.isFinite(new Date(message?.timestamp).getTime())
      ) {
        throw new FatalApiError(
          'Discord returned a malformed history item or one outside the locked target.',
        );
      }
      const currentId = BigInt(message.id);
      if (previousId !== null && currentId >= previousId) {
        throw new FatalApiError(
          'Discord returned duplicate or out-of-order history. The scan was paused safely.',
        );
      }
      previousId = currentId;
    }
    return messages.length ? String(messages[messages.length - 1].id) : '';
  }

  function prepareQueue(queue, config) {
    const deduplicated = [...new Map(queue.map((item) => [item.id, item])).values()];
    deduplicated.sort(snowflakeCompare);
    if (config.deleteOrder === 'newest') deduplicated.reverse();
    return config.maxMessages > 0
      ? deduplicated.slice(0, config.maxMessages)
      : deduplicated;
  }

  function updateQueueRange() {
    let oldestTime = Number.POSITIVE_INFINITY;
    let newestTime = Number.NEGATIVE_INFINITY;
    let oldestTimestamp = '';
    let newestTimestamp = '';
    for (const item of runState.queue) {
      const time = new Date(item.timestamp).getTime();
      if (!Number.isFinite(time)) continue;
      if (time < oldestTime) {
        oldestTime = time;
        oldestTimestamp = item.timestamp;
      }
      if (time > newestTime) {
        newestTime = time;
        newestTimestamp = item.timestamp;
      }
    }
    runState.firstTimestamp = newestTimestamp;
    runState.lastTimestamp = oldestTimestamp;
  }

  function batchCapacityReached(config) {
    return runState.batchMode === 'owned'
      ? runState.batchOwnedMessages >= config.scanBatchSize
      : runState.batchScannedMessages >= config.scanBatchSize;
  }

  function pageLimitForBatch(config) {
    if (runState.batchMode === 'owned') return 100;
    return Math.min(
      100,
      Math.max(1, config.scanBatchSize - runState.batchScannedMessages),
    );
  }

  function trimToOwnedBatchBoundary(messages, config) {
    if (runState.batchMode !== 'owned') return messages;
    let ownedNeeded = Math.max(0, config.scanBatchSize - runState.batchOwnedMessages);
    if (ownedNeeded === 0) return [];
    for (let index = 0; index < messages.length; index += 1) {
      if (!isDeletableOwnedMessage(messages[index], runState.userId)) continue;
      ownedNeeded -= 1;
      if (ownedNeeded === 0) return messages.slice(0, index + 1);
    }
    return messages;
  }

  function recordBatchMessage(message, target, config, compiledRegex, excludedTerms) {
    runState.scannedMessages += 1;
    runState.batchScannedMessages += 1;
    if (isDeletableOwnedMessage(message, runState.userId)) {
      runState.batchOwnedMessages += 1;
    } else if (isAuthoredByUser(message, runState.userId)) {
      runState.batchIgnoredOwnedSystemMessages += 1;
      return;
    }
    if (!matchesMessage(
      message,
      config,
      compiledRegex,
      excludedTerms,
      runState.filterReferenceTime,
    )) {
      return;
    }
    runState.batchFilterMatches += 1;
    runState.queue.push({
      id: String(message.id),
      channelId: String(target.channelId),
      timestamp: String(message.timestamp || ''),
    });
    runState.matchedMessages += 1;
    if (!runState.firstTimestamp) runState.firstTimestamp = String(message.timestamp || '');
    runState.lastTimestamp = String(message.timestamp || runState.lastTimestamp);
    logMatchedMessage(message, config);
  }

  function extractSearchAnchor(payload, target, userId, maxId = '') {
    if (!payload || !Array.isArray(payload.messages)) return null;
    const hits = payload.messages
      .flatMap((group) => (Array.isArray(group) ? group : []))
      .filter((message) => message?.hit === true);
    if (hits.length === 0) return null;
    if (hits.some((message) => (
      !isSnowflake(message?.id)
      || String(message?.channel_id || '') !== String(target.channelId)
      || !isAuthoredByUser(message, userId)
      || !Number.isFinite(new Date(message?.timestamp).getTime())
      || (maxId && BigInt(message.id) >= BigInt(maxId))
    ))) {
      return null;
    }
    const deletableHits = hits.filter((message) => isDeletableOwnedMessage(message, userId));
    deletableHits.sort((left, right) => snowflakeCompare(right, left));
    return deletableHits[0] || null;
  }

  async function discoverLatestOwnedMessage(
    target,
    userId,
    config,
    {
      maxId = '',
      purpose = 'latest-message author lookup',
      lookupLabel = 'Fast author lookup',
    } = {},
  ) {
    const path = authorSearchPath(target, userId, maxId);
    const attempts = Math.max(1, Math.min(config.maxRetries, 3));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await controlPoint();
      debugLog('search-request', {
        attempt,
        attempts,
        targetKind: target.kind,
        targetChannel: debugId(target.channelId),
        authenticatedUser: debugId(userId),
        apiVersion,
        sort: 'timestamp:desc',
        maxId: debugId(maxId),
        offset: 0,
        limit: 25,
        purpose,
      });
      const response = await apiRequest(
        path,
        { purpose },
      );
      const payload = await responseJson(response);
      const groups = Array.isArray(payload?.messages) ? payload.messages : [];
      const flattened = groups.flatMap((group) => (Array.isArray(group) ? group : []));
      const hits = flattened.filter((message) => message?.hit === true);
      const hitDiagnostics = authorPageDiagnostics(hits, userId);
      const anchor = response.ok && response.status !== 202
        ? extractSearchAnchor(payload, target, userId, maxId)
        : null;
      debugLog('search-response', {
        attempt,
        status: response.status,
        ok: response.ok,
        totalResults: payload?.total_results !== null
          && payload?.total_results !== undefined
          && Number.isFinite(Number(payload.total_results))
          ? Number(payload.total_results)
          : null,
        groupCount: groups.length,
        groupSizes: groups.slice(0, 20).map((group) => (
          Array.isArray(group) ? group.length : -1
        )),
        flattenedCount: flattened.length,
        hitCount: hits.length,
        ownedHitCount: hitDiagnostics.owned,
        ignoredOwnedSystemHits: hitDiagnostics.ignoredOwnedSystem,
        hitAuthors: hitDiagnostics.authors,
        selectedAnchor: debugId(anchor?.id),
        selectedTimestamp: String(anchor?.timestamp || ''),
        selectedChannelMatches: anchor
          ? String(anchor.channel_id || '') === String(target.channelId)
          : null,
        selectedAuthorMatches: anchor ? isAuthoredByUser(anchor, userId) : null,
        selectedType: anchor ? messageType(anchor) : null,
        maxId: debugId(maxId),
        purpose,
        ...authorPageDiagnostics(flattened, userId),
      });
      if (response.status === 202) {
        const retrySeconds = Number(payload?.retry_after);
        const waitMs = Math.max(
          250,
          Math.min(60000, Number.isFinite(retrySeconds) ? Math.ceil(retrySeconds * 1000) : 1000),
        );
        log(
          'rate',
          `Discord is indexing this conversation for the ${lookupLabel.toLowerCase()}; retrying in ${formatDuration(waitMs)} (${attempt}/${attempts}).`,
        );
        await interruptibleSleep(waitMs);
        continue;
      }
      if (!response.ok) {
        log(
          'warn',
          `${lookupLabel} returned HTTP ${response.status}; continuing through direct history.`,
        );
        return null;
      }
      if (anchor) return anchor;
      log(
        'warn',
        `${lookupLabel} returned no strictly valid deletable owned-message hit; continuing through direct history.`,
      );
      return null;
    }
    log(
      'warn',
      `${lookupLabel} did not finish indexing in time; continuing through direct history.`,
    );
    return null;
  }

  function validateQueueTarget(queue, target) {
    if (!target || !isSnowflake(target.channelId)) return false;
    return queue.every((item) => (
      item
      && isSnowflake(item.id)
      && String(item.channelId || '') === String(target.channelId)
    ));
  }

  function validateQueueIntegrity(state, target) {
    if (!state.queueDigest || !validateQueueTarget(state.queue, target)) return false;
    return state.queueDigest === computeQueueDigest(
      state.queue,
      target,
      state.userId,
      state.signature,
      state.batchMode,
    );
  }

  function processedDeletionCount() {
    return runState.deleted + runState.alreadyGone + runState.failed;
  }

  function remainingDeletionAllowance(config) {
    if (!config.maxMessages) return Number.POSITIVE_INFINITY;
    return Math.max(0, config.maxMessages - processedDeletionCount());
  }

  function deletionLimitReached(config) {
    return Number.isFinite(remainingDeletionAllowance(config))
      && remainingDeletionAllowance(config) <= 0;
  }

  function readConfigFromUi() {
    if (!shadow) return loadPrefs();
    const value = (id) => shadow.getElementById(id)?.value ?? '';
    const checked = (id) => Boolean(shadow.getElementById(id)?.checked);
    return {
      afterDate: value('dpe-after'),
      beforeDate: value('dpe-before'),
      text: value('dpe-text'),
      regex: checked('dpe-regex'),
      caseSensitive: checked('dpe-case'),
      excludeTerms: value('dpe-exclude'),
      attachmentMode: value('dpe-attachments'),
      linkMode: value('dpe-links'),
      includePinned: checked('dpe-pinned'),
      includeEdited: checked('dpe-edited'),
      minMessageAgeHours: integer(value('dpe-min-age'), 0, 0, 876000),
      maxMessages: integer(value('dpe-max-messages'), 0, 0, 1000000),
      deleteOrder: value('dpe-order') === 'newest' ? 'newest' : 'oldest',
      scanDelayMs: integer(value('dpe-scan-delay'), 250, 0, 60000),
      baseDeleteDelayMs: integer(value('dpe-delete-delay'), 1100, 250, 60000),
      maxAdaptiveDelayMs: integer(value('dpe-max-delay'), 30000, 1000, 600000),
      jitterPercent: integer(value('dpe-jitter'), 15, 0, 50),
      maxRetries: integer(value('dpe-retries'), 12, 1, 50),
      stopAfterErrors: integer(value('dpe-error-stop'), 5, 1, 100),
      checkpointEvery: integer(value('dpe-checkpoint'), 10, 1, 100),
      scanBatchSize: integer(value('dpe-batch-size'), 500, 100, 10000),
      matchLogMode: ['none', 'ids', 'preview', 'full'].includes(value('dpe-match-log-mode'))
        ? value('dpe-match-log-mode')
        : 'full',
      anchorLookupMode: value('dpe-anchor-mode') === 'history' ? 'history' : 'search',
      emptyPageConfirmations: integer(value('dpe-empty-confirmations'), 2, 1, 5),
      maxInvalidRequestsPer10Minutes: integer(value('dpe-invalid-limit'), 20, 2, 1000),
      pauseOnNavigate: checked('dpe-pause-nav'),
      autoResume: checked('dpe-auto-resume'),
      riskAccepted: checked('dpe-risk'),
    };
  }

  function applyPrefsToUi(prefs) {
    if (!shadow) return;
    const setValue = (id, value) => {
      const element = shadow.getElementById(id);
      if (element) element.value = value ?? '';
    };
    const setChecked = (id, value) => {
      const element = shadow.getElementById(id);
      if (element) element.checked = Boolean(value);
    };
    setValue('dpe-after', prefs.afterDate);
    setValue('dpe-before', prefs.beforeDate);
    setValue('dpe-text', prefs.text);
    setChecked('dpe-regex', prefs.regex);
    setChecked('dpe-case', prefs.caseSensitive);
    setValue('dpe-exclude', prefs.excludeTerms);
    setValue('dpe-attachments', prefs.attachmentMode);
    setValue('dpe-links', prefs.linkMode);
    setChecked('dpe-pinned', prefs.includePinned);
    setChecked('dpe-edited', prefs.includeEdited);
    setValue('dpe-min-age', prefs.minMessageAgeHours);
    setValue('dpe-max-messages', prefs.maxMessages);
    setValue('dpe-order', prefs.deleteOrder);
    setValue('dpe-scan-delay', prefs.scanDelayMs);
    setValue('dpe-delete-delay', prefs.baseDeleteDelayMs);
    setValue('dpe-max-delay', prefs.maxAdaptiveDelayMs);
    setValue('dpe-jitter', prefs.jitterPercent);
    setValue('dpe-retries', prefs.maxRetries);
    setValue('dpe-error-stop', prefs.stopAfterErrors);
    setValue('dpe-checkpoint', prefs.checkpointEvery);
    setValue('dpe-batch-size', prefs.scanBatchSize);
    setValue('dpe-match-log-mode', prefs.matchLogMode);
    setValue('dpe-anchor-mode', prefs.anchorLookupMode);
    setValue('dpe-empty-confirmations', prefs.emptyPageConfirmations);
    setValue('dpe-invalid-limit', prefs.maxInvalidRequestsPer10Minutes);
    setChecked('dpe-pause-nav', prefs.pauseOnNavigate);
    setChecked('dpe-auto-resume', prefs.autoResume);
    setChecked('dpe-risk', prefs.riskAccepted);
  }

  async function startScan({ resume = false, continuation = false } = {}) {
    if (runtime.mode !== 'idle') return;
    const target = (resume || continuation) ? runState.target : parseTarget();
    if (!target) {
      log('error', 'Open the exact Discord channel or DM you want to clean first.');
      return;
    }

    const config = (resume || continuation) && runState.config
      ? runState.config
      : readConfigFromUi();
    try {
      validateConfig(config);
    } catch (error) {
      log('error', error.message);
      return;
    }

    if (!resume && !continuation) {
      runtime.debugLogs = [];
      runtime.debugEventCount = 0;
      runtime.suspiciousOwnershipWarningShown = false;
      updateDebugLog();
    }
    runtime.mode = 'scanning';
    runtime.paused = false;
    runtime.stopped = false;
    runtime.pauseReason = '';
    runtime.startedAt = Date.now();
    runtime.activeTarget = target;
    runtime.preflight = true;
    updateUi();

    try {
      const user = await resolveCurrentUser({ force: true });
      debugLog('scan-start', {
        scriptVersion: SCRIPT.version,
        apiVersion,
        host: location.hostname,
        mode: resume ? 'resume' : continuation ? 'continuation' : 'fresh',
        targetKind: target.kind,
        targetChannel: debugId(target.channelId),
        authenticatedUser: debugId(user.id),
        batchMode: resume || continuation ? runState.batchMode : 'owned',
        scanBatchSize: config.scanBatchSize,
        anchorLookupMode: config.anchorLookupMode,
        scanDelayMs: config.scanDelayMs,
        filters: {
          afterDateSet: Boolean(config.afterDate),
          beforeDateSet: Boolean(config.beforeDate),
          textSet: Boolean(config.text),
          regex: config.regex,
          exclusionTermsSet: Boolean(config.excludeTerms.trim()),
          attachmentMode: config.attachmentMode,
          linkMode: config.linkMode,
          includePinned: config.includePinned,
          includeEdited: config.includeEdited,
          minimumAgeSet: config.minMessageAgeHours > 0,
          maximumDeletionSet: config.maxMessages > 0,
        },
      });
      const signature = configSignature(config, target, user.id);
      const canResume = resume
        && runState.operation === 'scanning'
        && runState.signature === signature
        && sameTarget(runState.target, target);
      const canContinue = continuation
        && runState.operation === 'batching'
        && runState.signature === signature
        && sameTarget(runState.target, target)
        && !runState.historyComplete
        && runState.queue.length === 0;

      if ((resume && !canResume) || (continuation && !canContinue)) {
        throw new FatalApiError(
          'The signed-in account, target, saved settings, or batch checkpoint changed. Start a new dry run instead.',
        );
      }

      if (!canResume && !canContinue) {
        runState = {
          ...emptyRunState(),
          status: 'scanning',
          operation: 'scanning',
          target,
          userId: user.id,
          signature,
          config,
          filterReferenceTime: runtime.startedAt,
        };
        runtime.matchLogs = [];
        updateMatchLog();
      } else if (canContinue) {
        runState.status = 'scanning';
        runState.operation = 'scanning';
        runState.batchNumber += 1;
        runState.batchScannedMessages = 0;
        runState.batchOwnedMessages = 0;
        runState.batchIgnoredOwnedSystemMessages = 0;
        runState.batchFilterMatches = 0;
        runState.batchProcessed = 0;
        runState.initialMatches = 0;
        runState.matchedMessages = 0;
        runState.firstTimestamp = '';
        runState.lastTimestamp = '';
        runtime.matchLogs = [];
        updateMatchLog();
        log('info', `Starting batch ${runState.batchNumber} before message ${runState.scanCursor}.`);
      } else {
        runState.status = 'scanning';
        if (!Number.isFinite(runState.filterReferenceTime) || runState.filterReferenceTime <= 0) {
          runState.filterReferenceTime = runState.savedAt || runtime.startedAt;
        }
        log('info', `Resuming scan before message ${runState.scanCursor || 'latest'}.`);
      }
      runState.status = runState.anchorFound ? 'scanning' : 'seeking-latest';
      runtime.preflight = false;

      savePrefs(config);
      saveRunState();
      const { compiledRegex, excludedTerms } = compileFilters(config);
      let before = (canResume || canContinue) ? runState.scanCursor : '';
      let reachedDateFloor = false;
      let consecutiveEmptyPages = 0;

      log(
        'info',
        `Dry run started for ${formatTarget(target)}. No messages will be deleted during scanning.`,
      );
      log(
        'info',
        isDeleteEverythingConfig(config)
          ? 'Default delete-everything scope is active: every normal user-content message authored by your authenticated account is eligible, including pinned and edited messages; call/system entries are ignored.'
          : 'Custom filters are active. Ownership and filter-pass counts will be reported separately.',
      );
      if (!runState.anchorFound) {
        log(
          'info',
          config.anchorLookupMode === 'search'
            ? 'Finding your actual latest deletable message with Discord’s same-origin author search. Undeletable call/system entries are rejected as anchors; invalid search results fall back to direct history.'
            : 'Fast-seeking your actual latest deletable message through direct history before starting batch 1. No fixed scan delay is added during this seek; Discord rate-limit headers and 429 waits are still enforced.',
        );
      }
      log(
        'info',
        runState.batchMode === 'owned'
          ? `Each batch collects ${config.scanBatchSize.toLocaleString()} deletable messages authored by your account. Undeletable call/system entries are ignored, and empty 100-message windows use a locked author-search jump.`
          : 'This older checkpoint retains its previously reviewed combined-history batch boundary. Clear it and start a new dry run to use owned-message batches.',
      );
      if (!runState.anchorFound && config.anchorLookupMode === 'search') {
        const searchAnchor = await discoverLatestOwnedMessage(target, runState.userId, config);
        if (searchAnchor) {
          runState.anchorFound = true;
          runState.anchorMethod = 'search';
          runState.status = 'scanning';
          before = String(searchAnchor.id);
          runState.scanCursor = before;
          recordBatchMessage(searchAnchor, target, config, compiledRegex, excludedTerms);
          debugLog('search-anchor-accepted', {
            anchorMessage: debugId(searchAnchor.id),
            timestamp: String(searchAnchor.timestamp || ''),
            nextHistoryBefore: debugId(before),
            batchOwnedAfterAnchor: runState.batchOwnedMessages,
            batchFilterMatchesAfterAnchor: runState.batchFilterMatches,
          });
          log(
            'success',
            `Found your actual latest deletable message at ${formatDate(searchAnchor.timestamp)} with the fast author-locked lookup. Call/system entries were ignored as anchors, and newer messages from the other participant were never walked page by page.`,
          );
          if (
            config.afterDate
            && new Date(searchAnchor.timestamp).getTime() < new Date(config.afterDate).getTime()
          ) {
            reachedDateFloor = true;
            runState.historyComplete = true;
          }
          saveRunState();
        } else {
          runState.anchorMethod = 'history';
        }
      }

      while (!reachedDateFloor) {
        // A reload can occur after the boundary page was checkpointed but before
        // the normal post-page transition ran. Normalize that state before
        // making another request so a completed batch never overshoots.
        if (
          batchCapacityReached(config)
          && runState.queue.length > 0
        ) {
          break;
        }
        if (batchCapacityReached(config)) {
          log(
            'info',
            `Batch ${runState.batchNumber} had no queued matches: ${runState.batchOwnedMessages.toLocaleString()} deletable messages were yours, ${runState.batchIgnoredOwnedSystemMessages.toLocaleString()} authored call/system entries were ignored, and ${runState.batchFilterMatches.toLocaleString()} passed the active filters. Continuing to older history.`,
          );
          runState.batchNumber += 1;
          runState.batchScannedMessages = 0;
          runState.batchOwnedMessages = 0;
          runState.batchIgnoredOwnedSystemMessages = 0;
          runState.batchFilterMatches = 0;
        }
        await controlPoint();
        const pageLimit = pageLimitForBatch(config);
        const query = new URLSearchParams({ limit: String(pageLimit) });
        if (before) query.set('before', before);
        const response = await apiRequest(
          `/channels/${target.channelId}/messages?${query.toString()}`,
          { purpose: 'history scan' },
        );

        if (!response.ok) {
          const payload = await responseJson(response);
          throw new FatalApiError(
            safeResponseMessage(payload, `History scan failed with HTTP ${response.status}.`),
            response.status,
          );
        }

        const messages = await response.json();
        const nextBefore = validateHistoryPage(messages, target, before, pageLimit);
        debugLog('history-page', {
          status: response.status,
          requestedLimit: pageLimit,
          rateLimitRemaining: response.headers.get('X-RateLimit-Remaining'),
          rateLimitResetAfter: response.headers.get('X-RateLimit-Reset-After'),
          ...historyPageDiagnostics(messages, {
            target,
            userId: runState.userId,
            before,
            pageNumber: runState.scannedPages + 1,
            anchorFound: runState.anchorFound,
          }),
        });
        if (messages.length === 0) {
          consecutiveEmptyPages += 1;
          if (consecutiveEmptyPages >= config.emptyPageConfirmations) {
            runState.historyComplete = true;
            break;
          }
          log(
            'warn',
            `History returned an empty page; confirming end-of-history (${consecutiveEmptyPages}/${config.emptyPageConfirmations}).`,
          );
          await interruptibleSleep(jitter(config.scanDelayMs, config.jitterPercent));
          continue;
        }
        consecutiveEmptyPages = 0;
        runState.scannedPages += 1;
        let batchMessages = messages;
        let skippedOnPage = 0;
        if (!runState.anchorFound) {
          const anchorIndex = messages.findIndex(
            (message) => isDeletableOwnedMessage(message, runState.userId),
          );
          if (anchorIndex === -1) {
            runState.skippedNewerMessages += messages.length;
            runState.scannedMessages += messages.length;
            batchMessages = [];
          } else {
            runState.anchorFound = true;
            runState.anchorMethod = 'history';
            runState.status = 'scanning';
            runState.skippedNewerMessages += anchorIndex;
            skippedOnPage = anchorIndex;
            batchMessages = messages.slice(anchorIndex);
            const anchorMessage = messages[anchorIndex];
            log(
              'success',
              `Found your latest deletable message at ${formatDate(anchorMessage.timestamp)} after fast-skipping ${runState.skippedNewerMessages.toLocaleString()} newer combined items. Batch 1 starts here.`,
            );
          }
        }
        batchMessages = trimToOwnedBatchBoundary(batchMessages, config);
        const deletableOwnedOnPage = batchMessages.reduce(
          (count, message) => count + (
            isDeletableOwnedMessage(message, runState.userId) ? 1 : 0
          ),
          0,
        );
        runState.scannedMessages += skippedOnPage;

        for (const message of batchMessages) {
          recordBatchMessage(message, target, config, compiledRegex, excludedTerms);
        }

        const remainingAllowance = remainingDeletionAllowance(config);
        const batchConfig = {
          ...config,
          maxMessages: Number.isFinite(remainingAllowance) ? remainingAllowance : 0,
        };
        if (
          config.deleteOrder === 'oldest'
          && batchConfig.maxMessages > 0
          && runState.queue.length > batchConfig.maxMessages
        ) {
          runState.queue = prepareQueue(runState.queue, batchConfig);
        }

        const oldest = batchMessages[batchMessages.length - 1] || messages[messages.length - 1];
        let oldestForDateBoundary = oldest;
        const stoppedAtOwnedBoundary = batchMessages.length > 0
          && batchMessages.length < messages.length - skippedOnPage;
        before = stoppedAtOwnedBoundary ? String(oldest.id) : nextBefore;
        runState.scanCursor = before;
        if (
          runState.anchorFound
          && runState.batchMode === 'owned'
          && config.anchorLookupMode === 'search'
          && deletableOwnedOnPage === 0
          && messages.length === pageLimit
          && !stoppedAtOwnedBoundary
          && before
        ) {
          const directHistoryCursor = before;
          const jumpAnchor = await discoverLatestOwnedMessage(
            target,
            runState.userId,
            config,
            {
              maxId: directHistoryCursor,
              purpose: 'sparse-window next-message lookup',
              lookupLabel: 'Sparse-window author lookup',
            },
          );
          if (jumpAnchor) {
            before = String(jumpAnchor.id);
            runState.scanCursor = before;
            runState.sparseSearchJumps += 1;
            recordBatchMessage(
              jumpAnchor,
              target,
              config,
              compiledRegex,
              excludedTerms,
            );
            oldestForDateBoundary = jumpAnchor;
            debugLog('sparse-window-jump', {
              fromHistoryCursor: debugId(directHistoryCursor),
              toOwnedMessage: debugId(jumpAnchor.id),
              timestamp: String(jumpAnchor.timestamp || ''),
              selectedType: messageType(jumpAnchor),
              jumpNumber: runState.sparseSearchJumps,
              batchOwned: runState.batchOwnedMessages,
            });
            log(
              'success',
              `No deletable message from you appeared in the last ${messages.length.toLocaleString()} history items, so the scanner jumped to your next deletable message at ${formatDate(jumpAnchor.timestamp)}. Undeletable call/system entries do not count toward the batch.`,
            );
          }
        }
        debugLog('history-page-processed', {
          page: runState.scannedPages,
          processedFromPage: batchMessages.length,
          skippedBeforeAnchor: skippedOnPage,
          stoppedAtOwnedBoundary,
          nextBefore: debugId(before),
          totalInspected: runState.scannedMessages,
          batchInspected: runState.batchScannedMessages,
          batchOwned: runState.batchOwnedMessages,
          ignoredOwnedSystem: runState.batchIgnoredOwnedSystemMessages,
          sparseSearchJumps: runState.sparseSearchJumps,
          batchFilterMatches: runState.batchFilterMatches,
        });
        if (
          runState.anchorFound
          && !runtime.suspiciousOwnershipWarningShown
          && runState.batchScannedMessages >= 500
          && runState.batchOwnedMessages <= 1
        ) {
          runtime.suspiciousOwnershipWarningShown = true;
          debugLog('suspicious-ownership-count', {
            reason: 'At most one deletable owned message was recognized after at least 500 anchored history items and any available sparse-window jumps.',
            batchInspected: runState.batchScannedMessages,
            batchOwned: runState.batchOwnedMessages,
            authenticatedUser: debugId(runState.userId),
            runtimeUser: debugId(currentUser?.id),
            identityStillMatches: String(currentUser?.id || '') === String(runState.userId || ''),
          });
          log(
            'warn',
            'The ownership count looks suspiciously sparse. A redacted technical trace is ready under “Diagnostics for bug reports”; you can stop the scan and copy it.',
          );
        }
        if (config.afterDate) {
          const oldestTimestamp = new Date(oldestForDateBoundary.timestamp).getTime();
          if (oldestTimestamp < new Date(config.afterDate).getTime()) {
            reachedDateFloor = true;
            runState.historyComplete = true;
          }
        }
        if (runState.scannedPages % 5 === 0) saveRunState();
        else updateUi();
        log(
          'info',
          runState.anchorFound
            ? `Inspected ${runState.scannedMessages.toLocaleString()} messages total; batch ${runState.batchNumber}: ${runState.batchScannedMessages.toLocaleString()} processed from the anchor, ${runState.batchOwnedMessages.toLocaleString()} deletable messages authored by your account, ${runState.batchIgnoredOwnedSystemMessages.toLocaleString()} authored call/system entries ignored, ${runState.batchFilterMatches.toLocaleString()} passed filters, ${runState.sparseSearchJumps.toLocaleString()} sparse-window jumps.`
            : `Fast-seeking your latest deletable message: inspected and skipped ${runState.skippedNewerMessages.toLocaleString()} newer combined messages; none was a deletable message authored by your account.`,
        );

        if (reachedDateFloor) break;
        if (!runState.anchorFound) {
          // The request layer already learns Discord's live limit headers and
          // obeys every 429. Avoid an additional fixed delay while seeking.
          continue;
        }
        if (
          batchCapacityReached(config)
          && runState.queue.length > 0
        ) {
          break;
        }
        if (batchCapacityReached(config)) {
          log(
            'info',
            `Batch ${runState.batchNumber} had no queued matches: ${runState.batchOwnedMessages.toLocaleString()} deletable messages were yours, ${runState.batchIgnoredOwnedSystemMessages.toLocaleString()} authored call/system entries were ignored, and ${runState.batchFilterMatches.toLocaleString()} passed the active filters. Continuing to older history.`,
          );
          runState.batchNumber += 1;
          runState.batchScannedMessages = 0;
          runState.batchOwnedMessages = 0;
          runState.batchIgnoredOwnedSystemMessages = 0;
          runState.batchFilterMatches = 0;
        }
        await interruptibleSleep(jitter(config.scanDelayMs, config.jitterPercent));
      }

      const remainingAllowance = remainingDeletionAllowance(config);
      const batchConfig = {
        ...config,
        maxMessages: Number.isFinite(remainingAllowance) ? remainingAllowance : 0,
      };
      runState.queue = prepareQueue(runState.queue, batchConfig);
      updateQueueRange();
      runState.initialMatches = runState.queue.length;
      runState.matchedMessages = runState.queue.length;
      runState.batchProcessed = 0;
      if (runState.historyComplete && runState.queue.length === 0) {
        runState.status = 'complete';
        runState.operation = '';
        runState.confirmed = false;
      } else {
        runState.status = 'scanned';
        runState.operation = runState.confirmed ? 'batching' : '';
      }
      saveRunState();
      if (runState.queue.length > 0) {
        const accountLabel = user.username ? `@${user.username}` : `account ${user.id}`;
        const anchorSummary = runState.batchNumber === 1
          ? runState.anchorMethod === 'search'
            ? 'started at your latest deletable message found by the fast author-locked lookup'
            : `started at your latest deletable message after skipping ${runState.skippedNewerMessages.toLocaleString()} newer items`
          : runState.anchorMethod === 'search'
            ? 'remains anchored below the latest deletable message found by the fast author-locked lookup'
            : `remains anchored below the ${runState.skippedNewerMessages.toLocaleString()} newer messages skipped before batch 1`;
        log(
          'success',
          `Batch ${runState.batchNumber} ready: ${anchorSummary}; ${runState.batchScannedMessages.toLocaleString()} messages processed; ${runState.batchOwnedMessages.toLocaleString()} deletable messages authored by ${accountLabel}; ${runState.batchIgnoredOwnedSystemMessages.toLocaleString()} authored call/system entries ignored; ${runState.sparseSearchJumps.toLocaleString()} sparse-window jumps; ${runState.batchFilterMatches.toLocaleString()} passed filters; ${runState.queue.length.toLocaleString()} queued. ${runtime.matchLogs.length.toLocaleString()} matches are displayed in the memory-only matched-message log. Older history has not been scanned yet.`,
        );
      } else {
        log(
          'success',
          runState.anchorFound
            ? 'History scan complete: no additional matching messages remain.'
            : `History scan complete: none of the ${runState.scannedMessages.toLocaleString()} inspected items was a deletable message authored by the authenticated account.`,
        );
      }
      debugLog('scan-finished', {
        status: runState.status,
        historyComplete: runState.historyComplete,
        anchorMethod: runState.anchorMethod,
        pages: runState.scannedPages,
        inspected: runState.scannedMessages,
        batchInspected: runState.batchScannedMessages,
        batchOwned: runState.batchOwnedMessages,
        ignoredOwnedSystem: runState.batchIgnoredOwnedSystemMessages,
        sparseSearchJumps: runState.sparseSearchJumps,
        batchFilterMatches: runState.batchFilterMatches,
        queued: runState.queue.length,
        scanCursor: debugId(runState.scanCursor),
      });
    } catch (error) {
      const errorText = String(error?.message || error || '');
      debugLog('scan-error', {
        name: error?.name || 'Error',
        status: Number.isFinite(error?.status) ? error.status : null,
        messageFingerprint: fnv1a(errorText),
        messageLength: errorText.length,
        preflight: runtime.preflight,
        pages: runState.scannedPages,
        inspected: runState.scannedMessages,
        batchOwned: runState.batchOwnedMessages,
        ignoredOwnedSystem: runState.batchIgnoredOwnedSystemMessages,
        sparseSearchJumps: runState.sparseSearchJumps,
        scanCursor: debugId(runState.scanCursor),
      });
      if (error instanceof StopSignal) {
        log('info', 'Scan stopped. Its checkpoint was preserved.');
      } else {
        if (!runtime.preflight) {
          runState.status = 'paused';
          runState.operation = 'scanning';
          saveRunState();
        }
        log('error', error.message || String(error));
      }
    } finally {
      runtime.mode = 'idle';
      runtime.paused = false;
      runtime.stopped = false;
      runtime.pauseReason = '';
      runtime.activeTarget = null;
      runtime.preflight = false;
      abortActiveRequest();
      updateUi();
    }
  }

  function deletionConfirmationCopy() {
    const count = runState.queue.length;
    const phrase = `DELETE ${count} FROM ${runState.target.channelId}`;
    return {
      count,
      phrase,
      lines: [
        `This permanently deletes ${count.toLocaleString()} deletable messages authored by your account`,
        `from ${formatTarget(runState.target)}.`,
        runState.anchorMethod === 'search'
          ? 'Batch 1 began at your latest deletable message found by the fast author-locked lookup.'
          : `Batch 1 began at your latest deletable message after skipping ${runState.skippedNewerMessages.toLocaleString()} newer items.`,
        `Matched range: ${formatDate(runState.lastTimestamp)} → ${formatDate(runState.firstTimestamp)}.`,
        `Deletion order: ${runState.config.deleteOrder} first. The first request targets ${formatDate(runState.queue[0]?.timestamp)}.`,
        runState.batchMode === 'owned'
          ? `After this preview, the run continues in batches of ${runState.config.scanBatchSize.toLocaleString()} deletable messages authored by your account; call/system entries never consume capacity.`
          : `This upgraded checkpoint retains its original ${runState.config.scanBatchSize.toLocaleString()}-history-message batch boundary.`,
        '',
        'Deleted messages cannot be recovered.',
      ],
    };
  }

  function finishDeletionConfirmation(accepted) {
    const pending = runtime.deletionConfirmation;
    if (!pending) return false;
    const overlay = shadow?.getElementById('dpe-confirm-overlay');
    const input = shadow?.getElementById('dpe-confirm-input');
    const entered = String(input?.value || '').trim();
    const matched = Boolean(accepted && entered === pending.phrase);
    runtime.deletionConfirmation = null;
    if (overlay) overlay.hidden = true;
    if (input) input.value = '';
    const startButton = shadow?.getElementById('dpe-confirm-start');
    if (startButton) startButton.disabled = true;
    debugLog('deletion-confirmation-result', {
      accepted: Boolean(accepted),
      phraseMatched: matched,
      enteredLength: entered.length,
      expectedLength: pending.phrase.length,
    });
    pending.resolve(matched);
    return matched;
  }

  async function confirmDeletion() {
    const copy = deletionConfirmationCopy();
    const overlay = shadow?.getElementById('dpe-confirm-overlay');
    const details = shadow?.getElementById('dpe-confirm-details');
    const phraseDisplay = shadow?.getElementById('dpe-confirm-phrase');
    const input = shadow?.getElementById('dpe-confirm-input');
    const startButton = shadow?.getElementById('dpe-confirm-start');
    if (overlay && details && phraseDisplay && input && startButton) {
      if (runtime.deletionConfirmation) finishDeletionConfirmation(false);
      details.textContent = copy.lines.join('\n');
      phraseDisplay.textContent = copy.phrase;
      input.value = '';
      startButton.disabled = true;
      overlay.hidden = false;
      debugLog('deletion-confirmation-shown', {
        queueCount: copy.count,
        order: runState.config.deleteOrder,
        firstMessage: debugId(runState.queue[0]?.id),
        firstTimestamp: String(runState.queue[0]?.timestamp || ''),
        confirmationSurface: 'in-panel',
      });
      return new Promise((resolve) => {
        runtime.deletionConfirmation = { phrase: copy.phrase, resolve };
        try { input.focus(); } catch {}
      });
    }

    debugLog('deletion-confirmation-shown', {
      queueCount: copy.count,
      order: runState.config.deleteOrder,
      firstMessage: debugId(runState.queue[0]?.id),
      firstTimestamp: String(runState.queue[0]?.timestamp || ''),
      confirmationSurface: 'native-fallback',
    });
    const entered = pageWindow.prompt(
      [...copy.lines, `Type exactly: ${copy.phrase}`].join('\n'),
      '',
    );
    const matched = typeof entered === 'string' && entered.trim() === copy.phrase;
    debugLog('deletion-confirmation-result', {
      accepted: typeof entered === 'string',
      phraseMatched: matched,
      enteredLength: typeof entered === 'string' ? entered.trim().length : 0,
      expectedLength: copy.phrase.length,
    });
    return matched;
  }

  function nextDeleteDelay(config) {
    const learned = Math.max(
      config.baseDeleteDelayMs,
      runtime.adaptiveDeleteDelayMs || 0,
      runtime.headerDeleteDelayMs || 0,
    );
    return Math.max(
      config.baseDeleteDelayMs,
      jitter(
        clamp(learned, config.baseDeleteDelayMs, config.maxAdaptiveDelayMs),
        config.jitterPercent,
      ),
    );
  }

  function finalizeDeletionBatch(config, { recovered = false } = {}) {
    const workflowComplete = runState.historyComplete || deletionLimitReached(config);
    runState.status = workflowComplete ? 'complete' : 'batch-complete';
    runState.operation = workflowComplete ? '' : 'batching';
    runState.confirmed = !workflowComplete;
    saveRunState();
    if (workflowComplete) {
      log(
        'success',
        `${recovered ? 'Recovered completed batch. ' : ''}Finished: ${runState.deleted.toLocaleString()} deleted, ${runState.alreadyGone.toLocaleString()} already gone, ${runState.failed.toLocaleString()} failed.`,
      );
    } else {
      log(
        'success',
        runState.batchMode === 'owned'
          ? `${recovered ? 'Recovered completed batch; ' : `Batch ${runState.batchNumber} deleted; `}collecting the next ${config.scanBatchSize.toLocaleString()} deletable messages authored by your account.`
          : `${recovered ? 'Recovered completed batch; ' : `Batch ${runState.batchNumber} deleted; `}scanning the next ${config.scanBatchSize.toLocaleString()} combined history messages under the preserved checkpoint mode.`,
      );
    }
  }

  async function startDelete({ resume = false, auto = false } = {}) {
    debugLog('deletion-entry', {
      resume: Boolean(resume),
      auto: Boolean(auto),
      runtimeMode: runtime.mode,
      status: runState.status,
      operation: runState.operation,
      queueCount: runState.queue.length,
      confirmed: runState.confirmed,
      targetMatches: sameTarget(parseTarget(), runState.target),
    });
    if (runtime.mode !== 'idle') {
      debugLog('deletion-blocked', { reason: 'runtime-not-idle', runtimeMode: runtime.mode });
      return;
    }
    const target = runState.target;
    const config = runState.config;
    if (!target || !config || !runState.queue.length) {
      debugLog('deletion-blocked', {
        reason: 'missing-target-config-or-queue',
        hasTarget: Boolean(target),
        hasConfig: Boolean(config),
        queueCount: runState.queue.length,
      });
      log('error', 'There is no non-empty dry-run queue to delete.');
      return;
    }
    if (!sameTarget(parseTarget(), target)) {
      debugLog('deletion-blocked', { reason: 'open-target-mismatch' });
      log('error', 'Return to the exact channel/DM used for the dry run before deleting.');
      return;
    }
    if (!validateQueueIntegrity(runState, target)) {
      debugLog('deletion-blocked', { reason: 'queue-integrity-failed' });
      log('error', 'The saved queue failed its channel or checksum integrity check. Run a new dry scan.');
      return;
    }

    try {
      debugLog('deletion-preflight-start', {
        queueCount: runState.queue.length,
        lockedUser: debugId(runState.userId),
        lockedTarget: debugId(target.channelId),
      });
      validateConfig(config);
      restorePersistedPacing(config);
      const user = await resolveCurrentUser({ force: true });
      const expectedSignature = configSignature(config, target, user.id);
      if (runState.signature !== expectedSignature || runState.userId !== user.id) {
        throw new Error('The target, signed-in account, or filters changed. Run a new dry run.');
      }
      debugLog('deletion-preflight-passed', {
        authenticatedUser: debugId(user.id),
        lockedUserMatches: runState.userId === user.id,
        signatureMatches: runState.signature === expectedSignature,
      });
      if (!resume && !runState.confirmed) {
        const confirmed = await confirmDeletion();
        if (!confirmed) {
          log('warn', 'Deletion cancelled: the confirmation phrase did not match.');
          return;
        }
        runState.confirmed = true;
      }
    } catch (error) {
      debugLog('deletion-preflight-error', {
        name: String(error?.name || 'Error'),
        status: Number(error?.status || 0),
        messageLength: String(error?.message || error || '').length,
      });
      log('error', error.message);
      return;
    }

    runtime.mode = 'deleting';
    runtime.paused = false;
    runtime.stopped = false;
    runtime.pauseReason = '';
    runtime.startedAt = Date.now();
    runtime.activeTarget = target;
    restorePersistedPacing(config);
    runtime.headerDeleteDelayMs = 0;
    runtime.successesSinceLimit = 0;
    runState.status = 'deleting';
    runState.operation = 'deleting';
    saveRunState();
    log(
      auto ? 'warn' : 'info',
      `${auto ? 'Auto-resumed' : 'Started'} permanent deletion of the locked dry-run queue. ${config.deleteOrder === 'oldest' ? 'Oldest' : 'Newest'} first; the first request targets ${formatDate(runState.queue[0]?.timestamp)}.`,
    );
    debugLog('deletion-started', {
      queueCount: runState.queue.length,
      order: config.deleteOrder,
      firstMessage: debugId(runState.queue[0]?.id),
      firstTimestamp: String(runState.queue[0]?.timestamp || ''),
      apiVersion,
      baseDelayMs: config.baseDeleteDelayMs,
    });

    let consecutiveErrors = 0;
    let operationsSinceCheckpoint = 0;

    try {
      while (runState.queue.length > 0) {
        await controlPoint();
        if (!currentUser?.id) {
          const activeUser = await resolveCurrentUser({ force: true });
          if (activeUser.id !== runState.userId) {
            throw new FatalApiError(
              'The signed-in Discord account changed. Deletion was paused before another message was touched.',
            );
          }
        }
        const message = runState.queue[0];
        let response;
        try {
          debugLog('delete-request', {
            message: debugId(message.id),
            channel: debugId(message.channelId),
            timestamp: String(message.timestamp || ''),
            queueRemaining: runState.queue.length,
            batchPosition: runState.batchProcessed + 1,
            apiVersion,
          });
          response = await apiRequest(
            `/channels/${message.channelId}/messages/${message.id}`,
            { method: 'DELETE', purpose: 'message deletion' },
          );
          debugLog('delete-response', {
            message: debugId(message.id),
            timestamp: String(message.timestamp || ''),
            status: response.status,
            ok: response.ok,
            queueRemainingBeforeApply: runState.queue.length,
            rateLimitRemaining: response.headers.get('X-RateLimit-Remaining'),
            rateLimitResetAfter: response.headers.get('X-RateLimit-Reset-After'),
          });
        } catch (error) {
          debugLog('delete-request-error', {
            message: debugId(message.id),
            timestamp: String(message.timestamp || ''),
            name: String(error?.name || 'Error'),
            status: Number(error?.status || 0),
            messageLength: String(error?.message || error || '').length,
          });
          if (error instanceof StopSignal) throw error;
          if (error instanceof FatalApiError) throw error;
          consecutiveErrors += 1;
          log('error', `Delete ${message.id} failed: ${error.message}`);
          if (consecutiveErrors >= config.stopAfterErrors) {
            throw new FatalApiError(
              `Paused after ${consecutiveErrors} consecutive errors. The queue is preserved.`,
            );
          }
          await interruptibleSleep(nextDeleteDelay(config));
          continue;
        }

        if (response.status === 204 || response.status === 404) {
          runState.queue.shift();
          if (response.status === 204) runState.deleted += 1;
          else runState.alreadyGone += 1;
          runState.batchProcessed += 1;
          consecutiveErrors = 0;
          runtime.successesSinceLimit += 1;
          operationsSinceCheckpoint += 1;
          log(
            response.status === 204 ? 'success' : 'info',
            response.status === 204
              ? `Deleted ${runState.deleted.toLocaleString()} total · batch ${runState.batchProcessed.toLocaleString()}/${runState.initialMatches.toLocaleString()} · ${formatDate(message.timestamp)} · ${runState.queue.length.toLocaleString()} queued messages remain.`
              : `Message at ${formatDate(message.timestamp)} was already gone · ${runState.queue.length.toLocaleString()} queued messages remain.`,
          );

          if (runtime.successesSinceLimit >= 20) {
            runtime.adaptiveDeleteDelayMs = Math.max(
              config.baseDeleteDelayMs,
              Math.round(runtime.adaptiveDeleteDelayMs * 0.9),
            );
            runState.learnedDeleteDelayMs = Math.max(
              runtime.adaptiveDeleteDelayMs,
              runtime.headerDeleteDelayMs,
            );
            runtime.successesSinceLimit = 0;
          }
        } else if ([400, 403].includes(response.status)) {
          const payload = await responseJson(response);
          runState.queue.shift();
          runState.failed += 1;
          runState.batchProcessed += 1;
          consecutiveErrors += 1;
          operationsSinceCheckpoint += 1;
          if (runState.failures.length < SCRIPT.maxSavedFailures) {
            runState.failures.push(message);
          }
          log(
            'warn',
            `Skipped message ${message.id}: ${safeResponseMessage(payload, `HTTP ${response.status}`)}.`,
          );
        } else {
          const payload = await responseJson(response);
          consecutiveErrors += 1;
          log(
            'error',
            `Delete ${message.id} returned ${response.status}: ${safeResponseMessage(payload, 'Unknown error')}.`,
          );
        }

        if (consecutiveErrors >= config.stopAfterErrors) {
          throw new FatalApiError(
            `Paused after ${consecutiveErrors} consecutive errors. The remaining queue is preserved.`,
          );
        }

        if (operationsSinceCheckpoint >= config.checkpointEvery) {
          saveRunState();
          operationsSinceCheckpoint = 0;
        } else {
          updateUi();
        }

        if (runState.queue.length > 0) {
          await interruptibleSleep(nextDeleteDelay(config));
        }
      }

      finalizeDeletionBatch(config);
      debugLog('deletion-finished', {
        status: runState.status,
        operation: runState.operation,
        deleted: runState.deleted,
        alreadyGone: runState.alreadyGone,
        failed: runState.failed,
        queueRemaining: runState.queue.length,
      });
    } catch (error) {
      debugLog('deletion-stopped-or-error', {
        stopped: error instanceof StopSignal,
        name: String(error?.name || 'Error'),
        status: Number(error?.status || 0),
        messageLength: String(error?.message || error || '').length,
        deleted: runState.deleted,
        alreadyGone: runState.alreadyGone,
        failed: runState.failed,
        queueRemaining: runState.queue.length,
      });
      if (error instanceof StopSignal) {
        log('info', 'Deletion stopped. Remaining messages were preserved in the checkpoint.');
      } else {
        runtime.paused = false;
        runState.status = 'paused';
        runState.operation = 'deleting';
        saveRunState();
        log('error', error.message || String(error));
      }
    } finally {
      runtime.mode = 'idle';
      runtime.paused = false;
      runtime.stopped = false;
      runtime.pauseReason = '';
      runtime.activeTarget = null;
      abortActiveRequest();
      updateUi();
    }
  }

  async function startContinuousDeletion({
    resume = false,
    auto = false,
    continueFromCheckpoint = false,
  } = {}) {
    if (runtime.batchLoop) return;
    runtime.batchLoop = true;
    updateUi();
    try {
      if (continueFromCheckpoint) {
        const beforeStep = batchProgressFingerprint();
        if (
          runState.operation === 'deleting'
          && runState.confirmed
          && runState.queue.length === 0
          && runState.config
        ) {
          finalizeDeletionBatch(runState.config, { recovered: true });
        }
        if (runState.operation === 'scanning') {
          await startScan({ resume: true });
        } else if (runState.operation === 'batching' && runState.queue.length === 0) {
          await startScan({ continuation: true });
        } else if (runState.queue.length > 0) {
          await startDelete({ resume: true, auto });
        }
        if (batchProgressFingerprint() === beforeStep) {
          log('warn', 'Continuous batching stopped because the checkpoint made no progress.');
          return;
        }
      } else {
        await startDelete({ resume, auto });
      }

      while (true) {
        if (
          runState.status === 'scanned'
          && runState.operation === 'batching'
          && runState.confirmed
          && runState.queue.length > 0
        ) {
          const beforeStep = batchProgressFingerprint();
          await startDelete({ resume: true, auto: true });
          if (batchProgressFingerprint() === beforeStep) {
            log('warn', 'Continuous batching stopped because deletion made no progress.');
            break;
          }
          continue;
        }
        if (
          runState.status === 'batch-complete'
          && runState.operation === 'batching'
          && runState.confirmed
          && !runState.historyComplete
          && !deletionLimitReached(runState.config)
        ) {
          const beforeStep = batchProgressFingerprint();
          await startScan({ continuation: true });
          if (batchProgressFingerprint() === beforeStep) {
            log('warn', 'Continuous batching stopped because scanning made no progress.');
            break;
          }
          continue;
        }
        break;
      }
    } finally {
      runtime.batchLoop = false;
      updateUi();
    }
  }

  function batchProgressFingerprint() {
    return [
      runState.status,
      runState.operation,
      runState.scanCursor,
      runState.scannedMessages,
      runState.queue.length,
      runState.deleted,
      runState.alreadyGone,
      runState.failed,
      runState.historyComplete,
    ].join('|');
  }

  function pauseActive() {
    if (runtime.mode === 'idle' || runtime.paused) return;
    runtime.paused = true;
    runtime.pauseReason = 'Paused by you.';
    runState.status = 'paused';
    runState.operation = runtime.mode;
    saveRunState();
    log('info', 'Paused. The active request, if any, will finish; no new request will start.');
  }

  function resumeActive() {
    if (runtime.mode === 'idle' || !runtime.paused) return;
    if (
      runState.config?.pauseOnNavigate
      && !sameTarget(parseTarget(), runState.target)
    ) {
      log('error', 'Return to the locked target before resuming.');
      return;
    }
    runtime.paused = false;
    runtime.pauseReason = '';
    runState.status = runtime.mode === 'scanning' ? 'scanning' : 'deleting';
    saveRunState();
    wakeRuntime();
    log('info', 'Resumed.');
  }

  function stopActive() {
    if (autoResumeTimer) {
      clearTimeout(autoResumeTimer);
      autoResumeTimer = null;
      clearInterval(autoResumeInterval);
      autoResumeInterval = null;
      runState.status = 'stopped';
      saveRunState();
      log('info', 'Automatic resume cancelled. The checkpoint is still available.');
      return;
    }
    if (runtime.mode === 'idle') {
      if (runtime.batchLoop) {
        if (runtime.deletionConfirmation) finishDeletionConfirmation(false);
        runtime.stopped = true;
        runState.status = 'stopped';
        runState.operation = 'batching';
        saveRunState();
        log('info', 'Continuous batching stopped. The checkpoint is still available.');
        return;
      }
      if (['seeking-latest', 'scanning', 'deleting', 'paused'].includes(runState.status)) {
        runState.status = 'stopped';
        saveRunState();
        log('info', 'Checkpoint marked as stopped; it remains available for manual resume.');
      }
      return;
    }
    if (runtime.preflight) {
      runtime.stopped = true;
      runtime.paused = false;
      abortActiveRequest();
      wakeRuntime();
      log('info', 'Stopped before the existing checkpoint was changed.');
      return;
    }
    runtime.stopped = true;
    runtime.paused = false;
    runState.status = 'stopped';
    runState.operation = runtime.mode;
    saveRunState();
    abortActiveRequest();
    wakeRuntime();
  }

  async function resumeCheckpoint({ auto = false } = {}) {
    if (runtime.mode !== 'idle') {
      if (runtime.paused) resumeActive();
      return;
    }
    if (!runState.target || !runState.operation) {
      log('error', 'No interrupted scan or deletion checkpoint is available.');
      return;
    }
    if (!sameTarget(parseTarget(), runState.target)) {
      log('error', `Open the checkpoint target first: ${formatTarget(runState.target)}.`);
      return;
    }
    if (runState.confirmed && ['scanning', 'deleting', 'batching'].includes(runState.operation)) {
      await startContinuousDeletion({ continueFromCheckpoint: true, auto });
    } else if (runState.operation === 'scanning') {
      await startScan({ resume: true });
    } else if (runState.operation === 'deleting' || runState.operation === 'batching') {
      log('error', 'This deletion checkpoint was never confirmed. Run a new dry run.');
    }
  }

  function retryFailures() {
    if (runtime.mode !== 'idle' || !runState.failures.length) return;
    runState.queue = prepareQueue([...runState.failures], runState.config || defaultPrefs);
    runState.failures = [];
    runState.initialMatches = runState.queue.length;
    runState.matchedMessages = runState.queue.length;
    runState.batchOwnedMessages = runState.queue.length;
    runState.batchIgnoredOwnedSystemMessages = 0;
    runState.batchFilterMatches = runState.queue.length;
    runState.anchorFound = true;
    runState.failed = 0;
    runState.batchProcessed = 0;
    runState.historyComplete = true;
    updateQueueRange();
    runState.status = 'scanned';
    runState.operation = '';
    runState.confirmed = false;
    saveRunState();
    log('info', 'Failed message IDs were returned to a fresh review queue.');
  }

  function clearCheckpoint() {
    if (runtime.mode !== 'idle') {
      log('error', 'Stop the active operation before clearing its checkpoint.');
      return;
    }
    if (!pageWindow.confirm('Clear the local scan/deletion checkpoint? This does not restore deleted messages.')) {
      return;
    }
    storageDelete(SCRIPT.runKey);
    runState = emptyRunState();
    log('info', 'Local checkpoint cleared.');
    updateUi();
  }

  function updateAuthStatus() {
    if (!shadow) return;
    const dot = shadow.getElementById('dpe-auth-dot');
    const text = shadow.getElementById('dpe-auth-text');
    if (!dot || !text) return;
    dot.dataset.ready = authToken ? 'true' : 'false';
    text.textContent = authToken
      ? `Session ready${currentUser?.username ? ` as ${currentUser.username}` : ''} · token held only in memory`
      : 'Waiting for Discord session · token is never shown or saved';
  }

  function updateLog() {
    if (!shadow) return;
    const output = shadow.getElementById('dpe-log');
    if (!output) return;
    output.textContent = runtime.logs
      .map((entry) => `[${entry.at}] ${entry.level.toUpperCase()}: ${entry.message}`)
      .join('\n');
    output.scrollTop = output.scrollHeight;
  }

  function updateMatchLog() {
    if (!shadow) return;
    const output = shadow.getElementById('dpe-match-log');
    const count = shadow.getElementById('dpe-match-log-count');
    if (count) count.textContent = runtime.matchLogs.length.toLocaleString();
    if (!output) return;
    output.textContent = runtime.matchLogs.length
      ? runtime.matchLogs.join('\n\n')
      : 'No matching messages have been found in this batch yet.';
  }

  function updateDebugLog() {
    if (!shadow) return;
    const output = shadow.getElementById('dpe-debug-log');
    const count = shadow.getElementById('dpe-debug-log-count');
    if (count) count.textContent = runtime.debugLogs.length.toLocaleString();
    if (!output) return;
    output.textContent = runtime.debugLogs.length
      ? runtime.debugLogs.join('\n')
      : 'Start a fresh dry scan to collect redacted diagnostics.';
    output.scrollTop = output.scrollHeight;
  }

  async function copyDiagnostics() {
    if (!runtime.debugLogs.length) {
      log('warn', 'There are no diagnostics to copy yet. Start a fresh dry scan first.');
      return;
    }
    const text = diagnosticExportText();
    let copied = false;
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        copied = true;
      }
    } catch {}
    if (!copied) {
      try {
        const clipboard = pageWindow.navigator?.clipboard;
        if (typeof clipboard?.writeText === 'function') {
          await clipboard.writeText(text);
          copied = true;
        }
      } catch {}
    }
    if (!copied) {
      try {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.left = '-10000px';
        document.body.appendChild(helper);
        helper.select();
        copied = Boolean(document.execCommand?.('copy'));
        helper.remove();
      } catch {}
    }
    log(
      copied ? 'success' : 'error',
      copied
        ? 'Redacted diagnostics copied. Paste the entire block back into this Codex task.'
        : 'Automatic copy was blocked. Select the diagnostics text manually and copy it.',
    );
  }

  function updateUi() {
    if (!shadow) return;
    const target = parseTarget();
    const setText = (id, text) => {
      const element = shadow.getElementById(id);
      if (element) element.textContent = text;
    };
    setText('dpe-current-target', formatTarget(target));
    setText(
      'dpe-locked-target',
      runState.target ? formatTarget(runState.target) : 'No dry run yet',
    );
    setText('dpe-status', runtime.paused ? 'paused' : runState.status);
    setText('dpe-batch', runState.batchNumber.toLocaleString());
    setText(
      'dpe-skipped',
      runState.anchorMethod === 'search'
        ? 'fast lookup'
        : runState.skippedNewerMessages.toLocaleString(),
    );
    setText('dpe-scanned', runState.scannedMessages.toLocaleString());
    setText('dpe-owned', runState.batchOwnedMessages.toLocaleString());
    setText(
      'dpe-ignored-system',
      runState.batchIgnoredOwnedSystemMessages.toLocaleString(),
    );
    setText('dpe-search-jumps', runState.sparseSearchJumps.toLocaleString());
    setText('dpe-filtered', runState.batchFilterMatches.toLocaleString());
    setText('dpe-matched', runState.initialMatches.toLocaleString());
    setText('dpe-remaining', runState.queue.length.toLocaleString());
    setText('dpe-deleted', runState.deleted.toLocaleString());
    setText('dpe-failed', runState.failed.toLocaleString());
    setText('dpe-rate-limits', runState.rateLimits.toLocaleString());
    setText(
      'dpe-next-delete',
      runState.queue.length
        ? `${runState.config?.deleteOrder === 'newest' ? 'newest' : 'oldest'} first · ${formatDate(runState.queue[0]?.timestamp)}`
        : '—',
    );
    setText(
      'dpe-range',
      runState.initialMatches
        ? `${formatDate(runState.lastTimestamp)} → ${formatDate(runState.firstTimestamp)}`
        : '—',
    );

    const total = Math.max(0, runState.initialMatches);
    const processed = Math.max(0, runState.batchProcessed);
    const percent = total > 0 ? clamp((processed / total) * 100, 0, 100) : 0;
    const progress = shadow.getElementById('dpe-progress-bar');
    if (progress) progress.style.width = `${percent}%`;
    setText('dpe-progress-text', total ? `${percent.toFixed(1)}%` : '0%');

    const isBusy = runtime.mode !== 'idle' || runtime.batchLoop;
    const savedOperation = Boolean(runState.operation && runState.target);
    const sameLockedTarget = sameTarget(target, runState.target);
    const prefs = readConfigFromUi();
    setText(
      'dpe-scope-note',
      isDeleteEverythingConfig(prefs)
        ? 'Default scope: delete every deletable message authored by your account, including pinned and edited messages; undeletable call/system entries are ignored.'
        : 'Custom scope active: one or more filters or preservation limits will exclude messages.',
    );
    const liveSignature = currentUser?.id && target
      ? configSignature(prefs, target, currentUser.id)
      : '';
    const deletable = (
      !isBusy
      && runState.status === 'scanned'
      && runState.queue.length > 0
      && sameLockedTarget
      && runState.signature === liveSignature
    );

    const setDisabled = (id, disabled) => {
      const element = shadow.getElementById(id);
      if (element) element.disabled = Boolean(disabled);
    };
    setDisabled('dpe-scan', isBusy || !target);
    setDisabled('dpe-delete', !deletable);
    setDisabled('dpe-pause', !isBusy || runtime.paused);
    setDisabled('dpe-resume', !(runtime.paused || (!isBusy && savedOperation)));
    setDisabled('dpe-stop', !(isBusy || savedOperation || autoResumeTimer));
    setDisabled('dpe-clear', isBusy || runState.status === 'idle');
    setDisabled('dpe-retry-failures', isBusy || runState.failures.length === 0);
    setText(
      'dpe-pacing',
      `${Math.round(Math.max(
        runState.config?.baseDeleteDelayMs || prefs.baseDeleteDelayMs,
        runtime.adaptiveDeleteDelayMs,
        runtime.headerDeleteDelayMs,
      ))} ms`,
    );
    updateAuthStatus();
    updateLog();
    updateMatchLog();
    updateDebugLog();
  }

  function bindUi() {
    const on = (id, event, handler) => {
      shadow.getElementById(id)?.addEventListener(event, handler);
    };
    on('dpe-launcher', 'click', () => {
      shadow.getElementById('dpe-panel')?.classList.toggle('open');
    });
    on('dpe-close', 'click', () => {
      shadow.getElementById('dpe-panel')?.classList.remove('open');
    });
    on('dpe-scan', 'click', () => startScan());
    on('dpe-delete', 'click', () => startContinuousDeletion());
    on('dpe-confirm-input', 'input', (event) => {
      const startButton = shadow.getElementById('dpe-confirm-start');
      const expected = runtime.deletionConfirmation?.phrase || '';
      if (startButton) {
        startButton.disabled = !expected || String(event.target?.value || '').trim() !== expected;
      }
    });
    on('dpe-confirm-input', 'keydown', (event) => {
      if (event.key === 'Escape') finishDeletionConfirmation(false);
      if (
        event.key === 'Enter'
        && !shadow.getElementById('dpe-confirm-start')?.disabled
      ) {
        finishDeletionConfirmation(true);
      }
    });
    on('dpe-confirm-cancel', 'click', () => finishDeletionConfirmation(false));
    on('dpe-confirm-start', 'click', () => finishDeletionConfirmation(true));
    on('dpe-pause', 'click', pauseActive);
    on('dpe-resume', 'click', () => resumeCheckpoint());
    on('dpe-stop', 'click', stopActive);
    on('dpe-clear', 'click', clearCheckpoint);
    on('dpe-retry-failures', 'click', retryFailures);
    on('dpe-clear-log', 'click', () => {
      runtime.logs = [];
      runtime.matchLogs = [];
      updateLog();
      updateMatchLog();
    });
    on('dpe-copy-debug', 'click', () => copyDiagnostics());
    on('dpe-clear-debug', 'click', () => {
      runtime.debugLogs = [];
      runtime.debugEventCount = 0;
      runtime.suspiciousOwnershipWarningShown = false;
      updateDebugLog();
      log('info', 'Redacted diagnostics cleared from memory.');
    });
    on('dpe-risk', 'change', () => {
      const prefs = readConfigFromUi();
      savePrefs(prefs);
      updateUi();
    });

    shadow.getElementById('dpe-form')?.addEventListener('input', () => {
      const prefs = readConfigFromUi();
      savePrefs(prefs);
      updateUi();
    });
    shadow.getElementById('dpe-form')?.addEventListener('change', () => {
      const prefs = readConfigFromUi();
      savePrefs(prefs);
      updateUi();
    });
  }

  function isolatePanelEvents(panel) {
    if (!panel) return;
    const localEventTypes = [
      'keydown',
      'keypress',
      'keyup',
      'beforeinput',
      'input',
      'change',
      'paste',
      'copy',
      'cut',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'focusin',
      'focusout',
      'pointerdown',
      'pointerup',
      'pointercancel',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'touchstart',
      'touchend',
      'contextmenu',
      'dragstart',
      'dragover',
      'drop',
      'wheel',
    ];
    for (const type of localEventTypes) {
      panel.addEventListener(type, (event) => {
        event.stopPropagation();
        event.stopImmediatePropagation?.();
      });
    }
  }

  function markShadowHostAsTextEntry(host) {
    if (!host) return;
    // Events crossing a shadow boundary are retargeted to the host. Marking that
    // host as an editing surface lets page-level shortcut handlers recognize
    // keystrokes as text entry. Contenteditable does not inherit into a shadow
    // tree, so only the real inputs remain editable inside the panel.
    host.contentEditable = 'true';
    host.spellcheck = false;
  }

  function mountUi() {
    if (rootHost || !document.body) return;
    rootHost = document.createElement('div');
    rootHost.id = 'dpe-root';
    markShadowHostAsTextEntry(rootHost);
    shadow = rootHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        button, input, select, textarea { font: inherit; }
        #dpe-launcher {
          position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
          border: 1px solid rgba(255,255,255,.16); border-radius: 999px;
          background: #da373c; color: white; padding: 11px 15px; cursor: pointer;
          box-shadow: 0 8px 30px rgba(0,0,0,.38); font: 700 13px/1 system-ui, sans-serif;
        }
        #dpe-launcher:hover { background: #a1282d; }
        #dpe-panel {
          display: none; position: fixed; z-index: 2147483647; right: 18px; bottom: 66px;
          width: min(470px, calc(100vw - 24px)); max-height: calc(100vh - 88px);
          overflow: auto; border: 1px solid #3f4147; border-radius: 12px;
          background: #1e1f22; color: #dbdee1; box-shadow: 0 18px 65px rgba(0,0,0,.55);
          font: 13px/1.42 system-ui, -apple-system, Segoe UI, sans-serif;
        }
        #dpe-panel.open { display: block; }
        header {
          position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px;
          padding: 13px 15px; border-bottom: 1px solid #3f4147; background: #2b2d31;
        }
        header strong { color: #f2f3f5; font-size: 15px; }
        header small { color: #949ba4; }
        #dpe-close { margin-left: auto; padding: 5px 9px; }
        main { padding: 13px; }
        .warning {
          padding: 10px; border: 1px solid #8f6914; border-radius: 8px;
          background: #33280f; color: #f0cf70; margin-bottom: 10px;
        }
        .warning label { display: flex; align-items: flex-start; gap: 8px; }
        .auth { display: flex; gap: 8px; align-items: center; color: #b5bac1; margin: 8px 0 12px; }
        #dpe-auth-dot { width: 9px; height: 9px; border-radius: 50%; background: #f0b232; flex: 0 0 auto; }
        #dpe-auth-dot[data-ready="true"] { background: #23a559; }
        .target {
          display: grid; grid-template-columns: 112px 1fr; gap: 5px 9px;
          padding: 9px; border-radius: 8px; background: #2b2d31; margin-bottom: 10px;
        }
        .target span:nth-child(odd) { color: #949ba4; }
        .target span:nth-child(even) { overflow-wrap: anywhere; color: #f2f3f5; }
        details { border-top: 1px solid #35373c; padding: 8px 0; }
        summary { cursor: pointer; color: #f2f3f5; font-weight: 700; padding: 3px 0 7px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
        .full { grid-column: 1 / -1; }
        label.field { display: grid; gap: 4px; color: #b5bac1; }
        label.field > span { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
        input[type="text"], input[type="number"], input[type="datetime-local"], select, textarea {
          width: 100%; border: 1px solid #3f4147; border-radius: 5px; padding: 7px 8px;
          background: #111214; color: #f2f3f5; outline: none;
        }
        textarea { resize: vertical; min-height: 54px; }
        input:focus, select:focus, textarea:focus { border-color: #5865f2; }
        label.check { display: flex; align-items: flex-start; gap: 7px; color: #b5bac1; padding: 3px 0; }
        input[type="checkbox"] { margin-top: 2px; accent-color: #5865f2; }
        .hint { color: #949ba4; font-size: 11px; margin-top: 4px; }
        .summary {
          display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin: 10px 0;
        }
        .metric { padding: 8px; border-radius: 7px; background: #2b2d31; }
        .metric b { display: block; color: #f2f3f5; font-size: 15px; }
        .metric span { color: #949ba4; font-size: 10px; text-transform: uppercase; }
        .range { color: #b5bac1; font-size: 11px; margin: 5px 0 9px; }
        .progress { height: 8px; overflow: hidden; border-radius: 999px; background: #111214; margin: 7px 0; }
        #dpe-progress-bar { width: 0; height: 100%; background: #23a559; transition: width .2s; }
        .actions { display: flex; flex-wrap: wrap; gap: 7px; margin: 10px 0; }
        button {
          border: 0; border-radius: 5px; padding: 8px 10px; cursor: pointer;
          background: #4e5058; color: #fff; font-weight: 700;
        }
        button:hover:not(:disabled) { filter: brightness(1.12); }
        button:disabled { cursor: not-allowed; opacity: .42; }
        button.primary { background: #5865f2; }
        button.danger { background: #da373c; }
        button.success { background: #248046; }
        #dpe-log, #dpe-match-log, #dpe-debug-log {
          overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
          margin: 7px 0; padding: 8px; border-radius: 6px; background: #111214;
          color: #b5bac1; font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        }
        #dpe-log { max-height: 150px; }
        #dpe-match-log { max-height: 280px; user-select: text; }
        #dpe-debug-log { max-height: 280px; user-select: text; }
        [hidden] { display: none !important; }
        #dpe-confirm-overlay {
          position: absolute; inset: 0; z-index: 20; padding: 16px;
          overflow: auto; background: rgba(17,18,20,.96);
        }
        .confirm-card {
          display: grid; gap: 10px; margin: 20px auto; padding: 14px;
          border: 1px solid #da373c; border-radius: 10px; background: #2b2d31;
        }
        .confirm-card h2 { margin: 0; color: #f2f3f5; font-size: 16px; }
        #dpe-confirm-details, #dpe-confirm-phrase {
          white-space: pre-wrap; overflow-wrap: anywhere; margin: 0;
        }
        #dpe-confirm-details { color: #b5bac1; }
        #dpe-confirm-phrase {
          padding: 8px; border-radius: 6px; background: #111214;
          color: #f0cf70; user-select: text; font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        }
        .confirm-actions { display: flex; justify-content: flex-end; gap: 7px; }
        .footer-note { color: #949ba4; font-size: 10px; margin-top: 9px; }
      </style>
      <button id="dpe-launcher" type="button">Privacy Eraser</button>
      <section id="dpe-panel" aria-label="Discord Privacy Eraser">
        <div id="dpe-confirm-overlay" role="dialog" aria-modal="true" aria-labelledby="dpe-confirm-title" hidden>
          <div class="confirm-card">
            <h2 id="dpe-confirm-title">Confirm permanent deletion</h2>
            <p id="dpe-confirm-details"></p>
            <span>Type this exact phrase:</span>
            <pre id="dpe-confirm-phrase"></pre>
            <input id="dpe-confirm-input" type="text" autocomplete="off" spellcheck="false">
            <div class="confirm-actions">
              <button id="dpe-confirm-cancel" type="button">Cancel</button>
              <button id="dpe-confirm-start" class="danger" type="button" disabled>Start deletion</button>
            </div>
          </div>
        </div>
        <header>
          <div>
            <strong>${SCRIPT.name}</strong><br>
            <small>v${SCRIPT.version} · current channel / DM only</small>
          </div>
          <button id="dpe-close" type="button" aria-label="Close">×</button>
        </header>
        <main>
          <div class="warning">
            <label>
              <input id="dpe-risk" form="dpe-form" type="checkbox">
              <span>I understand deletion is irreversible and Discord says automated normal-user accounts may be terminated. I accept that risk.</span>
            </label>
          </div>
          <div class="auth">
            <i id="dpe-auth-dot"></i>
            <span id="dpe-auth-text">Waiting for Discord session · token is never shown or saved</span>
          </div>
          <div class="target">
            <span>Open now</span><span id="dpe-current-target">—</span>
            <span>Dry-run lock</span><span id="dpe-locked-target">No dry run yet</span>
            <span>State</span><span id="dpe-status">idle</span>
          </div>

          <form id="dpe-form">
            <details open>
              <summary>Deletion filters</summary>
              <div class="grid">
                <label class="field">
                  <span>On or after (local time)</span>
                  <input id="dpe-after" type="datetime-local">
                </label>
                <label class="field">
                  <span>On or before (local time)</span>
                  <input id="dpe-before" type="datetime-local">
                </label>
                <label class="field full">
                  <span>Must contain (blank = everything)</span>
                  <input id="dpe-text" type="text" autocomplete="off" placeholder="Optional text or regular expression">
                </label>
                <label class="check"><input id="dpe-regex" type="checkbox"> Treat “must contain” as regex</label>
                <label class="check"><input id="dpe-case" type="checkbox"> Case-sensitive text matching</label>
                <label class="field full">
                  <span>Always preserve these phrases (one per line)</span>
                  <textarea id="dpe-exclude" placeholder="Messages containing any line are skipped"></textarea>
                </label>
                <label class="field">
                  <span>Attachments</span>
                  <select id="dpe-attachments">
                    <option value="any">Any</option>
                    <option value="with">Only with attachments</option>
                    <option value="without">Only without attachments</option>
                    <option value="images">Only with images</option>
                    <option value="nonimages">Only with non-image files</option>
                  </select>
                </label>
                <label class="field">
                  <span>Links</span>
                  <select id="dpe-links">
                    <option value="any">Any</option>
                    <option value="with">Only with links</option>
                    <option value="without">Only without links</option>
                  </select>
                </label>
                <label class="check"><input id="dpe-pinned" type="checkbox"> Include pinned messages</label>
                <label class="check"><input id="dpe-edited" type="checkbox"> Include edited messages</label>
                <label class="field">
                  <span>Protect messages newer than (hours)</span>
                  <input id="dpe-min-age" type="number" min="0" max="876000" step="1">
                </label>
                <label class="field">
                  <span>Maximum deletions (0 = unlimited)</span>
                  <input id="dpe-max-messages" type="number" min="0" max="1000000" step="1">
                </label>
                <label class="field">
                  <span>Order inside each batch</span>
                  <select id="dpe-order">
                    <option value="oldest">Oldest first</option>
                    <option value="newest">Newest first</option>
                  </select>
                </label>
              </div>
              <p id="dpe-scope-note" class="hint">Default scope: delete every deletable message authored by your account, including pinned and edited messages; undeletable call/system entries are ignored.</p>
            </details>

            <details>
              <summary>Reliability & pacing</summary>
              <div class="grid">
                <label class="field"><span>Batch scan delay (ms)</span><input id="dpe-scan-delay" type="number" min="0" max="60000"></label>
                <label class="field"><span>Base delete delay (ms)</span><input id="dpe-delete-delay" type="number" min="250" max="60000"></label>
                <label class="field"><span>Maximum adaptive delay (ms)</span><input id="dpe-max-delay" type="number" min="1000" max="600000"></label>
                <label class="field"><span>Random jitter (%)</span><input id="dpe-jitter" type="number" min="0" max="50"></label>
                <label class="field"><span>Network / 5xx retries</span><input id="dpe-retries" type="number" min="1" max="50"></label>
                <label class="field"><span>Pause after consecutive errors</span><input id="dpe-error-stop" type="number" min="1" max="100"></label>
                <label class="field"><span>Checkpoint every N deletes</span><input id="dpe-checkpoint" type="number" min="1" max="100"></label>
                <label class="field">
                  <span>Latest-message lookup</span>
                  <select id="dpe-anchor-mode">
                    <option value="search">Fast author lookup + safe fallback</option>
                    <option value="history">Direct history only</option>
                  </select>
                </label>
                <label class="field"><span>Scan, then delete every N deletable messages</span><input id="dpe-batch-size" type="number" min="100" max="10000" step="100"></label>
                <label class="field">
                  <span>Matched-message log detail</span>
                  <select id="dpe-match-log-mode">
                    <option value="full">Full message text</option>
                    <option value="preview">300-character preview</option>
                    <option value="ids">Timestamp and ID only</option>
                    <option value="none">Do not show matches</option>
                  </select>
                </label>
                <label class="field"><span>Confirm empty history pages</span><input id="dpe-empty-confirmations" type="number" min="1" max="5"></label>
                <label class="field"><span>Invalid requests / 10 min before pause</span><input id="dpe-invalid-limit" type="number" min="2" max="1000"></label>
                <label class="check"><input id="dpe-pause-nav" type="checkbox"> Pause if I navigate away</label>
                <label class="check full"><input id="dpe-auto-resume" type="checkbox"> Auto-resume an interrupted confirmed deletion after reload (10-second grace period)</label>
              </div>
              <p class="hint">HTTP 429 always obeys Discord’s Retry-After value, even if it is longer than your maximum adaptive delay.</p>
            </details>
          </form>

          <div class="summary">
            <div class="metric"><b id="dpe-scanned">0</b><span>History total</span></div>
            <div class="metric"><b id="dpe-owned">0</b><span>Deletable yours</span></div>
            <div class="metric"><b id="dpe-ignored-system">0</b><span>Ignored system</span></div>
            <div class="metric"><b id="dpe-search-jumps">0</b><span>Search jumps</span></div>
            <div class="metric"><b id="dpe-filtered">0</b><span>Pass filters</span></div>
            <div class="metric"><b id="dpe-matched">0</b><span>Queued batch</span></div>
            <div class="metric"><b id="dpe-remaining">0</b><span>Remaining</span></div>
            <div class="metric"><b id="dpe-deleted">0</b><span>Deleted</span></div>
            <div class="metric"><b id="dpe-failed">0</b><span>Failed</span></div>
            <div class="metric"><b id="dpe-rate-limits">0</b><span>Rate limits</span></div>
          </div>
          <div class="range">Current batch: <span id="dpe-batch">1</span> · newer skipped: <span id="dpe-skipped">0</span> · matched range: <span id="dpe-range">—</span> · next deletion: <span id="dpe-next-delete">—</span> · pacing: <span id="dpe-pacing">—</span></div>
          <div class="progress"><div id="dpe-progress-bar"></div></div>
          <div class="hint">Processed: <span id="dpe-progress-text">0%</span></div>
          <div class="hint">Before batch 1, the author-locked lookup finds your latest deletable message and rejects call/system entries. After the anchor, any full 100-item history page with no deletable message from you triggers a locked search jump to your next one; invalid search results fall back to direct history.</div>

          <div class="actions">
            <button id="dpe-scan" class="primary" type="button">1. Dry run / scan</button>
            <button id="dpe-delete" class="danger" type="button" disabled>2. Delete queued…</button>
            <button id="dpe-pause" type="button" disabled>Pause</button>
            <button id="dpe-resume" class="success" type="button" disabled>Resume</button>
            <button id="dpe-stop" type="button" disabled>Stop</button>
            <button id="dpe-retry-failures" type="button" disabled>Retry failures</button>
            <button id="dpe-clear" type="button" disabled>Clear checkpoint</button>
          </div>

          <details open>
            <summary>Local activity log</summary>
            <pre id="dpe-log"></pre>
            <button id="dpe-clear-log" type="button">Clear log</button>
          </details>
          <details open>
            <summary>Diagnostics for bug reports (<span id="dpe-debug-log-count">0</span>)</summary>
            <p class="hint">Records scan and deletion phases, response counts/statuses, hashed IDs, timestamps, cursors, author distributions, message types, and rate-limit headers. It never includes message text, usernames, raw IDs, credentials, or tokens and stays in memory unless you explicitly copy it.</p>
            <pre id="dpe-debug-log">Start a fresh dry scan to collect redacted diagnostics.</pre>
            <button id="dpe-copy-debug" type="button">Copy diagnostics</button>
            <button id="dpe-clear-debug" type="button">Clear diagnostics</button>
          </details>
          <details open>
            <summary>Matched messages in this batch (<span id="dpe-match-log-count">0</span>)</summary>
            <pre id="dpe-match-log">No matching messages have been found in this batch yet.</pre>
          </details>
          <p class="footer-note">
            No message content, attachments, token, cookies, or logs are transmitted anywhere except the Discord API calls required to scan and delete.
            The saved checkpoint contains only settings, target IDs, message IDs, timestamps, and counters in userscript-manager storage. Diagnostics are memory-only and leave the page only when you press Copy diagnostics.
          </p>
        </main>
      </section>
    `;
    isolatePanelEvents(shadow.getElementById('dpe-panel'));
    document.body.appendChild(rootHost);
    applyPrefsToUi(loadPrefs());
    bindUi();
    updateUi();
    log('info', 'Ready. Open the target channel/DM, review filters, then run a dry scan.');
    scheduleAutoResume();
  }

  function scheduleAutoResume() {
    const resumableOperation = (
      runState.confirmed
      && ['scanning', 'deleting', 'batching'].includes(runState.operation)
    );
    if (
      autoResumeTimer
      || runtime.mode !== 'idle'
      || !runState.config?.autoResume
      || !resumableOperation
      || !sameTarget(parseTarget(), runState.target)
    ) {
      return;
    }
    let seconds = 10;
    log('warn', `Interrupted deletion will auto-resume in ${seconds}s. Click Stop to cancel.`);
    autoResumeInterval = setInterval(() => {
      seconds -= 1;
      if (seconds > 0) log('warn', `Auto-resume in ${seconds}s…`);
      if (seconds <= 0) {
        clearInterval(autoResumeInterval);
        autoResumeInterval = null;
      }
    }, 1000);
    autoResumeTimer = setTimeout(() => {
      clearInterval(autoResumeInterval);
      autoResumeInterval = null;
      autoResumeTimer = null;
      startContinuousDeletion({ continueFromCheckpoint: true, auto: true });
    }, 10000);
    updateUi();
  }

  function ensureUiMounted() {
    if (rootHost && !rootHost.isConnected) {
      rootHost = null;
      shadow = null;
    }
    if (!rootHost && document.body) mountUi();
  }

  function watchNavigation() {
    setInterval(() => {
      ensureUiMounted();
      if (location.href === lastKnownUrl) return;
      lastKnownUrl = location.href;
      updateUi();
    }, 700);
  }

  function waitForBodyAndMount() {
    if (document.body) {
      mountUi();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      mountUi();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  waitForBodyAndMount();
  watchNavigation();
})();
