// ==UserScript==
// @name         Discord Privacy Eraser (Current Channel / DM)
// @namespace    local.codex.discord-privacy-eraser
// @version      1.0.0
// @description  Preview, filter, and delete only your own messages in the currently open Discord channel or DM.
// @author       Codex
// @match        https://discord.com/channels/*
// @match        https://*.discord.com/channels/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
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
    version: '1.0.0',
    prefsKey: 'dpe:prefs:v1',
    runKey: 'dpe:run:v1',
    apiVersions: ['9', '10'],
    maxLogLines: 180,
    maxSavedFailures: 2000,
  });

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
    logs: [],
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
    includePinned: false,
    includeEdited: true,
    minMessageAgeHours: 0,
    maxMessages: 0,
    deleteOrder: 'oldest',
    scanDelayMs: 750,
    baseDeleteDelayMs: 1100,
    maxAdaptiveDelayMs: 30000,
    jitterPercent: 15,
    maxRetries: 12,
    stopAfterErrors: 5,
    checkpointEvery: 50,
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

  function installCredentialSniffer() {
    try {
      const originalFetch = pageWindow.fetch;
      if (typeof originalFetch === 'function' && !originalFetch.__dpeWrapped) {
        const wrappedFetch = function (...args) {
          try {
            sniffHeaders(args[0]?.headers);
            sniffHeaders(args[1]?.headers);
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
      try {
        return parseJson(localStorage.getItem(key), fallback);
      } catch {
        return fallback;
      }
    }
  }

  function storageSet(key, value) {
    const serialized = JSON.stringify(value);
    try {
      GM_setValue(key, serialized);
      return true;
    } catch {
      try {
        localStorage.setItem(key, serialized);
        return true;
      } catch {
        log('warn', 'Checkpoint storage is full; the run can continue, but reload recovery is unavailable.');
        return false;
      }
    }
  }

  function storageDelete(key) {
    try {
      GM_deleteValue(key);
    } catch {
      try { localStorage.removeItem(key); } catch {}
    }
  }

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
      status: 'idle',
      operation: '',
      savedAt: 0,
      target: null,
      userId: '',
      signature: '',
      config: null,
      queue: [],
      failures: [],
      scanCursor: '',
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
    };
  }

  function loadRunState() {
    const saved = storageGet(SCRIPT.runKey, null);
    if (!saved || saved.version !== 1 || !Array.isArray(saved.queue)) return emptyRunState();
    const targetChannelId = String(saved.target?.channelId || '');
    const unpack = (item) => {
      if (!Array.isArray(item)) return item;
      return {
        id: String(item[0] || ''),
        channelId: targetChannelId,
        timestamp: String(item[1] || ''),
      };
    };
    return {
      ...emptyRunState(),
      ...saved,
      queue: saved.queue.map(unpack).filter((item) => item?.id),
      failures: Array.isArray(saved.failures)
        ? saved.failures.map(unpack).filter((item) => item?.id)
        : [],
    };
  }

  let runState = loadRunState();

  function saveRunState() {
    runState.savedAt = Date.now();
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
    const match = location.pathname.match(/^\/channels\/([^/]+)\/(\d+)/);
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

  function jitter(ms, percent) {
    if (ms <= 0 || percent <= 0) return Math.max(0, ms);
    const spread = ms * (percent / 100);
    return Math.max(0, Math.round(ms + ((Math.random() * 2 - 1) * spread)));
  }

  function log(level, message) {
    const safeMessage = String(message)
      .replace(/mfa\.[\w-]+/gi, '[redacted token]')
      .replace(/[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}/g, '[redacted token]');
    runtime.logs.push({
      at: new Date().toLocaleTimeString(),
      level,
      message: safeMessage,
    });
    if (runtime.logs.length > SCRIPT.maxLogLines) runtime.logs.shift();
    updateLog();
  }

  function wakeRuntime() {
    const waiters = runtime.wakeWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async function controlPoint() {
    if (runtime.stopped) throw new StopSignal();

    const currentTarget = parseTarget();
    if (
      runtime.mode !== 'idle'
      && runState.config?.pauseOnNavigate
      && runState.target
      && !sameTarget(currentTarget, runState.target)
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

  function learnRateLimitHeaders(response, method) {
    const remainingRaw = response.headers.get('X-RateLimit-Remaining');
    const resetAfterRaw = response.headers.get('X-RateLimit-Reset-After');
    if (resetAfterRaw === null) return;
    const remaining = remainingRaw === null ? Number.NaN : Number(remainingRaw);
    const resetAfterSeconds = Number(resetAfterRaw);
    if (!Number.isFinite(resetAfterSeconds) || resetAfterSeconds < 0) return;

    const resetMs = Math.ceil(resetAfterSeconds * 1000);
    if (remaining === 0) {
      runtime.nextAllowedAt = Math.max(runtime.nextAllowedAt, Date.now() + resetMs + 150);
    }
    if (method === 'DELETE' && Number.isFinite(remaining) && remaining > 0) {
      runtime.headerDeleteDelayMs = Math.ceil((resetMs / (remaining + 0.5)) * 1.15);
    }
  }

  async function apiRequest(path, options = {}) {
    const {
      method = 'GET',
      body = null,
      purpose = 'request',
      maxRetries = runState.config?.maxRetries ?? defaultPrefs.maxRetries,
    } = options;
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
            method,
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
        log('warn', `${purpose} hit a network error; retrying in ${formatDuration(waitMs)}.`);
        await interruptibleSleep(jitter(waitMs, 20));
        continue;
      } finally {
        runtime.requestController = null;
      }

      learnRateLimitHeaders(response, method);

      if (response.status === 429) {
        const payload = await responseJson(response);
        const minimumWait = Math.max(1000, retryAfterMs(response, payload));
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
        saveRunState();
        const scope = response.headers.get('X-RateLimit-Scope') || (payload?.global ? 'global' : 'route');
        log('rate', `Discord rate-limited the ${purpose} (${scope}); respecting Retry-After for ${formatDuration(minimumWait)}.`);
        // Retry-After is a hard minimum. Add only positive jitter so a large
        // rate-limit window can never be shortened by random pacing.
        const positiveJitter = Math.round(Math.random() * Math.min(1000, minimumWait * 0.05));
        await interruptibleSleep(minimumWait + 250 + positiveJitter);
        continue;
      }

      if (response.status >= 500 && response.status <= 599) {
        transientAttempt += 1;
        if (transientAttempt > maxRetries) return response;
        const waitMs = Math.min(30000, (2 ** Math.min(transientAttempt, 6)) * 750);
        log('warn', `Discord returned ${response.status} for ${purpose}; retrying in ${formatDuration(waitMs)}.`);
        await interruptibleSleep(jitter(waitMs, 20));
        continue;
      }

      if (response.status === 401) {
        authToken = '';
        currentUser = null;
        updateAuthStatus();
        throw new FatalApiError(
          'Discord rejected the session (401). The run was paused; refresh Discord and resume.',
          401,
        );
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

  function matchesMessage(message, config, compiledRegex, excludedTerms) {
    if (!message?.author?.id || message.author.id !== currentUser.id) return false;
    if (!config.includePinned && message.pinned) return false;
    if (!config.includeEdited && message.edited_timestamp) return false;

    const timestamp = new Date(message.timestamp).getTime();
    if (!Number.isFinite(timestamp)) return false;
    if (config.afterDate && timestamp < new Date(config.afterDate).getTime()) return false;
    if (config.beforeDate && timestamp > new Date(config.beforeDate).getTime()) return false;
    if (config.minMessageAgeHours > 0) {
      const newestAllowed = Date.now() - (config.minMessageAgeHours * 60 * 60 * 1000);
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

  function validateConfig(config) {
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

  function prepareQueue(queue, config) {
    const deduplicated = [...new Map(queue.map((item) => [item.id, item])).values()];
    deduplicated.sort(snowflakeCompare);
    if (config.deleteOrder === 'newest') deduplicated.reverse();
    return config.maxMessages > 0
      ? deduplicated.slice(0, config.maxMessages)
      : deduplicated;
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
      scanDelayMs: integer(value('dpe-scan-delay'), 750, 250, 60000),
      baseDeleteDelayMs: integer(value('dpe-delete-delay'), 1100, 250, 60000),
      maxAdaptiveDelayMs: integer(value('dpe-max-delay'), 30000, 1000, 600000),
      jitterPercent: integer(value('dpe-jitter'), 15, 0, 50),
      maxRetries: integer(value('dpe-retries'), 12, 1, 50),
      stopAfterErrors: integer(value('dpe-error-stop'), 5, 1, 100),
      checkpointEvery: integer(value('dpe-checkpoint'), 10, 1, 100),
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
    setChecked('dpe-pause-nav', prefs.pauseOnNavigate);
    setChecked('dpe-auto-resume', prefs.autoResume);
    setChecked('dpe-risk', prefs.riskAccepted);
  }

  async function startScan({ resume = false } = {}) {
    if (runtime.mode !== 'idle') return;
    const target = resume ? runState.target : parseTarget();
    if (!target) {
      log('error', 'Open the exact Discord channel or DM you want to clean first.');
      return;
    }

    const config = resume && runState.config ? runState.config : readConfigFromUi();
    try {
      validateConfig(config);
    } catch (error) {
      log('error', error.message);
      return;
    }

    runtime.mode = 'scanning';
    runtime.paused = false;
    runtime.stopped = false;
    runtime.pauseReason = '';
    runtime.startedAt = Date.now();
    updateUi();

    try {
      const user = await resolveCurrentUser({ force: true });
      const signature = configSignature(config, target, user.id);
      const canResume = resume
        && runState.operation === 'scanning'
        && runState.signature === signature
        && sameTarget(runState.target, target);

      if (resume && !canResume) {
        throw new FatalApiError(
          'The signed-in account, target, or saved scan settings changed. Start a new dry run instead of resuming this checkpoint.',
        );
      }

      if (!canResume) {
        runState = {
          ...emptyRunState(),
          status: 'scanning',
          operation: 'scanning',
          target,
          userId: user.id,
          signature,
          config,
        };
      } else {
        runState.status = 'scanning';
        log('info', `Resuming scan before message ${runState.scanCursor || 'latest'}.`);
      }

      savePrefs(config);
      saveRunState();
      const { compiledRegex, excludedTerms } = compileFilters(config);
      let before = canResume ? runState.scanCursor : '';
      let reachedDateFloor = false;

      log(
        'info',
        `Dry run started for ${formatTarget(target)}. No messages will be deleted during scanning.`,
      );

      while (!reachedDateFloor) {
        await controlPoint();
        const query = new URLSearchParams({ limit: '100' });
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
        if (!Array.isArray(messages) || messages.length === 0) break;
        runState.scannedPages += 1;
        runState.scannedMessages += messages.length;

        for (const message of messages) {
          if (matchesMessage(message, config, compiledRegex, excludedTerms)) {
            runState.queue.push({
              id: String(message.id),
              channelId: String(message.channel_id || target.channelId),
              timestamp: String(message.timestamp || ''),
            });
            runState.matchedMessages += 1;
            if (!runState.firstTimestamp) runState.firstTimestamp = String(message.timestamp || '');
            runState.lastTimestamp = String(message.timestamp || runState.lastTimestamp);
          }
        }

        const oldest = messages[messages.length - 1];
        before = String(oldest.id);
        runState.scanCursor = before;
        if (config.afterDate) {
          const oldestTimestamp = new Date(oldest.timestamp).getTime();
          if (oldestTimestamp < new Date(config.afterDate).getTime()) reachedDateFloor = true;
        }
        if (runState.scannedPages % 5 === 0) saveRunState();
        else updateUi();
        log(
          'info',
          `Scanned ${runState.scannedMessages.toLocaleString()} messages; ${runState.matchedMessages.toLocaleString()} match so far.`,
        );

        if (messages.length < 100) break;
        if (
          config.deleteOrder === 'newest'
          && config.maxMessages > 0
          && runState.queue.length >= config.maxMessages
        ) {
          break;
        }
        await interruptibleSleep(jitter(config.scanDelayMs, config.jitterPercent));
      }

      runState.queue = prepareQueue(runState.queue, config);
      runState.initialMatches = runState.queue.length;
      runState.matchedMessages = runState.queue.length;
      runState.status = 'scanned';
      runState.operation = '';
      runState.confirmed = false;
      saveRunState();
      log(
        'success',
        `Dry run complete: ${runState.queue.length.toLocaleString()} of your messages are queued. Review the summary before deleting.`,
      );
    } catch (error) {
      if (error instanceof StopSignal) {
        log('info', 'Scan stopped. Its checkpoint was preserved.');
      } else {
        runState.status = 'paused';
        runState.operation = 'scanning';
        saveRunState();
        log('error', error.message || String(error));
      }
    } finally {
      runtime.mode = 'idle';
      runtime.paused = false;
      runtime.stopped = false;
      runtime.pauseReason = '';
      abortActiveRequest();
      updateUi();
    }
  }

  async function confirmDeletion() {
    const count = runState.queue.length;
    const phrase = `DELETE ${count}`;
    const entered = pageWindow.prompt(
      [
        `This permanently deletes ${count.toLocaleString()} messages authored by your account`,
        `from ${formatTarget(runState.target)}.`,
        '',
        'Deleted messages cannot be recovered.',
        `Type exactly: ${phrase}`,
      ].join('\n'),
      '',
    );
    return entered === phrase;
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

  async function startDelete({ resume = false, auto = false } = {}) {
    if (runtime.mode !== 'idle') return;
    const target = runState.target;
    const config = runState.config;
    if (!target || !config || !runState.queue.length) {
      log('error', 'There is no non-empty dry-run queue to delete.');
      return;
    }
    if (!sameTarget(parseTarget(), target)) {
      log('error', 'Return to the exact channel/DM used for the dry run before deleting.');
      return;
    }

    try {
      validateConfig(config);
      const user = await resolveCurrentUser({ force: true });
      const expectedSignature = configSignature(config, target, user.id);
      if (runState.signature !== expectedSignature || runState.userId !== user.id) {
        throw new Error('The target, signed-in account, or filters changed. Run a new dry run.');
      }
      if (!resume && !runState.confirmed) {
        const confirmed = await confirmDeletion();
        if (!confirmed) {
          log('warn', 'Deletion cancelled: the confirmation phrase did not match.');
          return;
        }
        runState.confirmed = true;
      }
    } catch (error) {
      log('error', error.message);
      return;
    }

    runtime.mode = 'deleting';
    runtime.paused = false;
    runtime.stopped = false;
    runtime.pauseReason = '';
    runtime.startedAt = Date.now();
    runtime.adaptiveDeleteDelayMs = config.baseDeleteDelayMs;
    runtime.headerDeleteDelayMs = 0;
    runtime.successesSinceLimit = 0;
    runState.status = 'deleting';
    runState.operation = 'deleting';
    saveRunState();
    log(
      auto ? 'warn' : 'info',
      `${auto ? 'Auto-resumed' : 'Started'} permanent deletion of the locked dry-run queue.`,
    );

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
          response = await apiRequest(
            `/channels/${message.channelId}/messages/${message.id}`,
            { method: 'DELETE', purpose: 'message deletion' },
          );
        } catch (error) {
          if (error instanceof StopSignal) throw error;
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
          consecutiveErrors = 0;
          runtime.successesSinceLimit += 1;
          operationsSinceCheckpoint += 1;

          if (runtime.successesSinceLimit >= 20) {
            runtime.adaptiveDeleteDelayMs = Math.max(
              config.baseDeleteDelayMs,
              Math.round(runtime.adaptiveDeleteDelayMs * 0.9),
            );
            runtime.successesSinceLimit = 0;
          }
        } else if ([400, 403].includes(response.status)) {
          const payload = await responseJson(response);
          runState.queue.shift();
          runState.failed += 1;
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

      runState.status = 'complete';
      runState.operation = '';
      runState.confirmed = false;
      saveRunState();
      log(
        'success',
        `Finished: ${runState.deleted.toLocaleString()} deleted, ${runState.alreadyGone.toLocaleString()} already gone, ${runState.failed.toLocaleString()} failed.`,
      );
    } catch (error) {
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
      abortActiveRequest();
      updateUi();
    }
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
      if (['scanning', 'deleting', 'paused'].includes(runState.status)) {
        runState.status = 'stopped';
        saveRunState();
        log('info', 'Checkpoint marked as stopped; it remains available for manual resume.');
      }
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
    if (runState.operation === 'scanning') {
      await startScan({ resume: true });
    } else if (runState.operation === 'deleting') {
      if (!runState.confirmed) {
        log('error', 'This deletion checkpoint was never confirmed. Run a new dry run.');
        return;
      }
      await startDelete({ resume: true, auto });
    }
  }

  function retryFailures() {
    if (runtime.mode !== 'idle' || !runState.failures.length) return;
    runState.queue = prepareQueue([...runState.failures], runState.config || defaultPrefs);
    runState.failures = [];
    runState.initialMatches = runState.queue.length;
    runState.matchedMessages = runState.queue.length;
    runState.deleted = 0;
    runState.alreadyGone = 0;
    runState.failed = 0;
    runState.firstTimestamp = runState.queue.at(-1)?.timestamp || '';
    runState.lastTimestamp = runState.queue[0]?.timestamp || '';
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
    setText('dpe-scanned', runState.scannedMessages.toLocaleString());
    setText('dpe-matched', runState.initialMatches.toLocaleString());
    setText('dpe-remaining', runState.queue.length.toLocaleString());
    setText('dpe-deleted', runState.deleted.toLocaleString());
    setText('dpe-failed', runState.failed.toLocaleString());
    setText('dpe-rate-limits', runState.rateLimits.toLocaleString());
    setText(
      'dpe-range',
      runState.initialMatches
        ? `${formatDate(runState.lastTimestamp)} → ${formatDate(runState.firstTimestamp)}`
        : '—',
    );

    const total = Math.max(0, runState.initialMatches);
    const processed = Math.max(0, runState.deleted + runState.alreadyGone + runState.failed);
    const percent = total > 0 ? clamp((processed / total) * 100, 0, 100) : 0;
    const progress = shadow.getElementById('dpe-progress-bar');
    if (progress) progress.style.width = `${percent}%`;
    setText('dpe-progress-text', total ? `${percent.toFixed(1)}%` : '0%');

    const isBusy = runtime.mode !== 'idle';
    const savedOperation = Boolean(runState.operation && runState.target);
    const sameLockedTarget = sameTarget(target, runState.target);
    const prefs = readConfigFromUi();
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
    on('dpe-delete', 'click', () => startDelete());
    on('dpe-pause', 'click', pauseActive);
    on('dpe-resume', 'click', () => resumeCheckpoint());
    on('dpe-stop', 'click', stopActive);
    on('dpe-clear', 'click', clearCheckpoint);
    on('dpe-retry-failures', 'click', retryFailures);
    on('dpe-clear-log', 'click', () => {
      runtime.logs = [];
      updateLog();
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

  function mountUi() {
    if (rootHost || !document.body) return;
    rootHost = document.createElement('div');
    rootHost.id = 'dpe-root';
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
          display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin: 10px 0;
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
        #dpe-log {
          max-height: 150px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
          margin: 7px 0; padding: 8px; border-radius: 6px; background: #111214;
          color: #b5bac1; font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
        }
        .footer-note { color: #949ba4; font-size: 10px; margin-top: 9px; }
      </style>
      <button id="dpe-launcher" type="button">Privacy Eraser</button>
      <section id="dpe-panel" aria-label="Discord Privacy Eraser">
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
                <label class="check"><input id="dpe-pinned" type="checkbox"> Include pinned messages (off by default)</label>
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
                  <span>Delete order</span>
                  <select id="dpe-order">
                    <option value="oldest">Oldest first</option>
                    <option value="newest">Newest first</option>
                  </select>
                </label>
              </div>
            </details>

            <details>
              <summary>Reliability & pacing</summary>
              <div class="grid">
                <label class="field"><span>Scan delay (ms)</span><input id="dpe-scan-delay" type="number" min="250" max="60000"></label>
                <label class="field"><span>Base delete delay (ms)</span><input id="dpe-delete-delay" type="number" min="250" max="60000"></label>
                <label class="field"><span>Maximum adaptive delay (ms)</span><input id="dpe-max-delay" type="number" min="1000" max="600000"></label>
                <label class="field"><span>Random jitter (%)</span><input id="dpe-jitter" type="number" min="0" max="50"></label>
                <label class="field"><span>Network / 5xx retries</span><input id="dpe-retries" type="number" min="1" max="50"></label>
                <label class="field"><span>Pause after consecutive errors</span><input id="dpe-error-stop" type="number" min="1" max="100"></label>
                <label class="field"><span>Checkpoint every N deletes</span><input id="dpe-checkpoint" type="number" min="1" max="100"></label>
                <label class="check"><input id="dpe-pause-nav" type="checkbox"> Pause if I navigate away</label>
                <label class="check full"><input id="dpe-auto-resume" type="checkbox"> Auto-resume an interrupted confirmed deletion after reload (10-second grace period)</label>
              </div>
              <p class="hint">HTTP 429 always obeys Discord’s Retry-After value, even if it is longer than your maximum adaptive delay.</p>
            </details>
          </form>

          <div class="summary">
            <div class="metric"><b id="dpe-scanned">0</b><span>Scanned</span></div>
            <div class="metric"><b id="dpe-matched">0</b><span>Dry-run match</span></div>
            <div class="metric"><b id="dpe-remaining">0</b><span>Remaining</span></div>
            <div class="metric"><b id="dpe-deleted">0</b><span>Deleted</span></div>
            <div class="metric"><b id="dpe-failed">0</b><span>Failed</span></div>
            <div class="metric"><b id="dpe-rate-limits">0</b><span>Rate limits</span></div>
          </div>
          <div class="range">Matched range: <span id="dpe-range">—</span> · pacing: <span id="dpe-pacing">—</span></div>
          <div class="progress"><div id="dpe-progress-bar"></div></div>
          <div class="hint">Processed: <span id="dpe-progress-text">0%</span></div>

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
          <p class="footer-note">
            No message content, attachments, token, cookies, or logs are transmitted anywhere except the Discord API calls required to scan and delete.
            The saved checkpoint contains only settings, target IDs, message IDs, timestamps, and counters in userscript-manager storage.
          </p>
        </main>
      </section>
    `;
    document.body.appendChild(rootHost);
    applyPrefsToUi(loadPrefs());
    bindUi();
    updateUi();
    log('info', 'Ready. Open the target channel/DM, review filters, then run a dry scan.');
    scheduleAutoResume();
  }

  function scheduleAutoResume() {
    if (
      !runState.config?.autoResume
      || runState.status !== 'deleting'
      || runState.operation !== 'deleting'
      || !runState.confirmed
      || !runState.queue.length
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
      resumeCheckpoint({ auto: true });
    }, 10000);
    updateUi();
  }

  function watchNavigation() {
    setInterval(() => {
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
