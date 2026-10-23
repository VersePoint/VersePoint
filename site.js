(() => {
  'use strict';

  const releaseTag = 'v1.1.0';
  const releasePage = `https://github.com/VersePoint/VersePoint/releases/tag/${releaseTag}`;
  const releaseAPI = `https://api.github.com/repos/VersePoint/VersePoint/releases/tags/${releaseTag}`;
  const knownScenes = new Set(['scripture-1', 'lyrics-1', 'program', 'motion-dots', 'style-presets']);

  function officialURL(value, pathname) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'github.com' &&
        !url.port && !url.username && !url.password && !url.search && !url.hash &&
        url.pathname === pathname ? url.href : null;
    } catch {
      return null;
    }
  }

  function classifyAsset(asset, version) {
    if (!asset || typeof asset.name !== 'string' || asset.state !== 'uploaded') return null;
    const versionPattern = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = asset.name;
    let match;
    let platform;
    let architecture;
    let format;
    let portable = false;

    if ((match = name.match(new RegExp(`^VersePoint-Setup-Windows-${versionPattern}(?:-(x64|arm64))?\\.(zip|exe)$`, 'i')))) {
      platform = 'windows';
      architecture = match[1]?.toLowerCase() || null;
      format = match[2].toLowerCase();
    } else if ((match = name.match(new RegExp(`^VersePoint-(Setup|Portable)-${versionPattern}-(x64|arm64)\\.exe$`, 'i')))) {
      platform = 'windows';
      portable = match[1].toLowerCase() === 'portable';
      architecture = match[2].toLowerCase();
      format = 'exe';
    } else if ((match = name.match(new RegExp(`^VersePoint-${versionPattern}-win-(x64|arm64)\\.(exe|zip)$`, 'i')))) {
      platform = 'windows';
      architecture = match[1].toLowerCase();
      format = match[2].toLowerCase();
    } else if ((match = name.match(new RegExp(`^VersePoint-macOS-(universal|x64|arm64)-${versionPattern}\\.(zip|dmg)$`, 'i')))) {
      platform = 'macos';
      architecture = match[1].toLowerCase();
      format = match[2].toLowerCase();
    } else if ((match = name.match(new RegExp(`^VersePoint-${versionPattern}-(?:(?:mac|darwin)-)?(universal|x64|arm64)\\.(zip|dmg)$`, 'i')))) {
      platform = 'macos';
      architecture = match[1].toLowerCase();
      format = match[2].toLowerCase();
    } else {
      return null;
    }

    // The URL must identify this exact asset in this repository and release.
    const pathname = `/VersePoint/VersePoint/releases/download/${releaseTag}/${encodeURIComponent(name)}`;
    const url = officialURL(asset.browser_download_url, pathname);
    if (!url) return null;
    const size = Number.isFinite(asset.size) && asset.size > 0 ? asset.size : null;
    return { name, platform, architecture, format, portable, url, size };
  }

  function chooseAsset(assets, platform, button) {
    const architecture = button.dataset.architecture || (platform === 'windows' ? 'x64' : 'universal');
    if (!['x64', 'arm64', 'universal'].includes(architecture)) return null;
    const portable = button.dataset.package === 'portable';
    const candidates = assets.filter(asset => {
      if (asset.platform !== platform || asset.portable !== portable) return false;
      if (platform === 'macos') return asset.architecture === architecture || asset.architecture === 'universal';
      // The legacy official Windows ZIP has no architecture in its filename.
      // It is never presented as ARM64 or relabeled as a verified x64 build.
      return asset.architecture === architecture || (!asset.architecture && architecture === 'x64');
    });
    // The macOS ZIP includes the DMG and both guides; make it the default download.
    const formatRank = asset => platform === 'macos' ?
      (asset.format === 'zip' ? 0 : 1) : (asset.format === 'zip' ? 1 : 0);
    const rank = asset => (asset.architecture === architecture ? 0 : 2) + formatRank(asset);
    return candidates.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))[0] || null;
  }

  function assetDescription(asset) {
    let platform;
    if (asset.platform === 'windows') {
      platform = asset.architecture === 'x64' ? 'Windows 64-bit' :
        asset.architecture === 'arm64' ? 'Windows ARM64' : 'Windows';
    } else {
      platform = asset.architecture === 'universal' ? 'Intel + Apple silicon' :
        asset.architecture === 'x64' ? 'Intel Mac' : 'Apple silicon';
    }
    const format = asset.format.toUpperCase();
    const size = asset.size ? ` · ${Math.round(asset.size / 1_000_000)} MB` : '';
    return `${platform} · ${format}${asset.portable ? ' portable' : ''}${size}`;
  }

  async function enhanceDownloads() {
    const windowsButton = document.getElementById('windows-download');
    const macosButton = document.getElementById('macos-download');
    if (!windowsButton && !macosButton) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6500);
    try {
      const response = await fetch(releaseAPI, {
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) return;
      const release = await response.json();
      if (!release || release.tag_name !== releaseTag || release.draft !== false ||
          typeof release.prerelease !== 'boolean' || !Array.isArray(release.assets) ||
          officialURL(release.html_url, `/VersePoint/VersePoint/releases/tag/${releaseTag}`) !== releasePage) return;

      const channel = release.prerelease ? 'Beta' : 'Stable';
      const label = `${releaseTag} ${channel}`;
      const assets = release.assets.map(asset => classifyAsset(asset, releaseTag.slice(1))).filter(Boolean);
      for (const [platform, button] of [['windows', windowsButton], ['macos', macosButton]]) {
        if (!button) continue;
        const asset = chooseAsset(assets, platform, button);
        if (!asset) continue;
        button.href = asset.url;
        button.dataset.releaseChannel = channel.toLowerCase();
        button.title = asset.name;
        const meta = document.getElementById(`${platform}-meta`);
        if (meta) {
          meta.setAttribute('aria-live', 'polite');
          meta.textContent = `${label} · ${assetDescription(asset)}`;
        }
      }
      const note = document.getElementById('release-note');
      if (note) {
        const link = note.matches('a') ? note : note.querySelector('a');
        if (link) {
          link.href = releasePage;
          link.textContent = `${label} release notes`;
        } else note.textContent = `Current public release: ${label}.`;
      }
    } catch {
      // Static official release links and their labels stay usable on failure.
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function enhanceShowcase() {
    const frame = document.getElementById('showcase-frame');
    const poster = document.getElementById('showcase-poster');
    if (!frame || !poster) return;
    const origin = window.location.origin;
    let frameOrigin;
    try {
      frameOrigin = new URL(frame.getAttribute('src'), window.location.href).origin;
    } catch {
      return;
    }
    // Local HTTP and GitHub Pages both provide a real, same-origin boundary.
    if (origin === 'null' || frameOrigin !== origin) return;

    let childReady = false;
    let pending = null;

    function showFallback() {
      childReady = false;
      poster.hidden = false;
      frame.classList.remove('is-ready');
      frame.dataset.state = 'error';
      frame.setAttribute('aria-hidden', 'true');
      frame.inert = true;
    }

    function dispatchPending() {
      if (!childReady || !pending || !frame.contentWindow) return;
      const request = pending;
      pending = null;
      try {
        frame.contentWindow.postMessage({ type: 'versepoint-showcase-scene', scene: request.scene }, origin);
        // A late ready message must not take focus from another page action.
        if (document.activeElement === request.link) frame.focus({ preventScroll: true });
      } catch {
        pending = request;
        showFallback();
      }
    }

    window.addEventListener('message', event => {
      if (!frame.contentWindow || event.origin !== origin || event.source !== frame.contentWindow ||
          !event.data || typeof event.data !== 'object') return;
      if (event.data.type === 'versepoint-showcase-ready') {
        childReady = true;
        poster.hidden = true;
        frame.classList.add('is-ready');
        frame.dataset.state = 'ready';
        frame.removeAttribute('aria-hidden');
        frame.inert = false;
        dispatchPending();
      } else if (event.data.type === 'versepoint-showcase-error') {
        showFallback();
      }
    });

    frame.addEventListener('error', showFallback);
    frame.setAttribute('aria-hidden', 'true');
    frame.inert = true;
    document.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[data-scene]');
      const scene = link?.dataset.scene;
      if (!link || link.getAttribute('href') !== '#showcase' || !knownScenes.has(scene)) return;
      pending = { scene, link };
      dispatchPending();
      // Retain the anchor's native navigation, history and keyboard behavior.
    });
  }

  function start() {
    enhanceShowcase();
    void enhanceDownloads();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
