const api = globalThis.chrome ?? globalThis.browser;

api.runtime.onInstalled.addListener(() => {
  api.storage.local.set({
    lastStatus: 'Open a LocalScene form, then click the extension.',
  });
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'LOCALSCENE_DOWNLOAD_IMAGE') {
    downloadImage(message.url)
      .then((image) => sendResponse({ ok: true, image }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === 'LOCALSCENE_OPEN_POPUP') {
    openLocalScenePopup(sender, message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === 'LOCALSCENE_GRAB_INSTAGRAM_URL') {
    grabInstagramUrl(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }
});

async function openLocalScenePopup(sender, message) {
  const context = typeof message.context === 'string' ? message.context : null;
  const tabId = sender?.tab?.id;
  const tabUrl = sender?.tab?.url;

  if (tabId && context) {
    await storageSet({
      localSceneTabId: tabId,
      localSceneContext: context,
      localSceneContexts: Array.isArray(message.page?.contexts)
        ? message.page.contexts
        : [context],
      localSceneTitle:
        typeof message.page?.title === 'string' ? message.page.title : '',
      localSceneUrl:
        typeof message.page?.url === 'string' ? message.page.url : '',
      localSceneTargetName:
        typeof message.page?.targetName === 'string' ? message.page.targetName : '',
      lastStatus: 'Opened from a LocalScene page.',
    });
  }

  debugLog('background:open-request', { context, tabId, tabUrl });

  const popupOpener = api.action?.openPopup ?? api.browserAction?.openPopup;
  if (popupOpener) {
    try {
      await popupOpener.call(api.action ?? api.browserAction);
      debugLog('background:popup-opened', { context, tabId });
      return { opened: 'popup' };
    } catch (error) {
      debugLog('background:popup-open-failed', {
        context,
        tabId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await createExtensionTab('popup.html');
  debugLog('background:popup-tab-opened', { context, tabId });
  return { opened: 'tab' };
}

async function grabInstagramUrl(message, sender) {
  const requestedContext =
    typeof message.context === 'string' ? message.context : null;
  const localSceneTabId = Number.isInteger(message.localSceneTabId)
    ? message.localSceneTabId
    : null;
  const inputUrl = typeof message.url === 'string' ? message.url.trim() : '';
  const contexts = Array.isArray(message.contexts) ? message.contexts : [];
  const context = resolveContextForInstagramInput(
    inputUrl,
    requestedContext,
    contexts,
  );
  const requestedOperation =
    typeof message.operation === 'string' ? message.operation : null;
  const operation =
    context === requestedContext && requestedOperation
      ? requestedOperation
      : defaultOperationForContext(context);

  if (!context || !localSceneTabId) {
    throw new Error('Open LocalScene and choose an Instagram target first.');
  }
  if (!inputUrl) {
    throw new Error('Paste an Instagram photo post or profile URL first.');
  }

  const normalized = instagramUrl(inputUrl);
  const mode = modeForContext(context);
  debugLog('background:grab-url-start', {
    context,
    requestedContext,
    availableContexts: contexts,
    mode,
    operation,
    localSceneTabId,
    helperTabId: sender?.tab?.id,
    instagramUrl: normalized,
  });

  await storageSet({
    localSceneTabId,
    localSceneContext: context,
    lastStatus: 'Opening Instagram...',
  });

  const instagramTab = await openInstagramForScrape(normalized);
  await waitForTabComplete(instagramTab.id);
  const scrapeResponse = await sendTabMessageWithRetry(instagramTab.id, {
    type: 'LOCALSCENE_SCRAPE_INSTAGRAM',
    mode,
    operation,
  });
  if (!scrapeResponse?.ok) {
    throw new Error(scrapeResponse?.error ?? 'Could not scrape Instagram.');
  }

  const payload = await hydratePayload(scrapeResponse.payload, mode, operation);
  const delivered = await sendTabMessageWithRetry(localSceneTabId, {
    type: 'LOCALSCENE_INSTAGRAM_PAYLOAD',
    context,
    payload,
  });
  if (!delivered?.ok) {
    throw new Error(delivered?.error ?? 'Could not send data to LocalScene.');
  }
  if (delivered.handled === false) {
    throw new Error(
      'LocalScene did not confirm the import. Click the LocalScene target and try again.',
    );
  }

  await focusTab(localSceneTabId);
  await storageSet({ lastStatus: successStatusForOperation(mode, operation) });
  debugLog('background:grab-url-success', {
    context,
    mode,
    operation,
    localSceneTabId,
    instagramTabId: instagramTab.id,
    payload: summarizePayload(payload),
    delivered,
  });
  return { context, ...delivered };
}

async function openInstagramForScrape(value) {
  const tabs = await tabsQuery({ url: 'https://www.instagram.com/*' });
  const tab =
    tabs[0]?.id ?
      await tabsUpdate(tabs[0].id, { active: true, url: value })
    : await tabsCreate({ active: true, url: value });
  if (!tab?.id) throw new Error('Could not open Instagram tab.');
  return tab;
}

async function hydratePayload(payload, mode, operation) {
  if (
    mode !== 'post' ||
    operation === 'embed-link' ||
    payload?.kind !== 'post' ||
    payload.imageBytesBase64 ||
    !payload.imageUrl
  ) {
    return payload;
  }

  const image = await downloadImage(payload.imageUrl);
  return {
    ...payload,
    imageBytesBase64: image.base64,
    contentType: image.contentType,
  };
}

async function downloadImage(url) {
  if (!isAllowedImageUrl(url)) {
    throw new Error('Instagram image URL was not on an allowed CDN host.');
  }

  debugLog('background:image-download-start', { url });
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) {
    debugLog('background:image-download-failed', {
      url,
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error(`Instagram image download returned ${response.status}.`);
  }

  const blob = await response.blob();
  const image = {
    base64: await blobToBase64(blob),
    contentType:
      blob.type || response.headers.get('content-type') || 'image/jpeg',
  };
  debugLog('background:image-download-success', {
    url,
    contentType: image.contentType,
    byteSize: Math.floor((image.base64.length * 3) / 4),
  });
  return image;
}

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (/\.cdninstagram\.com$/i.test(url.hostname) ||
        /\.fbcdn\.net$/i.test(url.hostname))
    );
  } catch {
    return false;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function modeForContext(context) {
  return context === 'resource-profile' ? 'profile' : 'post';
}

function defaultOperationForContext(context) {
  if (context === 'resource-profile') return undefined;
  if (context === 'resource-featured-post') return 'embed-link';
  return 'stage-image';
}

function successStatusForOperation(mode, operation) {
  if (mode === 'profile') return 'Profile sent to LocalScene.';
  if (operation === 'embed-link') return 'Embed link sent to LocalScene.';
  return 'LocalScene received the scraped image.';
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return { kind: 'unknown' };
  if (payload.kind === 'profile') {
    const description = cleanText(payload.description || payload.bio);
    return {
      kind: payload.kind,
      username: payload.username,
      displayName: payload.displayName,
      bioSource: payload.bioSource,
      descriptionLength: description.length,
      descriptionLines: description ? description.split(/\n+/).length : 0,
      hasAvatarBytes: Boolean(payload.avatarBytesBase64),
    };
  }
  return {
    kind: payload.kind,
    operation: payload.operation,
    postUrl: payload.postUrl,
    imageUrl: payload.imageUrl,
    hasImageBytes: Boolean(payload.imageBytesBase64),
    contentType: payload.contentType,
  };
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function instagramUrl(value) {
  if (!value) return 'https://www.instagram.com/';
  if (/^https:\/\/www\.instagram\.com\//.test(value)) return value;
  if (/^https?:\/\/instagram\.com\//.test(value)) {
    return value.replace(/^https?:\/\/instagram\.com\//, 'https://www.instagram.com/');
  }
  if (/^https?:\/\//.test(value)) throw new Error('Use an instagram.com URL.');
  return `https://www.instagram.com/${value.replace(/^@/, '')}`;
}

function resolveContextForInstagramInput(input, currentContext, availableContexts) {
  const kind = instagramInputKind(input);
  const contexts = Array.isArray(availableContexts) ? availableContexts : [];
  if (kind === 'profile' && contexts.includes('resource-profile')) {
    return 'resource-profile';
  }
  if (
    kind === 'post' &&
    currentContext === 'resource-profile' &&
    contexts.includes('resource-photo-post')
  ) {
    return 'resource-photo-post';
  }
  return currentContext;
}

function instagramInputKind(value) {
  const input = value.trim();
  if (!input) return 'unknown';
  if (!/^https?:\/\//.test(input)) {
    return input.replace(/^@/, '').includes('/') ? 'unknown' : 'profile';
  }
  try {
    const url = new URL(input);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return 'unknown';
    const [first] = url.pathname.split('/').filter(Boolean);
    if (first === 'p') return 'post';
    if (first && !['accounts', 'explore', 'reel', 'reels'].includes(first)) {
      return 'profile';
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    api.storage.local.set(values, () => {
      const error = api.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  return promisify((done) => api.tabs.query(queryInfo, done));
}

function tabsCreate(createProperties) {
  return promisify((done) => api.tabs.create(createProperties, done));
}

function tabsUpdate(tabId, updateProperties) {
  return promisify((done) => api.tabs.update(tabId, updateProperties, done));
}

function tabsGet(tabId) {
  return promisify((done) => api.tabs.get(tabId, done));
}

function windowsUpdate(windowId, updateInfo) {
  return promisify((done) => api.windows.update(windowId, updateInfo, done));
}

async function focusTab(tabId) {
  const tab = await tabsGet(tabId).catch(() => null);
  if (tab?.windowId !== undefined) {
    await windowsUpdate(tab.windowId, { focused: true }).catch(() => null);
  }
  await tabsUpdate(tabId, { active: true });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 10000);

    function handleUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      cleanup();
      resolve();
    }

    function cleanup() {
      clearTimeout(timeout);
      api.tabs.onUpdated.removeListener(handleUpdated);
    }

    api.tabs.onUpdated.addListener(handleUpdated);
  });
}

async function sendTabMessageWithRetry(tabId, message) {
  let lastError = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      return await sendTabMessage(tabId, message);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError ?? new Error('Could not reach the target tab.');
}

function sendTabMessage(tabId, message) {
  return promisify((done) => api.tabs.sendMessage(tabId, message, done));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promisify(fn) {
  return new Promise((resolve, reject) => {
    fn((result) => {
      const error = api.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function createExtensionTab(path) {
  return new Promise((resolve, reject) => {
    api.tabs.create({ url: api.runtime.getURL(path), active: true }, (tab) => {
      const error = api.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function debugLog(stage, data = {}) {
  const entry = {
    at: new Date().toISOString(),
    stage,
    data,
  };
  console.info('[LocalScene Instagram Grabber]', stage, data);
  api.storage?.local?.get({ debugLogs: [] }, (result) => {
    const logs = Array.isArray(result.debugLogs) ? result.debugLogs : [];
    api.storage.local.set({ debugLogs: [...logs.slice(-49), entry] });
  });
}
