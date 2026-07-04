const api = globalThis.chrome ?? globalThis.browser;

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'LOCALSCENE_SCRAPE_INSTAGRAM') return;

  scrapeInstagram(message.mode, message.operation)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
});

async function scrapeInstagram(mode, operation = 'stage-image') {
  debugLog('instagram:scrape-start', {
    mode,
    operation,
    href: location.href,
  });
  if (location.hostname !== 'www.instagram.com') {
    throw new Error('Open instagram.com before grabbing.');
  }
  if (isLoginOrCheckpoint()) {
    throw new Error('Instagram is asking for login or verification in this tab.');
  }
  const payload = mode === 'profile' ? await scrapeProfile() : await scrapePost(operation);
  debugLog('instagram:scrape-success', summarizePayload(payload));
  return payload;
}

async function scrapeProfile() {
  const username = profileUsernameFromPath();
  if (!username) throw new Error('Open an Instagram profile page first.');

  const snapshot = await waitForProfileSnapshot(username);
  const bio = snapshot.bioCandidate?.value ?? '';
  if (!bio) {
    debugLog('instagram:profile-bio-empty', {
      username,
      displayName: snapshot.displayName,
      elapsedMs: snapshot.elapsedMs,
      hasJsonUser: Boolean(snapshot.jsonUser),
      domLineCount: snapshot.domLineCount,
      metaDescriptionLength: cleanProfileBioFromMeta(username).length,
    });
  }
  const avatarUrl = snapshot.avatarUrl;
  const avatar = avatarUrl ? await imageToBase64(avatarUrl) : null;

  return {
    kind: 'profile',
    profileUrl: `https://www.instagram.com/${username}/`,
    username,
    displayName: snapshot.displayName,
    bio,
    description: bio,
    bioSource: snapshot.bioCandidate?.source,
    ...(avatar
      ? {
          avatarBytesBase64: avatar.base64,
          avatarContentType: avatar.contentType,
        }
      : {}),
  };
}

async function waitForProfileSnapshot(username) {
  const startedAt = Date.now();
  let latest = profileSnapshot(username, startedAt);
  while (!latest.bioCandidate?.value && Date.now() - startedAt < 9000) {
    await delay(250);
    latest = profileSnapshot(username, startedAt);
  }
  return latest;
}

function profileSnapshot(username, startedAt = Date.now()) {
  const jsonUser = findJsonProfile(username);
  const displayName =
    cleanText(jsonUser?.full_name) ||
    cleanText(document.querySelector('meta[property="og:title"]')?.content)
      ?.replace(/\s*\(@.*$/, '') ||
    username;
  const bioCandidate = bestProfileBioCandidate([
    { source: 'json', value: cleanProfileBioFromJson(jsonUser) },
    { source: 'dom', value: cleanProfileBioFromDom(username, displayName) },
    { source: 'meta', value: cleanProfileBioFromMeta(username) },
  ]);
  const avatarUrl =
    cleanText(jsonUser?.profile_pic_url_hd) ||
    cleanText(jsonUser?.profile_pic_url) ||
    cleanText(document.querySelector('meta[property="og:image"]')?.content);

  return {
    jsonUser,
    displayName,
    bioCandidate,
    avatarUrl,
    domLineCount: profileDomLineCount(),
    elapsedMs: Date.now() - startedAt,
  };
}

function profileDomLineCount() {
  const root =
    document.querySelector('main header') ||
    document.querySelector('header') ||
    document.querySelector('main');
  return root ? uniqueTextLines(root.innerText || root.textContent).length : 0;
}

async function scrapePost(operation = 'stage-image') {
  const post = postFromPath();
  if (!post) throw new Error('Open an Instagram photo post first.');

  const jsonPost = findJsonPost(post.shortcode);
  const imageIndex = imageIndexFromUrl();
  const media = mediaFromJsonPost(jsonPost, imageIndex);
  const imageCandidates = uniqueImageCandidates([
    ...mediaImageCandidates(media),
    ...mainPostImageCandidatesFromDom(post.shortcode),
    imageCandidateFromUrl(
      cleanText(document.querySelector('meta[property="og:image"]')?.content),
      'meta-og-image',
      { scoreHint: 1 },
    ),
  ]);
  const imageUrl = bestImageCandidate(imageCandidates)?.url || '';
  debugLog('instagram:image-candidates', {
    selected: summarizeImageCandidate(bestImageCandidate(imageCandidates)),
    candidates: imageCandidates
      .slice()
      .sort((a, b) => imageCandidateScore(b) - imageCandidateScore(a))
      .slice(0, 8)
      .map(summarizeImageCandidate),
  });
  const caption =
    cleanText(
      jsonPost?.edge_media_to_caption?.edges?.[0]?.node?.text ??
        jsonPost?.caption?.text,
    ) || cleanCaptionFromMeta();

  return {
    kind: 'post',
    operation,
    postUrl: normalizedPostUrl(post.kind, post.shortcode, imageIndex),
    shortcode: post.shortcode,
    imageIndex,
    caption,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

function summarizePayload(payload) {
  if (payload.kind === 'profile') {
    return {
      kind: payload.kind,
      username: payload.username,
      hasAvatarBytes: Boolean(payload.avatarBytesBase64),
      bioSource: payload.bioSource,
      bioLength: payload.bio?.length ?? 0,
      bioLines: payload.bio ? payload.bio.split(/\n+/).length : 0,
    };
  }
  return {
    kind: payload.kind,
    operation: payload.operation,
    postUrl: payload.postUrl,
    imageUrl: payload.imageUrl,
    hasImageBytes: Boolean(payload.imageBytesBase64),
    contentType: payload.contentType,
    captionLength: payload.caption?.length ?? 0,
  };
}

function mediaImageCandidates(media) {
  if (!media || typeof media !== 'object') return [];
  const dimensions = mediaDimensions(media);
  return [
    imageCandidateFromUrl(media.display_url, 'json-display-url', {
      width: dimensions.width,
      height: dimensions.height,
      scoreHint: 6,
    }),
    imageCandidateFromUrl(media.thumbnail_src, 'json-thumbnail-src', {
      width: dimensions.width,
      height: dimensions.height,
      scoreHint: 2,
    }),
    ...imageVersionCandidates(media.image_versions2?.candidates),
    ...imageVersionCandidates(media.display_resources),
  ].filter(Boolean);
}

function imageVersionCandidates(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((candidate) =>
      imageCandidateFromUrl(candidate?.url ?? candidate?.src, 'json-candidate', {
        width: Number(candidate?.width ?? candidate?.config_width) || 0,
        height: Number(candidate?.height ?? candidate?.config_height) || 0,
        scoreHint: 4,
      }),
    )
    .filter(Boolean);
}

function mediaDimensions(media) {
  const width =
    Number(media.original_width) ||
    Number(media.dimensions?.width) ||
    Number(media.display_resources?.[0]?.config_width) ||
    0;
  const height =
    Number(media.original_height) ||
    Number(media.dimensions?.height) ||
    Number(media.display_resources?.[0]?.config_height) ||
    0;
  return { width, height };
}

function mainPostImageCandidatesFromDom(shortcode) {
  const root =
    document.querySelector('main article') ||
    document.querySelector('article') ||
    document;
  return Array.from(root.querySelectorAll('img[src], img[srcset]'))
    .flatMap((image) => {
      const area = visibleImageArea(image);
      const alt = cleanText(image.getAttribute('alt')).toLowerCase();
      if (
        area < 10_000 ||
        alt.includes('profile picture') ||
        alt.includes('avatar') ||
        isLinkedToDifferentInstagramPost(image, shortcode) ||
        isInsideRecommendationSection(image)
      ) {
        return [];
      }
      return [
        ...srcsetImageCandidates(image.srcset, area),
        imageCandidateFromUrl(image.currentSrc, 'dom-current-src', {
          scoreHint: 2,
          area,
        }),
        imageCandidateFromUrl(image.src, 'dom-src', {
          scoreHint: 2,
          area,
        }),
      ];
    })
    .filter(Boolean);
}

function srcsetImageCandidates(srcset, area) {
  return cleanText(srcset)
    .split(',')
    .map((candidate) => {
      const [url, descriptor] = candidate.trim().split(/\s+/);
      const width = Number(descriptor?.replace(/w$/, '')) || 0;
      return imageCandidateFromUrl(url, 'dom-srcset', {
        width,
        scoreHint: 3,
        area,
      });
    })
    .filter(Boolean);
}

function imageCandidateFromUrl(url, source, options = {}) {
  const cleanUrl = cleanText(url);
  if (!cleanUrl || !/cdninstagram\.com|fbcdn\.net|scontent/i.test(cleanUrl)) {
    return null;
  }
  const dimensions = dimensionsFromUrl(cleanUrl);
  return {
    url: cleanUrl,
    source,
    width: Number(options.width) || dimensions.width,
    height: Number(options.height) || dimensions.height,
    area: Number(options.area) || 0,
    scoreHint: Number(options.scoreHint) || 1,
  };
}

function uniqueImageCandidates(candidates) {
  const byUrl = new Map();
  for (const candidate of candidates.filter(Boolean)) {
    const current = byUrl.get(candidate.url);
    if (!current || imageCandidateScore(candidate) > imageCandidateScore(current)) {
      byUrl.set(candidate.url, candidate);
    }
  }
  return Array.from(byUrl.values());
}

function bestImageCandidate(candidates) {
  const ranked = candidates
    .filter((candidate) => candidate?.url)
    .sort((a, b) => imageCandidateScore(b) - imageCandidateScore(a));
  return ranked[0] ?? null;
}

function imageCandidateScore(candidate) {
  if (!candidate) return 0;
  const pixelScore =
    candidate.width && candidate.height
      ? candidate.width * candidate.height
      : candidate.area || 1;
  const cropPenalty = isCroppedInstagramImageUrl(candidate.url) ? 0.08 : 1;
  const thumbnailPenalty = isInstagramThumbnailOrVideoCoverUrl(candidate.url) ? 0.15 : 1;
  return pixelScore * candidate.scoreHint * cropPenalty * thumbnailPenalty;
}

function isLinkedToDifferentInstagramPost(image, shortcode) {
  const link = image.closest('a[href]');
  if (!link) return false;
  try {
    const url = new URL(link.getAttribute('href'), location.href);
    if (url.hostname !== 'www.instagram.com') return false;
    const [kind, linkedShortcode] = url.pathname.split('/').filter(Boolean);
    if (kind !== 'p' && kind !== 'reel') return false;
    return linkedShortcode !== shortcode;
  } catch {
    return false;
  }
}

function isInsideRecommendationSection(image) {
  let node = image.parentElement;
  let depth = 0;
  while (node && node !== document.body && depth < 8) {
    if (node.matches('section, aside, [role="region"], [aria-label]')) {
      const text = cleanText(
        node.getAttribute('aria-label') || node.innerText || node.textContent,
      ).toLowerCase();
      if (
        text.includes('more posts from') ||
        text.includes('more posts by') ||
        text.includes('suggested posts')
      ) {
        return true;
      }
    }
    node = node.parentElement;
    depth += 1;
  }
  return false;
}

function isCroppedInstagramImageUrl(url) {
  return (
    /[?&]stp=[^&]*(?:\bc\d+\.\d+\.\d+\.\d+|_s\d+x\d+)/i.test(url) ||
    /(?:^|[_-])s\d+x\d+(?:[_-]|$)/i.test(url)
  );
}

function isInstagramThumbnailOrVideoCoverUrl(url) {
  return (
    /[?&]stp=[^&]*_e15(?:_|&|$)/i.test(url) ||
    /[?&]efg=[^&]*(?:clips|video|cover)/i.test(url)
  );
}

function dimensionsFromUrl(url) {
  const squareMatch = url.match(/(?:^|[_-])s(\d+)x(\d+)(?:[_-]|$)/i);
  if (squareMatch) {
    return {
      width: Number(squareMatch[1]) || 0,
      height: Number(squareMatch[2]) || 0,
    };
  }
  return { width: 0, height: 0 };
}

function summarizeImageCandidate(candidate) {
  if (!candidate) return null;
  return {
    source: candidate.source,
    width: candidate.width,
    height: candidate.height,
    area: candidate.area,
    cropped: isCroppedInstagramImageUrl(candidate.url),
    score: Math.round(imageCandidateScore(candidate)),
    url: candidate.url,
  };
}

function visibleImageArea(image) {
  const rect = image.getBoundingClientRect();
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function isLoginOrCheckpoint() {
  return /^\/accounts\/login\/?|^\/challenge\/?|^\/accounts\/onetap\//.test(
    location.pathname,
  );
}

function profileUsernameFromPath() {
  const [segment] = location.pathname.split('/').filter(Boolean);
  if (!segment || ['p', 'reel', 'reels', 'explore', 'accounts'].includes(segment)) {
    return null;
  }
  return segment;
}

function postFromPath() {
  const [kind, shortcode] = location.pathname.split('/').filter(Boolean);
  if (kind === 'p' && shortcode) return { kind, shortcode };
  return null;
}

function imageIndexFromUrl() {
  const value = Number(new URL(location.href).searchParams.get('img_index'));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizedPostUrl(kind, shortcode, imageIndex) {
  const url = new URL(`https://www.instagram.com/${kind}/${shortcode}/`);
  if (imageIndex > 1) url.searchParams.set('img_index', String(imageIndex));
  return url.toString();
}

function mediaFromJsonPost(post, imageIndex) {
  const carousel = post?.edge_sidecar_to_children?.edges?.map((edge) => edge.node);
  if (Array.isArray(carousel) && carousel.length) {
    return carousel[Math.min(imageIndex - 1, carousel.length - 1)];
  }
  const carouselMedia = post?.carousel_media;
  if (Array.isArray(carouselMedia) && carouselMedia.length) {
    return carouselMedia[Math.min(imageIndex - 1, carouselMedia.length - 1)];
  }
  return post;
}

function findJsonProfile(username) {
  return findJsonObject((object) => {
    const candidate = object.username || object.user_name;
    return (
      typeof candidate === 'string' &&
      candidate.toLowerCase() === username.toLowerCase() &&
      ('biography' in object ||
        'biography_with_entities' in object ||
        'profile_pic_url' in object ||
        'profile_pic_url_hd' in object)
    );
  });
}

function findJsonPost(shortcode) {
  return findJsonObject((object) => {
    return (
      object.shortcode === shortcode ||
      object.code === shortcode ||
      object.short_code === shortcode
    );
  });
}

function findJsonObject(predicate) {
  for (const root of instagramJsonRoots()) {
    const found = walkJson(root, predicate, new Set());
    if (found) return found;
  }
  return null;
}

function instagramJsonRoots() {
  return Array.from(document.scripts)
    .map((script) => script.textContent?.trim() ?? '')
    .filter((text) => text.startsWith('{') || text.startsWith('['))
    .map((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function walkJson(value, predicate, seen) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = walkJson(child, predicate, seen);
    if (found) return found;
  }
  return null;
}

async function imageToBase64(url) {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) {
      debugLog('instagram:image-fetch-failed', {
        url,
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }
    const blob = await response.blob();
    return {
      base64: await blobToBase64(blob),
      contentType: blob.type || response.headers.get('content-type') || 'image/jpeg',
    };
  } catch (error) {
    debugLog('instagram:image-fetch-error', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanProfileBioFromJson(user) {
  return (
    cleanText(user?.biography) ||
    cleanText(user?.bio) ||
    cleanText(user?.biography_with_entities?.raw_text) ||
    cleanText(user?.biography_with_entities?.text) ||
    ''
  );
}

function cleanProfileBioFromDom(username, displayName) {
  const root =
    document.querySelector('main header') ||
    document.querySelector('header') ||
    document.querySelector('main');
  if (!root) return '';

  const lines = uniqueTextLines(root.innerText || root.textContent);
  const displayIndex = lines.findIndex(
    (line) => line.toLowerCase() === cleanText(displayName).toLowerCase(),
  );
  const searchLines = displayIndex >= 0 ? lines.slice(displayIndex + 1) : lines;
  const bioLines = [];
  for (const line of searchLines) {
    if (isProfileBioTerminatorLine(line)) break;
    if (isProfileChromeLine(line, username, displayName)) continue;
    bioLines.push(line);
  }
  return cleanText(bioLines.join('\n'));
}

function bestProfileBioCandidate(candidates) {
  return candidates
    .map((candidate, index) => ({
      ...candidate,
      index,
      value: cleanText(candidate.value),
    }))
    .filter((candidate) => candidate.value)
    .sort((a, b) => {
      const score = profileBioScore(b.value) - profileBioScore(a.value);
      return score || a.index - b.index;
    })[0];
}

function profileBioScore(value) {
  const lines = uniqueTextLines(value);
  const mentionCount = lines.filter((line) => /(^|\s)@[\w.]+/.test(line)).length;
  const categoryBonus = lines.some((line) => /\/|artist|band|musician|dj|venue|presenter/i.test(line))
    ? 5
    : 0;
  return lines.length * 10 + mentionCount * 4 + categoryBonus + Math.min(value.length / 30, 10);
}

function cleanProfileBioFromMeta(username) {
  const description = cleanText(
    document.querySelector('meta[property="og:description"]')?.content ??
      document.querySelector('meta[name="description"]')?.content,
  );
  if (!description) return '';
  if (isGenericProfileDescription(description, username)) return '';
  const parts = description.split(' - ');
  const candidate = parts.length > 1 ? parts.slice(1).join(' - ') : '';
  return isGenericProfileDescription(candidate, username) ? '' : candidate;
}

function uniqueTextLines(value) {
  const seen = new Set();
  return cleanText(value)
    .split(/\n+/)
    .map((line) => cleanText(line.replace(/\s+/g, ' ')))
    .filter((line) => {
      if (!line || seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

function isProfileChromeLine(value, username, displayName) {
  const line = cleanText(value);
  const lower = line.toLowerCase();
  const handle = cleanText(username).toLowerCase();
  const name = cleanText(displayName).toLowerCase();
  if (!line) return true;
  if (lower === handle || lower === `@${handle}` || lower === name) return true;
  if (isGenericProfileDescription(line, username)) return true;
  if (/^\d[\d,.kmb]*\s+(posts?|followers?|following)$/i.test(line)) return true;
  if (/^(follow|following|message|contact|email|directions|more|threads)$/i.test(line)) {
    return true;
  }
  if (/^followed by\b/i.test(line)) return true;
  if (/^[\w.-]+\.[a-z]{2,}\b/i.test(line) || /^https?:\/\//i.test(line)) {
    return true;
  }
  return false;
}

function isProfileBioTerminatorLine(value) {
  const line = cleanText(value).toLowerCase();
  return (
    /^followed by\b/i.test(line) ||
    /^(posts?|reels|tagged|mentions|highlights)$/i.test(line) ||
    /^view all \d+ comments?$/i.test(line)
  );
}

function isGenericProfileDescription(value, username) {
  const text = cleanText(value).toLowerCase();
  const handle = cleanText(username).toLowerCase();
  if (!text) return true;
  return (
    text.startsWith('see instagram photos and videos from ') ||
    text.includes('instagram photos and videos from') ||
    Boolean(handle && text === `${handle} on instagram`) ||
    Boolean(handle && text === `@${handle} on instagram`)
  );
}

function cleanCaptionFromMeta() {
  const description = cleanText(
    document.querySelector('meta[property="og:description"]')?.content,
  );
  if (!description) return '';
  return description.replace(/^.*? on Instagram:\s*/, '').replace(/^"|"$/g, '');
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
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
