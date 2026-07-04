const api = globalThis.chrome ?? globalThis.browser;

const contextEl = document.querySelector('#context');
const statusEl = document.querySelector('#status');
const readyStateEl = document.querySelector('#ready-state');
const targetStateEl = document.querySelector('#target-state');
const purposeStateEl = document.querySelector('#purpose-state');
const targetDetectedBadgeEl = document.querySelector('#target-detected-badge');
const modePillEl = document.querySelector('#mode-pill');
const instructionTitleEl = document.querySelector('#instruction-title');
const instructionSummaryEl = document.querySelector('#instruction-summary');
const instructionStepsEl = document.querySelector('#instruction-steps');
const instructionTipEl = document.querySelector('#instruction-tip');
const instagramUrlLabel = document.querySelector('#instagram-url-label');
const instagramUrlInput = document.querySelector('#instagram-url');
const grabActiveButton = document.querySelector('#grab-active');
const grabActiveLabelEl = document.querySelector('#grab-active-label');
const grabCurrentButton = document.querySelector('#grab-current');
const grabSpinnerEl = document.querySelector('#grab-spinner');
const historyPanel = document.querySelector('#history-panel');
const historyListEl = document.querySelector('#history-list');
const historyEmptyEl = document.querySelector('#history-empty');
const historyClearButton = document.querySelector('#history-clear');
const extensionVersion = api.runtime.getManifest?.().version ?? 'unknown';

let localSceneTabId = null;
let localSceneContext = null;
let localSceneContexts = [];
let localSceneTitle = '';
let localSceneUrl = '';
let localSceneTargetName = '';
let activeTabUrl = '';
let activeTabInstagramKind = 'unknown';
let grabHistory = [];
let isBusy = false;

init().catch((error) => setStatus(errorMessage(error), 'error'));

grabActiveButton.addEventListener('click', () => {
  runGrab(() =>
    grabFromUrlOrBestInstagramTab(defaultOperationForContext(localSceneContext)),
  );
});

grabCurrentButton.addEventListener('click', () => {
  runGrab(() => grabFromCurrentTab(defaultOperationForContext(localSceneContext)));
});

historyClearButton.addEventListener('click', async () => {
  grabHistory = [];
  await storageSet({ grabHistory });
  renderHistory();
});

historyListEl.addEventListener('click', (event) => {
  const button =
    event.target instanceof Element ?
      event.target.closest('[data-history-url]')
    : null;
  if (!button) return;
  instagramUrlInput.value = button.getAttribute('data-history-url') ?? '';
  historyPanel.open = false;
  instagramUrlInput.focus();
});

async function init() {
  const [activeTab] = await tabsQuery({ active: true, currentWindow: true });
  activeTabUrl = activeTab?.url ?? '';
  activeTabInstagramKind = instagramInputKind(activeTabUrl);
  if (activeTab?.url && isLocalSceneUrl(activeTab.url)) {
    await captureLocalSceneContext(activeTab);
  } else {
    const stored = await storageGet([
      'localSceneTabId',
      'localSceneContext',
      'localSceneContexts',
      'localSceneTitle',
      'localSceneUrl',
      'localSceneTargetName',
      'grabHistory',
    ]);
    localSceneTabId = stored.localSceneTabId ?? null;
    localSceneContext = stored.localSceneContext ?? null;
    localSceneContexts = Array.isArray(stored.localSceneContexts)
      ? stored.localSceneContexts
      : [];
    localSceneTitle = cleanText(stored.localSceneTitle);
    localSceneUrl = cleanText(stored.localSceneUrl);
    localSceneTargetName = cleanText(stored.localSceneTargetName);
    grabHistory = normalizeHistory(stored.grabHistory);
  }

  if (!localSceneTabId || !localSceneContext) {
    const localSceneTabs = await tabsQuery({ url: localSceneUrlPatterns() });
    if (localSceneTabs[0]) await captureLocalSceneContext(localSceneTabs[0]);
  }

  if (!grabHistory.length) {
    const stored = await storageGet(['grabHistory']);
    grabHistory = normalizeHistory(stored.grabHistory);
  }

  renderContext();
  renderHistory();
}

async function captureLocalSceneContext(tab) {
  const response = await sendTabMessage(tab.id, {
    type: 'LOCALSCENE_CONTEXT_REQUEST',
  });
  if (!response?.context) {
    setStatus('Click into a LocalScene Instagram import field first.');
    return;
  }
  localSceneTabId = tab.id;
  localSceneContext = response.context;
  localSceneContexts = Array.isArray(response.contexts) ? response.contexts : [];
  localSceneTitle = cleanText(response.title);
  localSceneUrl = cleanText(response.url);
  localSceneTargetName = cleanText(response.targetName);
  await storageSet({
    localSceneTabId,
    localSceneContext,
    localSceneContexts,
    localSceneTitle,
    localSceneUrl,
    localSceneTargetName,
  });
}

async function grabFromUrlOrBestInstagramTab(operation) {
  const inputUrl = instagramUrlInput.value.trim();
  if (inputUrl) {
    await grabUrlFromBackground(inputUrl, operation);
    return;
  }

  const tabs = await tabsQuery({ url: 'https://www.instagram.com/*' });
  const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
  if (!tab?.id) throw new Error('Open an Instagram tab first.');
  await grabFromInstagramTab(tab, operation);
}

async function grabUrlFromBackground(inputUrl, operation) {
  if (!localSceneTabId || !localSceneContext) {
    throw new Error('Open LocalScene and click an Instagram import field first.');
  }

  const resolvedContext = resolveContextForInstagramInput(
    inputUrl,
    localSceneContext,
    localSceneContexts,
  );
  const resolvedOperation = defaultOperationForContext(resolvedContext);
  const mode = modeForContext(resolvedContext);
  setStatus(statusForOperation(mode, resolvedOperation));
  debugLog('popup:grab-url-background-start', {
    version: extensionVersion,
    context: resolvedContext,
    originalContext: localSceneContext,
    availableContexts: localSceneContexts,
    mode,
    operation: resolvedOperation,
    inputUrl,
  });
  const response = await runtimeSendMessage({
    type: 'LOCALSCENE_GRAB_INSTAGRAM_URL',
    url: inputUrl,
    context: resolvedContext,
    contexts: localSceneContexts,
    localSceneTabId,
    operation: resolvedOperation,
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? 'Could not scrape Instagram.');
  }
  await recordHistory({
    context: resolvedContext,
    mode,
    operation: resolvedOperation,
    sourceUrl: inputUrl,
  });
  setStatus(successStatusForOperation(mode, resolvedOperation));
  renderHistory();
}

async function openInstagramForScrape(value) {
  const normalized = instagramUrl(value);
  const tabs = await tabsQuery({ url: 'https://www.instagram.com/*' });
  const tab =
    tabs[0]?.id ?
      await tabsUpdate(tabs[0].id, { active: true, url: normalized })
    : await tabsCreate({ active: true, url: normalized });
  if (!tab?.id) throw new Error('Could not open Instagram tab.');
  setStatus('Opening Instagram photo post...');
  await waitForTabComplete(tab.id);
  return tab;
}

async function grabFromCurrentTab(operation) {
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !isInstagramUrl(tab.url)) {
    throw new Error('The active tab is not Instagram.');
  }
  const kind = instagramInputKind(tab.url);
  if (kind !== 'post' && kind !== 'profile') {
    throw new Error('Open an Instagram photo post or profile tab first.');
  }
  await grabFromInstagramTab(tab, operation);
}

async function grabFromInstagramTab(tab, operation) {
  if (!localSceneTabId || !localSceneContext) {
    throw new Error('Open LocalScene and click an Instagram import field first.');
  }

  const resolvedContext = resolveContextForInstagramInput(
    tab.url ?? '',
    localSceneContext,
    localSceneContexts,
  );
  const kind = instagramInputKind(tab.url ?? '');
  const resolvedMode = modeForContext(resolvedContext);
  if (
    (kind === 'profile' && resolvedMode !== 'profile') ||
    (kind === 'post' && resolvedMode !== 'post')
  ) {
    throw new Error('The active Instagram tab does not match this LocalScene target.');
  }
  const resolvedOperation =
    resolvedContext === localSceneContext && operation
      ? operation
      : defaultOperationForContext(resolvedContext);
  const mode = resolvedMode;
  setStatus(statusForOperation(mode, resolvedOperation));
  debugLog('popup:grab-start', {
    version: extensionVersion,
    context: resolvedContext,
    originalContext: localSceneContext,
    availableContexts: localSceneContexts,
    mode,
    operation: resolvedOperation,
    instagramTabUrl: tab.url,
  });
  const response = await sendTabMessage(tab.id, {
    type: 'LOCALSCENE_SCRAPE_INSTAGRAM',
    mode,
    operation: resolvedOperation,
  });
  if (!response?.ok) throw new Error(response?.error ?? 'Could not scrape Instagram.');
  const payload = await hydratePayload(response.payload, mode, resolvedOperation);

  const delivered = await sendTabMessage(localSceneTabId, {
    type: 'LOCALSCENE_INSTAGRAM_PAYLOAD',
    context: resolvedContext,
    payload,
  });
  if (!delivered?.ok) {
    throw new Error(delivered?.error ?? 'Could not send data to LocalScene.');
  }
  if (delivered.handled === false) {
    throw new Error(
      'LocalScene did not confirm the import. Click the Show flyer target on /submit and try again.',
    );
  }

  await tabsUpdate(localSceneTabId, { active: true });
  await recordHistory({
    context: resolvedContext,
    mode,
    operation: resolvedOperation,
    sourceUrl: tab.url ?? '',
  });
  setStatus(successStatusForOperation(mode, resolvedOperation));
  renderHistory();
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

  setStatus('Downloading Instagram image bytes...');
  const response = await runtimeSendMessage({
    type: 'LOCALSCENE_DOWNLOAD_IMAGE',
    url: payload.imageUrl,
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? 'Could not download Instagram image.');
  }
  return {
    ...payload,
    imageBytesBase64: response.image.base64,
    contentType: response.image.contentType,
  };
}

function renderContext() {
  const instructions = instructionsForContext(localSceneContext);
  const state = grabberStateForContext(localSceneContext);
  renderInstructions(instructions);
  readyStateEl.textContent = state.readyLabel;
  targetStateEl.textContent = state.targetLabel;
  purposeStateEl.textContent = state.purposeLabel;
  purposeStateEl.hidden = !state.purposeLabel;
  document.body.classList.toggle('is-unknown', !localSceneContext);
  setTargetDetected(Boolean(localSceneContext));

  if (!localSceneContext) {
    contextEl.textContent = 'No LocalScene import field selected.';
    instagramUrlInput.disabled = true;
    grabActiveButton.disabled = true;
    grabCurrentButton.disabled = true;
    grabCurrentButton.hidden = true;
    return;
  }

  const canScrapeCurrentTab = canScrapeActiveInstagramTab();
  contextEl.textContent = targetLabelForContext(
    localSceneContext,
    localSceneTitle,
    localSceneTargetName,
  );
  instagramUrlInput.disabled = isBusy;
  grabActiveButton.disabled = isBusy;
  grabCurrentButton.disabled = isBusy || !canScrapeCurrentTab;
  grabCurrentButton.hidden = !canScrapeCurrentTab;
  setGrabActiveLabel(instructions.grabActiveLabel);
  grabCurrentButton.textContent = currentTabButtonLabel(instructions);
  instagramUrlLabel.textContent = instructions.inputLabel;
  instagramUrlInput.placeholder = instructions.placeholder;
}

function canScrapeActiveInstagramTab() {
  if (activeTabInstagramKind !== 'post' && activeTabInstagramKind !== 'profile') {
    return false;
  }
  const resolvedContext = resolveContextForInstagramInput(
    activeTabUrl,
    localSceneContext,
    localSceneContexts,
  );
  const resolvedMode = modeForContext(resolvedContext);
  return (
    (activeTabInstagramKind === 'profile' && resolvedMode === 'profile') ||
    (activeTabInstagramKind === 'post' && resolvedMode === 'post')
  );
}

function currentTabButtonLabel(instructions) {
  if (activeTabInstagramKind === 'profile') return 'Grab current profile tab';
  if (activeTabInstagramKind === 'post') return 'Scrape current post tab';
  return instructions.grabCurrentLabel;
}

async function runGrab(task) {
  if (isBusy) return;
  setBusy(true);
  try {
    await task();
  } catch (error) {
    const message = errorMessage(error);
    debugLog('popup:grab-error', { message });
    setStatus(message, 'error');
  } finally {
    setBusy(false);
    renderContext();
  }
}

function setBusy(value) {
  isBusy = value;
  grabSpinnerEl.hidden = !value;
  document.body.classList.toggle('is-busy', value);
  grabActiveButton.setAttribute('aria-busy', String(value));
  if (value) {
    instagramUrlInput.disabled = true;
    grabActiveButton.disabled = true;
    grabCurrentButton.disabled = true;
  }
}

function setGrabActiveLabel(label) {
  grabActiveLabelEl.textContent = label;
}

function setTargetDetected(isOk) {
  targetDetectedBadgeEl.textContent = isOk ? 'OK' : 'NG';
  targetDetectedBadgeEl.classList.toggle('is-ok', isOk);
  targetDetectedBadgeEl.classList.toggle('is-ng', !isOk);
}

function grabberStateForContext(context) {
  if (!context) {
    return {
      readyLabel: 'Unknown',
      targetLabel: 'No target selected',
      purposeLabel: 'Click a LocalScene Instagram field',
    };
  }

  const mode = modeForContext(context);
  const operation = defaultOperationForContext(context);
  const destination = destinationForContext(context);

  return {
    readyLabel:
      mode === 'profile' ? 'Profile'
      : operation === 'embed-link' ? 'Post link'
      : 'Post image',
    targetLabel: destination.label,
    purposeLabel: destination.detail,
  };
}

function destinationForContext(context) {
  const kind = targetKindForContext(context);
  const action = actionForContext(context);
  const pageName = meaningfulPageName(kind);
  return {
    label: `${kind} ${action}`,
    detail: pageName,
  };
}

function actionForContext(context) {
  const actions = {
    'gig-flyer-post': 'flyer',
    'gig-photo-post': 'gallery photo',
    'resource-gallery-post': 'gallery photo',
    'resource-photo-post': 'profile photo',
    'resource-profile': 'profile details',
    'resource-featured-post': 'featured post',
  };
  return actions[context] ?? labelForContext(context);
}

function purposeForContext(context) {
  return destinationForContext(context).label;
}

function meaningfulPageName(kind) {
  const name = cleanText(localSceneTargetName) || cleanLocalSceneTitle(localSceneTitle);
  if (!name) return '';
  if (/^create\s+(a\s+)?gig$/i.test(name)) return '';
  if (/^create\s+/i.test(name)) return '';
  if (name.toLowerCase() === kind.toLowerCase()) return '';
  return name;
}

function targetKindForContext(context) {
  if (context?.startsWith('gig-')) return 'Gig';
  const path = urlPath(localSceneUrl);
  if (/\/venues?\//i.test(path)) return 'Venue';
  if (/\/presenters?\//i.test(path)) return 'Presenter';
  if (/\/artists?\//i.test(path)) return 'Individual artist';
  if (/\/bands?\//i.test(path) || /\/acts?\//i.test(path)) return 'Act';
  return 'Resource';
}

function urlPath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return '';
  }
}

function modeForContext(context) {
  return context === 'resource-profile' ? 'profile' : 'post';
}

function renderInstructions(instructions) {
  modePillEl.textContent = instructions.modeLabel;
  instructionTitleEl.textContent = instructions.title;
  instructionSummaryEl.textContent = instructions.summary;
  instructionStepsEl.replaceChildren(
    ...instructions.steps.map((step) => {
      const item = document.createElement('li');
      item.textContent = step;
      return item;
    }),
  );
  instructionTipEl.textContent = instructions.tip;
  setGrabActiveLabel(instructions.grabActiveLabel);
  grabCurrentButton.textContent = instructions.grabCurrentLabel;
  instagramUrlLabel.textContent = instructions.inputLabel;
  instagramUrlInput.placeholder = instructions.placeholder;
}

function instructionsForContext(context) {
  const defaults = {
    modeLabel: 'No target',
    title: 'Choose a LocalScene import field',
    summary:
      'The extension sends Instagram data into the LocalScene field or modal that is currently active.',
    steps: [
      'Open the LocalScene gig, resource, or photo form you want to fill.',
      'Click into the Instagram import field or open the Instagram import modal.',
      'Open this extension again; it will show the exact thing it is ready to grab.',
    ],
    tip:
      'If this keeps appearing, click directly inside the LocalScene Instagram input or modal before opening the extension.',
    grabActiveLabel: 'Scrape image to LocalScene',
    grabCurrentLabel: 'Grab this tab',
    inputLabel: 'Instagram photo post or profile URL',
    placeholder: 'https://www.instagram.com/p/...',
  };

  if (!context) return defaults;

  const mode = modeForContext(context);
  const sharedPost = {
    modeLabel: 'Post image',
    grabActiveLabel: 'Scrape image to LocalScene',
    grabCurrentLabel: 'Scrape current tab',
    inputLabel: 'Instagram photo post URL',
    placeholder: 'https://www.instagram.com/p/...',
  };
  const sharedPhotoTip =
    'For carousel photo posts, open the exact slide you want before grabbing. Instagram URLs with img_index are preserved.';

  const instructions = {
    'gig-flyer-post': {
      ...sharedPost,
      title: 'Add a show flyer',
      summary:
        'This scrapes the main Instagram image in your browser, downloads the CDN image bytes, and stages the result as a LocalScene draft photo.',
      steps: [
        'Paste a public Instagram photo post URL here, or open the flyer post in Instagram.',
        'Confirm the Instagram tab shows the flyer you want for this gig.',
        'Click Scrape image to LocalScene. The extension will find the main image, return its CDN URL, download it, and stage it on the gig form.',
      ],
      tip:
        'The embed URL is separate. Paste a post URL into the Show flyer field on LocalScene when you also want the official Instagram embed.',
    },
    'gig-photo-post': {
      ...sharedPost,
      title: 'Import a gig photo',
      summary:
        'This will copy the selected Instagram photo post image into the open gig photo upload modal.',
      steps: [
        'Open the Instagram photo post that contains the image you want.',
        'If it is a carousel, move to the exact image slide first.',
        'Click Grab post from Instagram. LocalScene will add the image draft to the photo modal.',
      ],
      tip: sharedPhotoTip,
    },
    'resource-gallery-post': {
      ...sharedPost,
      title: 'Import a gallery photo',
      summary:
        'This will copy the selected Instagram photo post image into the open artist, band, venue, or presenter gallery modal.',
      steps: [
        'Open the Instagram photo post that contains the gallery image.',
        'If it is a carousel, move to the exact image slide first.',
        'Click Grab post from Instagram. LocalScene will add the image draft to the gallery modal.',
      ],
      tip: sharedPhotoTip,
    },
    'resource-photo-post': {
      ...sharedPost,
      title: 'Import a profile photo',
      summary:
        'This will copy the selected Instagram photo post image into the resource profile photo field.',
      steps: [
        'Open an Instagram photo post with the best square-ish profile image.',
        'If it is a carousel, move to the exact image slide first.',
        'Click Grab post from Instagram. LocalScene will stage it as the profile photo.',
      ],
      tip:
        'This target only stages a photo from an Instagram photo post. To fill name, handle, bio, and avatar, paste an Instagram profile URL while the resource form is open.',
    },
    'resource-profile': {
      modeLabel: 'Profile',
      title: 'Import profile details',
      summary:
        'This will copy the Instagram username, display name, bio, and avatar into the active resource form.',
      steps: [
        'Paste an Instagram @handle or profile URL here, or open the profile in Instagram.',
        'Make sure you are logged in if Instagram asks for it.',
        'Click Grab profile from Instagram. LocalScene will fill name, handle, bio, and profile photo when Instagram exposes them.',
      ],
      tip:
        'Private profiles, login checkpoints, and blocked pages cannot be imported by the extension.',
      grabActiveLabel: 'Grab profile from Instagram',
      grabCurrentLabel: 'Grab this Instagram profile',
      inputLabel: 'Instagram profile URL or @handle',
      placeholder: '@handle or https://www.instagram.com/handle/',
    },
    'resource-featured-post': {
      ...sharedPost,
      modeLabel: 'Post link',
      title: 'Feature an Instagram photo post',
      summary:
        'This will send a photo post URL into the featured Instagram posts manager for this resource page.',
      steps: [
        'Open the Instagram photo post you want to feature publicly.',
        'Confirm it is the right post for this resource page.',
        'Click Grab post from Instagram. LocalScene will add it to the featured post list.',
      ],
      tip:
        'Featured photo posts use the Instagram embed. They do not upload or store a copy of the image.',
      grabActiveLabel: 'Fill featured embed',
    },
  };

  return instructions[context] ?? {
    ...defaults,
    modeLabel: mode === 'profile' ? 'Profile' : 'Photo post',
    title: labelForContext(context),
    summary: 'This LocalScene context is ready for an Instagram grab.',
  };
}

function defaultOperationForContext(context) {
  if (context === 'resource-profile') return undefined;
  if (context === 'resource-featured-post') return 'embed-link';
  return 'stage-image';
}

function statusForOperation(mode, operation) {
  if (mode === 'profile') return 'Grabbing profile...';
  if (operation === 'embed-link') return 'Sending embed link...';
  return 'Scraping image and downloading bytes...';
}

function successStatusForOperation(mode, operation) {
  if (mode === 'profile') return 'Profile sent to LocalScene.';
  if (operation === 'embed-link') return 'Embed link sent to LocalScene.';
  return 'LocalScene received the scraped image.';
}

async function recordHistory({ context, mode, operation, sourceUrl }) {
  const item = {
    id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    at: new Date().toISOString(),
    context,
    mode,
    operation,
    sourceUrl: cleanText(sourceUrl),
    target: grabberStateForContext(context).targetLabel,
    purpose: purposeForContext(context),
  };
  grabHistory = [
    item,
    ...grabHistory.filter(
      (historyItem) =>
        historyItem.sourceUrl !== item.sourceUrl ||
        historyItem.context !== item.context,
    ),
  ].slice(0, 10);
  await storageSet({ grabHistory });
}

function renderHistory() {
  historyClearButton.disabled = grabHistory.length === 0;
  historyEmptyEl.hidden = grabHistory.length > 0;
  historyListEl.replaceChildren(
    ...grabHistory.map((item) => {
      const listItem = document.createElement('li');
      listItem.className = 'history-item';

      const title = document.createElement('span');
      title.className = 'history-title';
      title.textContent = `${item.purpose || labelForContext(item.context)} -> ${
        item.target || 'LocalScene'
      }`;

      const meta = document.createElement('span');
      meta.className = 'history-meta';
      meta.textContent = `${formatHistoryTime(item.at)} - ${item.sourceUrl}`;

      const button = document.createElement('button');
      button.className = 'history-use';
      button.type = 'button';
      button.textContent = 'Use again';
      button.setAttribute('data-history-url', item.sourceUrl);
      button.disabled = !item.sourceUrl;

      listItem.append(title, meta, button);
      return listItem;
    }),
  );
}

function normalizeHistory(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          id: cleanText(item.id) || `${Date.now()}-${Math.random()}`,
          at: cleanText(item.at),
          context: cleanText(item.context),
          mode: cleanText(item.mode),
          operation: cleanText(item.operation),
          sourceUrl: cleanText(item.sourceUrl),
          target: cleanText(item.target),
          purpose: cleanText(item.purpose),
        }))
        .slice(0, 10)
    : [];
}

function formatHistoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function labelForContext(context) {
  const labels = {
    'gig-flyer-post': 'Gig show flyer',
    'gig-photo-post': 'Gig photo import',
    'resource-gallery-post': 'Resource gallery photo',
    'resource-photo-post': 'Resource photo import',
    'resource-profile': 'Resource profile import',
    'resource-featured-post': 'Resource featured post',
  };
  return labels[context] ?? context;
}

function targetLabelForContext(context, title, targetName) {
  const labels = {
    'gig-flyer-post': 'Target: gig flyer photo on LocalScene',
    'gig-photo-post': 'Target: open gig photo uploader',
    'resource-gallery-post': 'Target: open resource gallery uploader',
    'resource-photo-post': 'Target: resource profile photo field',
    'resource-profile': 'Target: resource profile fields and avatar',
    'resource-featured-post': 'Target: resource featured Instagram embeds',
  };
  const target = labels[context] ?? `Target: ${context}`;
  const pageTitle = cleanText(targetName) || cleanLocalSceneTitle(title);
  return pageTitle ? `${target} (${pageTitle})` : target;
}

function cleanLocalSceneTitle(value) {
  return cleanText(value)
    .replace(/\s*\|\s*localscene\.fm\s*$/i, '')
    .replace(/^Create a gig$/i, 'Create gig')
    .replace(/^Individual artists & acts$/i, 'Artists and acts');
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
  const input = typeof value === 'string' ? value.trim() : '';
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

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isLocalSceneUrl(url) {
  return (
    /^https:\/\/localscene\.fm\//.test(url) ||
    /^https:\/\/local\.localscene\.fm\//.test(url) ||
    /^http:\/\/(localhost|127\.0\.0\.1):/.test(url)
  );
}

function isInstagramUrl(url) {
  return /^https:\/\/www\.instagram\.com\//.test(url);
}

function localSceneUrlPatterns() {
  return [
    'https://localscene.fm/*',
    'https://local.localscene.fm/*',
    'http://localhost:*/*',
    'http://127.0.0.1:*/*',
  ];
}

function setStatus(message, tone = 'info') {
  const text = cleanText(message);
  statusEl.textContent = text;
  statusEl.hidden = !text;
  statusEl.classList.toggle('status-error', tone === 'error');
  api.storage.local.set({ lastStatus: text });
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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

function sendTabMessage(tabId, message) {
  return promisify((done) => api.tabs.sendMessage(tabId, message, done));
}

function runtimeSendMessage(message) {
  return promisify((done) => api.runtime.sendMessage(message, done));
}

function storageGet(keys) {
  return promisify((done) => api.storage.local.get(keys, done));
}

function storageSet(values) {
  return promisify((done) => api.storage.local.set(values, done));
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
