const api = globalThis.chrome ?? globalThis.browser;
const contextSelector = '[data-ls-ig-context]';
const grabbedEventName = 'localscene:instagram-grabbed';
const messageSource = 'localscene-instagram-grabber';
const pageMessageSource = 'localscene-page';
const openRequestType = 'LOCALSCENE_OPEN_INSTAGRAM_GRABBER';
const openResultType = 'LOCALSCENE_OPEN_INSTAGRAM_GRABBER_RESULT';

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'LOCALSCENE_CONTEXT_REQUEST') {
    const context = readLocalSceneContext();
    debugLog('localscene:context-request', context);
    sendResponse(context);
    return;
  }

  if (message?.type === 'LOCALSCENE_INSTAGRAM_PAYLOAD') {
    const context = message.context ?? readLocalSceneContext().context;
    if (!context || !message.payload) {
      debugLog('localscene:payload-rejected', {
        hasContext: Boolean(context),
        hasPayload: Boolean(message.payload),
      });
      sendResponse({ ok: false, error: 'No active LocalScene import field.' });
      return;
    }

    deliverPayload({ context, payload: message.payload }).then((delivery) => {
      debugLog('localscene:payload-delivered', {
        context,
        deliveryId: delivery.deliveryId,
        handled: delivery.handled,
        payload: summarizePayload(message.payload),
      });
      sendResponse({ ok: true, context, ...delivery });
    });
    return true;
  }
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (
    event.source !== window ||
    !data ||
    data.source !== pageMessageSource ||
    data.type !== openRequestType
  ) {
    return;
  }

  void handleOpenRequest(data);
});

window.addEventListener('localscene:open-instagram-grabber', (event) => {
  void handleOpenRequest(event.detail ?? {});
});

async function handleOpenRequest(data) {
  const pageContext = readLocalSceneContext();
  const context = typeof data.context === 'string' ? data.context : pageContext.context;
  const requestId =
    typeof data.requestId === 'string'
      ? data.requestId
      : crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

  if (!context) {
    postOpenResult({
      requestId,
      ok: false,
      error: 'No active LocalScene Instagram target was found.',
    });
    return;
  }

  debugLog('localscene:open-popup-request', { context, requestId });
  api.runtime.sendMessage(
    {
      type: 'LOCALSCENE_OPEN_POPUP',
      context,
      page: pageContext,
    },
    (response) => {
      const error = api.runtime.lastError;
      if (error) {
        postOpenResult({
          requestId,
          ok: false,
          error: error.message,
        });
        return;
      }
      postOpenResult({
        requestId,
        ok: Boolean(response?.ok),
        error: response?.error,
        opened: response?.opened,
      });
    },
  );
}

function postOpenResult(result) {
  debugLog('localscene:open-popup-result', result);
  window.postMessage(
    {
      source: messageSource,
      type: openResultType,
      ...result,
    },
    window.location.origin,
  );
}

async function deliverPayload(detail) {
  const delivery = {
    ...detail,
    deliveryId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  };
  const handledPromise = waitForPageAck(delivery.deliveryId);
  window.postMessage(
    {
      source: messageSource,
      type: 'LOCALSCENE_INSTAGRAM_GRABBED',
      detail: delivery,
    },
    window.location.origin,
  );
  injectPageWorldEvent(delivery);
  const handled = await handledPromise;
  return { deliveryId: delivery.deliveryId, handled };
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return { kind: 'unknown' };
  if (payload.kind === 'post') {
    return {
      kind: payload.kind,
      operation: payload.operation,
      postUrl: payload.postUrl,
      imageUrl: payload.imageUrl,
      hasImageBytes: Boolean(payload.imageBytesBase64),
      contentType: payload.contentType,
    };
  }
  return {
    kind: payload.kind,
    username: payload.username,
    hasAvatarBytes: Boolean(payload.avatarBytesBase64),
  };
}

function injectPageWorldEvent(detail) {
  const script = document.createElement('script');
  script.textContent = `
    window.dispatchEvent(new CustomEvent(${JSON.stringify(grabbedEventName)}, {
      detail: ${JSON.stringify(detail)}
    }));
  `;
  (document.documentElement || document.head || document.body).append(script);
  script.remove();
}

function waitForPageAck(deliveryId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      debugLog('localscene:payload-ack-timeout', { deliveryId });
      resolve(false);
    }, 1500);

    function handleMessage(event) {
      const data = event.data;
      if (
        event.source !== window ||
        !data ||
        data.source !== pageMessageSource ||
        data.type !== 'LOCALSCENE_INSTAGRAM_RECEIVED' ||
        data.deliveryId !== deliveryId
      ) {
        return;
      }
      cleanup();
      debugLog('localscene:payload-ack', { deliveryId });
      resolve(true);
    }

    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener('message', handleMessage);
    }

    window.addEventListener('message', handleMessage);
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

function readLocalSceneContext() {
  const active = document.activeElement?.closest?.(contextSelector);
  const candidates = Array.from(document.querySelectorAll(contextSelector));
  const node = active ?? candidates.at(-1) ?? null;
  const context = node?.getAttribute('data-ls-ig-context') ?? null;
  const targetName = targetNameForNode(node);
  const contexts = Array.from(
    new Set(
      candidates
        .map((candidate) => candidate.getAttribute('data-ls-ig-context'))
        .filter(Boolean),
    ),
  );
  return {
    ok: Boolean(context),
    context,
    contexts,
    url: window.location.href,
    title: document.title,
    targetName,
  };
}

function targetNameForNode(node) {
  const explicit =
    closestAttribute(node, 'data-ls-ig-target-name') ||
    closestAttribute(node, 'data-ls-resource-name') ||
    closestAttribute(node, 'data-resource-name');
  if (explicit) return cleanText(explicit);

  const scopedHeading =
    node
      ?.closest?.('form, dialog, section, article, main')
      ?.querySelector?.('[data-ls-resource-name], h1, h2, legend')?.textContent;
  const pageHeading = document.querySelector('main h1, h1')?.textContent;
  return cleanText(pageHeading) || cleanLocalSceneTitle(document.title) || cleanText(scopedHeading);
}

function closestAttribute(node, attribute) {
  return node?.closest?.(`[${attribute}]`)?.getAttribute(attribute) ?? '';
}

function cleanLocalSceneTitle(value) {
  return cleanText(value)
    .replace(/\s*\|\s*localscene\.fm\s*$/i, '')
    .replace(/^Create a gig$/i, 'Create gig')
    .replace(/^Individual artists & acts$/i, 'Artists and acts');
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}
