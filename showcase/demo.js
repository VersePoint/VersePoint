(() => {
  'use strict';

  const image = document.querySelector('#application-image');
  const animation = document.querySelector('#application-animation');
  const video = document.querySelector('#application-video');
  const stage = document.querySelector('#application-stage');
  const layer = document.querySelector('#hotspot-layer');
  const stageMessage = document.querySelector('#stage-message');
  const stateDescription = document.querySelector('#state-description');
  const interactionMessage = document.querySelector('#interaction-message');
  const stageScroll = document.querySelector('#stage-scroll');
  const overlay = document.querySelector('#application-overlay');
  const dimmer = document.querySelector('#application-dimmer');
  const underlays = document.querySelector('#application-underlays');
  const cameraViewport = document.querySelector('#camera-viewport');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const unsupportedMessage = 'This control is not included in the captured preview.';

  let manifest;
  let currentState;
  let history = [];
  let navigationRequest = 0;
  let messageTimer;
  let currentVideo;
  let currentAnimation;
  let animationWanted = false;
  let videoWanted = false;
  let motionPaused = false;
  let lastFullscreenExit = -1000;
  let contextBase = null;
  let contextLayers = [];
  const camera = { scale: .94, x: 0, y: 0, rx: 0, ry: 0, rz: 0, cinematic: !reducedMotion.matches };
  let cameraFrame = 0;
  let cameraRun = null;
  let cameraPhase = 'overview';
  let focusAnchor = null;
  let idleTimer = 0;
  let pointerPressed = false;
  let lastPointer = null;
  let pointerInside = false;
  let intentionalHotspotHover = false;
  let arrivalPending = true;
  let arrivalVisible = false;
  let arrivalObserver = null;
  let arrivalFrame = 0;
  let spaceHeld = false;
  let drag = null;
  let suppressClickUntil = 0;
  let cameraWidth = 0;
  let cameraHeight = 0;
  let contentWidth = 0;
  let contentHeight = 0;
  let captureRatio = 1.659;
  let loading = false;
  let ready = false;
  let pendingParentScene = null;
  let preloadTimer = 0;
  let preloadIsIdle = false;
  let preloadGeneration = 0;
  const imageCache = new Map();

  function notifyParent(type) {
    if (window.parent !== window && window.location.origin !== 'null') {
      window.parent.postMessage({ type }, window.location.origin);
    }
  }

  function isVisible() {
    return arrivalVisible && document.visibilityState === 'visible';
  }

  function compactViewport() {
    return cameraViewport.clientWidth < 900;
  }

  function fitScale() {
    return Math.min(cameraViewport.clientWidth / (contentWidth || 1), cameraViewport.clientHeight / (contentHeight || 1), 1);
  }

  function minimumScale() {
    return fitScale() * (camera.cinematic && !reducedMotion.matches && !compactViewport() ? .94 : 1);
  }

  function canPan() {
    return contentWidth * camera.scale > cameraViewport.clientWidth + 1 || contentHeight * camera.scale > cameraViewport.clientHeight + 1;
  }

  function cachedImage(src) {
    if (!imageCache.has(src)) {
      const preload = new Image();
      preload.decoding = 'async';
      preload.addEventListener('error', () => {
        if (imageCache.get(src) === preload) imageCache.delete(src);
      });
      preload.src = src;
      imageCache.set(src, preload);
    }
    return imageCache.get(src);
  }

  function preloadTargets(state) {
    cancelPreloading();
    if (!isVisible() || navigator.connection?.saveData || /(^|-)2g$/.test(navigator.connection?.effectiveType || '')) return;
    const generation = preloadGeneration;
    const likelyNext = [...new Set((state.hotspots || []).map((hotspot) => {
      const targetState = manifest.states[hotspot.target];
      return targetState?.overlay?.src || targetState?.image;
    }).filter((src) => typeof src === 'string' && !imageCache.has(src)))].slice(0, 2);
    const preload = () => {
      preloadTimer = 0;
      if (generation !== preloadGeneration || !isVisible()) return;
      for (const src of likelyNext) cachedImage(src).decode().catch(() => {});
    };
    preloadIsIdle = 'requestIdleCallback' in window;
    preloadTimer = preloadIsIdle ? window.requestIdleCallback(preload, { timeout: 1500 }) : window.setTimeout(preload, 600);
  }

  function cancelPreloading() {
    preloadGeneration += 1;
    if (preloadTimer) {
      if (preloadIsIdle) window.cancelIdleCallback(preloadTimer);
      else window.clearTimeout(preloadTimer);
    }
    preloadTimer = 0;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function boundedPan(x, y, scale = camera.scale) {
    const widthDelta = cameraViewport.clientWidth - contentWidth * scale;
    const heightDelta = cameraViewport.clientHeight - contentHeight * scale;
    return {
      x: widthDelta >= 0 ? widthDelta / 2 : clamp(x, widthDelta, 0),
      y: heightDelta >= 0 ? heightDelta / 2 : clamp(y, heightDelta, 0),
    };
  }

  function overviewPose() {
    const scale = minimumScale();
    return { scale, x: (cameraViewport.clientWidth - contentWidth * scale) / 2, y: (cameraViewport.clientHeight - contentHeight * scale) / 2, rx: 0, ry: 0, rz: 0 };
  }

  function restingPose() {
    return overviewPose();
  }

  function currentPose() {
    return { scale: camera.scale, x: camera.x, y: camera.y, rx: camera.rx, ry: camera.ry, rz: camera.rz };
  }

  function paintCamera() {
    const bounded = boundedPan(camera.x, camera.y);
    camera.x = bounded.x;
    camera.y = bounded.y;
    const centerX = contentWidth / 2;
    const centerY = contentHeight / 2;
    stage.style.transform = `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale}) translate(${centerX}px, ${centerY}px) rotateX(${camera.rx}deg) rotateY(${camera.ry}deg) rotateZ(${camera.rz}deg) translate(${-centerX}px, ${-centerY}px)`;
    cameraViewport.classList.toggle('cinematic-enabled', camera.cinematic);
    cameraViewport.classList.toggle('pan-ready', canPan() && spaceHeld);
    cameraViewport.classList.toggle('is-panning', Boolean(drag));
  }

  function stopCameraMotion({ flatten = false } = {}) {
    const wasResting = cameraPhase === 'resting' && !cameraRun;
    cancelAnimationFrame(cameraFrame);
    cameraFrame = 0;
    cameraRun = null;
    if (flatten) camera.rx = camera.ry = camera.rz = 0;
    cameraPhase = camera.cinematic ? (wasResting ? 'resting' : camera.scale > minimumScale() + .02 ? 'focused' : 'overview') : 'manual';
  }

  function clearPullback() {
    window.clearTimeout(idleTimer);
    idleTimer = 0;
  }

  function cancelArrival({ flatten = false } = {}) {
    arrivalPending = false;
    cancelAnimationFrame(arrivalFrame);
    arrivalFrame = 0;
    if (cameraRun?.kind === 'arrival') {
      stopCameraMotion({ flatten });
      paintCamera();
      schedulePullback();
    }
  }

  function startArrivalIfVisible() {
    if (arrivalFrame || !arrivalPending || !isVisible() || !currentState || stage.getAttribute('aria-busy') === 'true') return;
    // Let the captured image establish its dimensions before starting the camera.
    arrivalFrame = requestAnimationFrame(() => {
      arrivalFrame = requestAnimationFrame(() => {
        arrivalFrame = 0;
        if (!arrivalPending || !isVisible() || stage.getAttribute('aria-busy') === 'true') return;
        arrivalPending = false;
        if (!reducedMotion.matches) {
          if (currentAnimation && !motionPaused) setAnimationPlaying(true);
          if (currentVideo) playVideo();
        }
        if (camera.cinematic || compactViewport()) focusCameraOnAction(null, manifest.states[currentState], { kind: 'arrival', force: compactViewport() });
      });
    });
  }

  function schedulePullback(delay = compactViewport() ? 5500 : 2800) {
    clearPullback();
    if (!isVisible() || !camera.cinematic || reducedMotion.matches || cameraPhase === 'resting' || camera.scale <= minimumScale() + .02) return;
    idleTimer = window.setTimeout(() => {
      if (pointerPressed || drag || spaceHeld || (intentionalHotspotHover && pointerIsOnControl()) || stage.getAttribute('aria-busy') === 'true') {
        schedulePullback(450);
        return;
      }
      const compact = compactViewport();
      const pose = compact ? restingPose() : overviewPose();
      animatePose(pose, { duration: 650, tilt: true, phase: compact ? 'resting' : 'overview', kind: 'pullback', onComplete: () => { focusAnchor = { ...pose }; } });
    }, delay);
  }

  function animatePose(nextPose, { duration = 420, tilt = false, phase = 'focused', kind = 'focus', onComplete } = {}) {
    if (kind !== 'follow') intentionalHotspotHover = false;
    stopCameraMotion();
    const target = { ...nextPose, scale: clamp(nextPose.scale, minimumScale(), 2.2), rx: 0, ry: 0, rz: 0 };
    Object.assign(target, boundedPan(target.x, target.y, target.scale));
    const start = currentPose();
    if (reducedMotion.matches || duration <= 0) {
      Object.assign(camera, target);
      cameraPhase = phase;
      paintCamera();
      onComplete?.();
      return;
    }
    const run = { kind };
    cameraRun = run;
    cameraPhase = 'transition';
    const began = performance.now();
    const direction = target.x <= start.x ? -1 : 1;
    function step(now) {
      if (cameraRun !== run) return;
      if (kind === 'follow' && (pointerPressed || pointerIsOnControl())) {
        stopCameraMotion({ flatten: true });
        paintCamera();
        return;
      }
      const progress = clamp((now - began) / duration, 0, 1);
      const eased = progress < .5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      const pulse = tilt ? Math.sin(progress * Math.PI) : 0;
      camera.scale = start.scale + (target.scale - start.scale) * eased;
      camera.x = start.x + (target.x - start.x) * eased;
      camera.y = start.y + (target.y - start.y) * eased;
      camera.rx = start.rx * (1 - eased) - pulse * 1.8;
      camera.ry = start.ry * (1 - eased) + pulse * direction * 4.1;
      camera.rz = start.rz * (1 - eased) - pulse * direction * .7;
      paintCamera();
      if (progress < 1) cameraFrame = requestAnimationFrame(step);
      else {
        Object.assign(camera, target);
        cameraFrame = 0;
        cameraRun = null;
        cameraPhase = phase;
        paintCamera();
        onComplete?.();
      }
    }
    cameraFrame = requestAnimationFrame(step);
  }

  function visibleCameraBounds() {
    const content = cameraViewport.getBoundingClientRect();
    const frame = stageScroll.getBoundingClientRect();
    return {
      left: Math.max(content.left, frame.left + stageScroll.clientLeft),
      right: Math.min(content.right, frame.left + stageScroll.clientLeft + stageScroll.clientWidth),
      top: content.top,
      bottom: content.bottom,
      content,
    };
  }

  function zoomAnchor(view) {
    const focused = document.activeElement;
    if (focused?.matches('.hotspot:focus-visible')) {
      const bounds = focused.getBoundingClientRect();
      return {
        x: clamp((bounds.left + bounds.right) / 2, view.left, view.right) - view.content.left,
        y: clamp((bounds.top + bounds.bottom) / 2, view.top, view.bottom) - view.content.top,
      };
    }
    return { x: (view.left + view.right) / 2 - view.content.left, y: (view.top + view.bottom) / 2 - view.content.top };
  }

  function beginManualCamera() {
    cancelArrival();
    clearPullback();
    stopCameraMotion({ flatten: true });
    camera.cinematic = false;
    cameraPhase = 'manual';
    focusAnchor = null;
    if (camera.scale < minimumScale()) Object.assign(camera, overviewPose());
    paintCamera();
  }

  function zoomPose(scale) {
    const next = Math.round(clamp(scale, minimumScale(), 2.2) * 100) / 100;
    const { x: anchorX, y: anchorY } = zoomAnchor(visibleCameraBounds());
    return { scale: next, x: anchorX - ((anchorX - camera.x) / camera.scale) * next, y: anchorY - ((anchorY - camera.y) / camera.scale) * next };
  }

  function easeIntoZoom(scale) {
    beginManualCamera();
    animatePose(zoomPose(scale), { duration: 220, phase: 'manual', kind: 'zoom' });
  }

  function fitCamera() {
    beginManualCamera();
    Object.assign(camera, overviewPose());
    paintCamera();
  }

  function pointerIsOnControl() {
    return lastPointer && document.elementFromPoint(lastPointer.x, lastPointer.y)?.closest('.hotspot');
  }

  function usefulFocusRegion(hotspot, state) {
    const explicit = normalizeRect(hotspot?.focusRect || state?.focusRect);
    if (explicit) return explicit;
    const overlayRect = normalizeRect(state?.overlay?.rect);
    if (overlayRect) {
      if (overlayRect[3] > .9) return [.70, .02, .30, .70];
      const x = Math.max(0, overlayRect[0] - .025);
      const y = Math.max(0, overlayRect[1] - .025);
      return [x, y, Math.min(1 - x, overlayRect[2] + .05), Math.min(1 - y, overlayRect[3] + .05)];
    }
    if (currentState?.startsWith('motion-') || (hotspot?.rect?.[0] >= .75 && hotspot.rect[1] < .88)) return [.70, .23, .30, .69];
    if (compactViewport()) return [.25, .04, .49, .49];
    return [0, .02, .75, .64];
  }

  function focusCameraOnAction(hotspot, state, { kind = 'focus', force = false } = {}) {
    if (!isVisible() || (!camera.cinematic && !force)) return;
    clearPullback();
    // A phone shows all three columns. Automatic framing must not crop away
    // the navigation or presentation tools after arrival or a scene selection.
    if (compactViewport()) {
      animatePose(overviewPose(), { duration: 220, phase: 'overview', kind });
      focusAnchor = null;
      return;
    }
    if (currentState === 'tools-collapsed') {
      animatePose(overviewPose(), { duration: 550, tilt: true, phase: 'overview' });
      return;
    }
    const rect = usefulFocusRegion(hotspot, state);
    const fitted = Math.min(cameraViewport.clientWidth * .96 / (contentWidth * rect[2]), cameraViewport.clientHeight * .96 / (contentHeight * rect[3]));
    // Larger screens can frame a panel while retaining the cinematic navigation.
    const scale = clamp(fitted, fitScale() * 1.35, fitScale() * 1.7);
    const view = visibleCameraBounds();
    const anchorX = (view.left + view.right) / 2 - view.content.left;
    const anchorY = (view.top + view.bottom) / 2 - view.content.top;
    const pose = { scale, x: anchorX - (rect[0] + rect[2] / 2) * contentWidth * scale, y: anchorY - (rect[1] + rect[3] / 2) * contentHeight * scale };
    Object.assign(pose, boundedPan(pose.x, pose.y, scale));
    focusAnchor = { ...pose };
    animatePose(pose, { duration: 600, tilt: true, phase: 'focused', kind, onComplete: () => schedulePullback() });
  }

  function followPointer(event) {
    lastPointer = { x: event.clientX, y: event.clientY };
    if (pointerPressed || drag || spaceHeld || event.pointerType === 'touch' || event.buttons || reducedMotion.matches || stage.getAttribute('aria-busy') === 'true') return;
    if (event.target.closest('.hotspot')) {
      if (cameraRun?.kind === 'arrival') cancelArrival({ flatten: true });
      if (cameraRun?.kind === 'follow') {
        stopCameraMotion({ flatten: true });
        paintCamera();
      }
      intentionalHotspotHover = camera.cinematic && cameraPhase === 'focused' && !cameraRun;
      if (camera.cinematic && canPan()) schedulePullback();
      return;
    }
    intentionalHotspotHover = false;
    const automaticFollow = camera.cinematic && (cameraPhase === 'focused' || cameraRun?.kind === 'follow') && focusAnchor;
    if (!automaticFollow || !canPan()) return;
    if (cameraRun && cameraRun.kind !== 'follow') return;
    const rect = cameraViewport.getBoundingClientRect();
    const nx = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const ny = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    const fullTarget = boundedPan(-nx * Math.max(0, contentWidth * camera.scale - rect.width), -ny * Math.max(0, contentHeight * camera.scale - rect.height));
    const strength = Math.max(Math.abs(nx - .5), Math.abs(ny - .5)) * .56;
    const target = { x: focusAnchor.x + (fullTarget.x - focusAnchor.x) * strength, y: focusAnchor.y + (fullTarget.y - focusAnchor.y) * strength };
    animatePose({ scale: camera.scale, ...target }, { duration: 240, phase: 'focused', kind: 'follow' });
    schedulePullback();
  }

  function finishDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const pointerId = drag.id;
    const moved = drag.moved;
    drag = null;
    if (moved) suppressClickUntil = performance.now() + 250;
    if (cameraViewport.hasPointerCapture(pointerId)) cameraViewport.releasePointerCapture(pointerId);
    paintCamera();
  }

  function resizeCamera() {
    const width = cameraViewport.clientWidth;
    const height = cameraViewport.clientHeight;
    const nextWidth = Math.max(width, 900);
    const nextHeight = nextWidth / captureRatio;
    if (!width || !height || (Math.abs(width - cameraWidth) < .5 && Math.abs(height - cameraHeight) < .5 && Math.abs(nextHeight - contentHeight) < .5)) return;
    const wasResting = camera.cinematic && cameraPhase === 'resting';
    const wasOverview = !contentWidth || cameraPhase === 'overview' || camera.scale <= minimumScale() + .02;
    const centerU = contentWidth ? (cameraWidth / 2 - camera.x) / camera.scale / contentWidth : .5;
    const centerV = contentHeight ? (cameraHeight / 2 - camera.y) / camera.scale / contentHeight : .5;
    stopCameraMotion({ flatten: true });
    cameraWidth = width;
    cameraHeight = height;
    contentWidth = nextWidth;
    contentHeight = nextHeight;
    stage.style.width = `${contentWidth}px`;
    stage.style.height = `${contentHeight}px`;
    if (compactViewport()) {
      Object.assign(camera, overviewPose());
      cameraPhase = 'overview';
      focusAnchor = null;
    } else if (wasResting) {
      Object.assign(camera, compactViewport() ? restingPose() : overviewPose());
      cameraPhase = compactViewport() ? 'resting' : 'overview';
      focusAnchor = { scale: camera.scale, x: camera.x, y: camera.y };
    } else if (wasOverview) {
      Object.assign(camera, overviewPose());
      cameraPhase = 'overview';
    } else {
      camera.scale = clamp(camera.scale, minimumScale(), 2.2);
      camera.x = width / 2 - centerU * contentWidth * camera.scale;
      camera.y = height / 2 - centerV * contentHeight * camera.scale;
      focusAnchor = { scale: camera.scale, x: camera.x, y: camera.y };
    }
    paintCamera();
    schedulePullback();
  }

  cameraViewport.addEventListener('pointerenter', () => { pointerInside = true; });
  cameraViewport.addEventListener('pointerleave', () => {
    pointerInside = false;
    lastPointer = null;
    intentionalHotspotHover = false;
    if (cameraRun?.kind === 'follow') {
      stopCameraMotion({ flatten: true });
      paintCamera();
    }
  });
  cameraViewport.addEventListener('pointerdown', (event) => {
    cancelArrival();
    pointerPressed = true;
    intentionalHotspotHover = false;
    clearPullback();
    stopCameraMotion({ flatten: true });
    paintCamera();
    const touchPan = event.pointerType === 'touch' && !compactViewport() && !event.target.closest('.hotspot');
    if ((!touchPan && (!canPan() || !spaceHeld)) || event.button !== 0) return;
    if (camera.cinematic) beginManualCamera();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX: camera.x, panY: camera.y, touch: touchPan, moved: false };
    cameraViewport.setPointerCapture(event.pointerId);
    if (!touchPan) event.preventDefault();
    event.stopPropagation();
    paintCamera();
  }, true);
  cameraViewport.addEventListener('pointermove', (event) => {
    if (drag && event.pointerId === drag.id) {
      const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
      if (!drag.moved && distance < 5) return;
      if (!drag.moved && drag.touch && camera.scale < 1) {
        const bounds = cameraViewport.getBoundingClientRect();
        const anchorX = drag.x - bounds.left;
        const anchorY = drag.y - bounds.top;
        const scale = 1.1;
        camera.x = anchorX - ((anchorX - camera.x) / camera.scale) * scale;
        camera.y = anchorY - ((anchorY - camera.y) / camera.scale) * scale;
        camera.scale = scale;
        paintCamera();
        drag.panX = camera.x;
        drag.panY = camera.y;
      }
      drag.moved = true;
      camera.x = drag.panX + event.clientX - drag.x;
      camera.y = drag.panY + event.clientY - drag.y;
      paintCamera();
      event.preventDefault();
      return;
    }
    followPointer(event);
  });
  window.addEventListener('pointerup', (event) => {
    pointerPressed = false;
    finishDrag(event);
    window.setTimeout(() => {
      if (pointerPressed) return;
      if (!cameraRun && (camera.rx || camera.ry || camera.rz)) {
        stopCameraMotion({ flatten: true });
        paintCamera();
      }
      if ((!cameraRun || cameraRun.kind === 'follow') && stage.getAttribute('aria-busy') !== 'true') schedulePullback();
    }, 0);
  });
  cameraViewport.addEventListener('contextmenu', () => {
    pointerPressed = false;
    window.setTimeout(() => {
      stopCameraMotion({ flatten: true });
      paintCamera();
      schedulePullback();
    }, 0);
  });
  cameraViewport.addEventListener('pointercancel', (event) => {
    pointerPressed = false;
    finishDrag(event);
    stopCameraMotion({ flatten: true });
    paintCamera();
    schedulePullback();
  });
  cameraViewport.addEventListener('lostpointercapture', finishDrag);
  cameraViewport.addEventListener('click', (event) => {
    camera.rx = camera.ry = camera.rz = 0;
    paintCamera();
    if (performance.now() < suppressClickUntil || (spaceHeld && canPan())) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
  cameraViewport.addEventListener('click', (event) => {
    if (event.target !== cameraViewport || performance.now() < suppressClickUntil || (spaceHeld && canPan())) return;
    if (manifest?.states[currentState]?.dismissOutside) goBack();
  });
  layer.addEventListener('focusin', (event) => {
    const button = event.target.closest('.hotspot');
    if (!button || !button.matches(':focus-visible')) return;
    beginManualCamera();
    const bounds = button.getBoundingClientRect();
    const view = visibleCameraBounds();
    if (bounds.left >= view.left + 8 && bounds.right <= view.right - 8 && bounds.top >= view.top + 8 && bounds.bottom <= view.bottom - 8) return;
    camera.x = (view.left + view.right) / 2 - view.content.left - (button.offsetLeft + button.offsetWidth / 2) * camera.scale;
    camera.y = (view.top + view.bottom) / 2 - view.content.top - (button.offsetTop + button.offsetHeight / 2) * camera.scale;
    paintCamera();
  });
  document.addEventListener('pointerdown', () => cancelArrival(), true);

  function visibilityChanged() {
    if (!isVisible()) {
      clearPullback();
      cancelPreloading();
      stopCameraMotion({ flatten: true });
      paintCamera();
      video.pause();
      video.hidden = true;
      animation.hidden = true;
      animation.removeAttribute('src');
      return;
    }
    load();
    if (ready) {
      if (pendingParentScene && manifest.states[pendingParentScene]) {
        const scene = pendingParentScene;
        pendingParentScene = null;
        navigateParentScene(scene);
        return;
      }
      if (!reducedMotion.matches && animationWanted && !motionPaused) setAnimationPlaying(true);
      if (!reducedMotion.matches && videoWanted) playVideo();
      preloadTargets(manifest.states[currentState]);
      schedulePullback();
    }
    startArrivalIfVisible();
  }

  if ('IntersectionObserver' in window) {
    arrivalObserver = new IntersectionObserver((entries) => {
      arrivalVisible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= .25);
      visibilityChanged();
    }, { threshold: [0, .25] });
    arrivalObserver.observe(cameraViewport);
  } else arrivalVisible = true;
  document.addEventListener('visibilitychange', visibilityChanged);
  new ResizeObserver(resizeCamera).observe(cameraViewport);
  resizeCamera();

  function requestedState() {
    try { return decodeURIComponent(window.location.hash.slice(1)); }
    catch { return ''; }
  }

  function announce(message) {
    if (!interactionMessage) return;
    window.clearTimeout(messageTimer);
    interactionMessage.textContent = message;
    messageTimer = window.setTimeout(() => {
      interactionMessage.textContent = '';
    }, 6500);
  }

  function showUnsupportedControl() {
    announce(unsupportedMessage);
  }

  function showError(message) {
    stage.classList.remove('is-loading');
    stage.classList.add('has-error');
    stage.setAttribute('aria-busy', 'false');
    clearPullback();
    stopCameraMotion({ flatten: true });
    Object.assign(camera, overviewPose());
    paintCamera();
    notifyParent('versepoint-showcase-error');
    if (stageMessage) {
      stageMessage.textContent = message;
      stageMessage.hidden = false;
    } else announce(message);
  }

  function normalizeRect(rect) {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
    const [x, y, width, height] = rect;
    if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.001 || y + height > 1.001) return null;
    return rect;
  }

  function setRect(element, rect) {
    element.style.left = `${rect[0] * 100}%`;
    element.style.top = `${rect[1] * 100}%`;
    element.style.width = `${rect[2] * 100}%`;
    element.style.height = `${rect[3] * 100}%`;
  }

  function stopVideo() {
    video.pause();
    video.hidden = true;
    video.removeAttribute('src');
    video.removeAttribute('poster');
    video.load();
    currentVideo = null;
    videoWanted = false;
  }

  function configureVideo(state) {
    if (!state.video) return;
    const clip = typeof state.video === 'string' ? { src: state.video } : state.video;
    if (!clip || typeof clip.src !== 'string') return;
    currentVideo = clip;
    video.src = clip.src;
    const rect = normalizeRect(clip.rect);
    setRect(video, rect || [0, 0, 1, 1]);
    if (clip.poster) video.poster = clip.poster;
    else if (!rect) video.poster = state.image;
    video.loop = false;
  }

  async function playVideo() {
    if (!currentVideo) return;
    videoWanted = true;
    if (!isVisible() || reducedMotion.matches) return;
    const requestedClip = currentVideo;
    video.currentTime = 0;
    video.hidden = false;
    try {
      await video.play();
    } catch {
      if (currentVideo !== requestedClip) return;
      videoWanted = false;
      video.hidden = true;
      announce('The recorded motion could not play. The application screen remains available.');
    }
  }

  function stopAnimation() {
    animation.hidden = true;
    animation.removeAttribute('src');
    currentAnimation = null;
    animationWanted = false;
  }

  function setAnimationPlaying(playing) {
    if (!currentAnimation) return;
    animationWanted = playing && !reducedMotion.matches;
    const shouldPlay = animationWanted && isVisible() && !motionPaused;
    animation.hidden = !shouldPlay;
    if (shouldPlay) animation.src = currentAnimation.src;
    else animation.removeAttribute('src');
  }

  function configureAnimation(state, userInitiated) {
    const clip = state.animation;
    if (!clip || typeof clip.src !== 'string') return;
    currentAnimation = clip;
    setRect(animation, normalizeRect(clip.rect) || [0, 0, 1, 1]);
    setAnimationPlaying(userInitiated && !reducedMotion.matches && !motionPaused);
  }

  function handleAction(hotspot, event) {
    cancelArrival();
    const keyboardInitiated = event?.detail === 0;
    if (keyboardInitiated) beginManualCamera();
    if (hotspot.target) {
      navigate(hotspot.target, { userInitiated: true, remember: hotspot.remember !== false, sourceHotspot: hotspot, keyboardInitiated });
      return;
    }
    switch (hotspot.action) {
      case 'back': goBack(); break;
      case 'restart': restart(); break;
      case 'play':
        if (currentAnimation) {
          motionPaused = false;
          setAnimationPlaying(true);
        } else playVideo();
        focusCameraOnAction(hotspot, manifest.states[currentState]);
        break;
      case 'pause':
        video.pause();
        videoWanted = false;
        motionPaused = true;
        setAnimationPlaying(false);
        focusCameraOnAction(hotspot, manifest.states[currentState]);
        break;
      default:
        if (hotspot.message) announce(hotspot.message);
        else showUnsupportedControl();
    }
  }

  function rectsOverlap(first, second) {
    return first[0] < second[0] + second[2] && first[0] + first[2] > second[0]
      && first[1] < second[1] + second[3] && first[1] + first[3] > second[1];
  }

  function createHotspots(state) {
    layer.replaceChildren();
    const overlayRect = normalizeRect(state.overlay?.rect);
    if (state.dismissOutside && overlayRect) {
      const popoverSurface = document.createElement('div');
      popoverSurface.dataset.overlaySurface = 'true';
      popoverSurface.style.position = 'absolute';
      popoverSurface.style.pointerEvents = 'auto';
      setRect(popoverSurface, overlayRect);
      popoverSurface.addEventListener('click', (event) => event.stopPropagation());
      layer.append(popoverSurface);
    }
    const inherited = state.contextual && state.inheritHotspots && contextBase
      ? (contextBase.state.hotspots || []).filter((hotspot) => {
        const rect = normalizeRect(hotspot.rect);
        return rect && (!overlayRect || !rectsOverlap(rect, overlayRect));
      }) : [];
    for (const hotspot of [...inherited, ...(state.hotspots || [])]) {
      const rect = normalizeRect(hotspot.rect);
      if (!rect || typeof hotspot.label !== 'string' || !hotspot.label.trim()) continue;
      if (hotspot.target && !manifest.states[hotspot.target]) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hotspot';
      button.setAttribute('aria-label', hotspot.label);
      setRect(button, rect);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        handleAction(hotspot, event);
      });
      layer.append(button);
    }
  }

  function navigationSnapshot() {
    const focusedHotspot = document.activeElement?.closest('.hotspot');
    return {
      id: currentState,
      contextBase,
      contextLayers: [...contextLayers],
      animationPlaying: Boolean(currentAnimation && animationWanted),
      cameraPose: { scale: camera.scale, centerX: (cameraViewport.clientWidth / 2 - camera.x) / (contentWidth * camera.scale || 1), centerY: (cameraViewport.clientHeight / 2 - camera.y) / (contentHeight * camera.scale || 1) },
      focusedHotspotLabel: focusedHotspot?.getAttribute('aria-label'),
      keyboardFocused: Boolean(focusedHotspot?.matches(':focus-visible')),
    };
  }

  function renderUnderlays(layers) {
    underlays.replaceChildren();
    for (const entry of layers.slice(0, -1)) {
      const underlay = document.createElement('img');
      underlay.alt = '';
      underlay.draggable = false;
      underlay.src = entry.state.overlay.src;
      setRect(underlay, entry.state.overlay.rect);
      underlays.append(underlay);
    }
  }

  async function navigate(id, { userInitiated = false, remember = false, restoreContext = null, sourceHotspot = null, keyboardInitiated = false, returnToOverview = false, externalInitiated = false } = {}) {
    if (userInitiated) cancelArrival();
    const state = manifest?.states[id];
    if (!state) return;
    let nextContext = null;
    let nextLayers = [];
    if (state.contextual) {
      if (typeof state.overlay?.src !== 'string' || !normalizeRect(state.overlay.rect)) return;
      if (restoreContext?.contextBase) {
        nextContext = restoreContext.contextBase;
        nextLayers = [...restoreContext.contextLayers];
      } else if (contextBase) {
        nextContext = contextBase;
        nextLayers = remember && currentState !== id
          ? [...contextLayers, { id, state }]
          : [...contextLayers.slice(0, -1), { id, state }];
      }
      else {
        const baseId = currentState && !manifest.states[currentState]?.contextual ? currentState : manifest.initial;
        nextContext = { id: baseId, state: manifest.states[baseId] };
        nextLayers = [{ id, state }];
      }
    }
    const displayedState = nextContext?.state || state;
    if (typeof displayedState.image !== 'string') return;
    const baseAlreadyRendered = nextContext && (currentState === nextContext.id || contextBase?.id === nextContext.id);
    const request = ++navigationRequest;
    clearPullback();
    stopCameraMotion();
    stage.setAttribute('aria-busy', 'true');
    stage.classList.add('is-loading');
    stage.classList.remove('has-error');
    if (interactionMessage) interactionMessage.textContent = '';
    const nextImage = cachedImage(displayedState.image);
    try {
      await Promise.all([nextImage.decode(), ...nextLayers.map((entry) => cachedImage(entry.state.overlay.src).decode())]);
    } catch {
      if (request !== navigationRequest) return;
      showError('This application screen could not be loaded. Reload the page to try again.');
      return;
    }
    if (request !== navigationRequest) return;
    if (remember && currentState && currentState !== id) history.push(navigationSnapshot());
    if (!baseAlreadyRendered) {
      stopVideo();
      stopAnimation();
      image.src = displayedState.image;
      image.width = nextImage.naturalWidth;
      image.height = nextImage.naturalHeight;
      captureRatio = nextImage.naturalWidth / nextImage.naturalHeight;
      document.documentElement.style.setProperty('--capture-ratio', String(captureRatio));
      resizeCamera();
      configureVideo(displayedState);
      configureAnimation(displayedState, Boolean(restoreContext?.animationPlaying) || (userInitiated && !nextContext));
    }
    currentState = id;
    contextBase = nextContext;
    contextLayers = nextLayers;
    renderUnderlays(contextLayers);
    image.alt = nextContext
      ? `${(displayedState.alt || displayedState.title || 'VersePoint application interface').replace(/[.\s]+$/, '')}. ${(state.alt || state.title || '').replace(/^[.\s]+/, '')}`.trim()
      : state.alt || state.title || 'VersePoint application interface';
    if (nextContext) {
      overlay.src = state.overlay.src;
      setRect(overlay, state.overlay.rect);
      overlay.hidden = false;
      dimmer.hidden = !state.dim;
    } else {
      overlay.hidden = true;
      overlay.removeAttribute('src');
      dimmer.hidden = true;
    }
    image.hidden = false;
    if (stageMessage) stageMessage.hidden = true;
    stage.classList.remove('is-loading');
    stage.setAttribute('aria-busy', 'false');
    if (stateDescription) stateDescription.textContent = state.title || id;
    createHotspots(state);
    window.history.replaceState(null, '', `#${encodeURIComponent(id)}`);
    preloadTargets(state);

    if (userInitiated) {
      if (currentVideo && !reducedMotion.matches && !nextContext) playVideo();
    }
    if (restoreContext?.cameraPose) {
      const saved = restoreContext.cameraPose;
      const scale = clamp(saved.scale, minimumScale(), 2.2);
      const pose = compactViewport() ? overviewPose() : { scale, x: cameraViewport.clientWidth / 2 - saved.centerX * contentWidth * scale, y: cameraViewport.clientHeight / 2 - saved.centerY * contentHeight * scale };
      focusAnchor = { ...pose };
      animatePose(pose, { duration: camera.cinematic ? 550 : 0, tilt: camera.cinematic && !compactViewport(), phase: pose.scale > minimumScale() + .02 ? 'focused' : 'overview', onComplete: () => schedulePullback() });
    } else if (camera.cinematic && returnToOverview) {
      animatePose(overviewPose(), { duration: 600, tilt: !compactViewport(), phase: 'overview' });
    } else if (camera.cinematic && sourceHotspot && !keyboardInitiated) {
      focusCameraOnAction(sourceHotspot, state);
    }
    // Restore the scene before keyboard focus reveals a control, so focus cannot be hidden by a later camera restore.
    if (userInitiated && !externalInitiated && (keyboardInitiated || restoreContext?.keyboardFocused || (!camera.cinematic && document.activeElement === document.body))) {
      const label = restoreContext?.focusedHotspotLabel || (keyboardInitiated ? sourceHotspot?.label : null);
      const focusedControl = [...layer.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label) || layer.querySelector('button');
      focusedControl?.focus({ preventScroll: true });
    }
    return true;
  }

  function restart() {
    if (!manifest) return;
    history = [];
    if (camera.cinematic) {
      clearPullback();
      stopCameraMotion({ flatten: true });
      Object.assign(camera, overviewPose());
      paintCamera();
    } else fitCamera();
    navigate(manifest.initial, { userInitiated: true });
  }

  function goBack() {
    const previousState = history.pop();
    if (previousState) navigate(previousState.id, { userInitiated: true, restoreContext: previousState });
    else if (contextBase) navigate(contextBase.id, { userInitiated: true, returnToOverview: true });
    else if (currentState && currentState !== manifest.initial) navigate(manifest.initial, { userInitiated: true, returnToOverview: true });
    else announce('You’re at the beginning. Choose a verse, or open Songs, Programs and Motion.');
  }

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) lastFullscreenExit = performance.now();
    requestAnimationFrame(resizeCamera);
  });
  document.querySelector('#home-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    restart();
  });
  layer.addEventListener('click', (event) => {
    const state = manifest?.states[currentState];
    if (state?.dismissOutside) {
      if (!event.target.closest('[data-overlay-surface]')) goBack();
    } else showUnsupportedControl();
  });
  video.addEventListener('ended', () => { videoWanted = false; video.hidden = true; });
  video.addEventListener('error', () => {
    video.hidden = true;
    announce('The motion preview could not be loaded. You can continue exploring the application screens.');
  });
  animation.addEventListener('error', () => {
    if (!animation.getAttribute('src')) return;
    setAnimationPlaying(false);
    announce('The motion preview could not be loaded. You can continue exploring the application screens.');
  });
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      video.pause();
      video.hidden = true;
      setAnimationPlaying(false);
      beginManualCamera();
    }
    paintCamera();
  });
  document.addEventListener('keydown', (event) => {
    cancelArrival({ flatten: true });
    const isEditable = event.target.matches('input, textarea, select, [contenteditable="true"]');
    if (!isEditable && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        beginManualCamera();
        easeIntoZoom(camera.scale + .2);
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        beginManualCamera();
        easeIntoZoom(camera.scale - .2);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        fitCamera();
        return;
      }
      if (event.code === 'Space' && pointerInside && canPan()
        && !event.target.closest('a')) {
        spaceHeld = true;
        beginManualCamera();
        if (!event.target.closest('.hotspot')) event.preventDefault();
        paintCamera();
      }
    }
    if (event.key === 'Escape') {
      if (document.fullscreenElement || performance.now() - lastFullscreenExit < 250) return;
      event.preventDefault();
      goBack();
    }
  });
  document.addEventListener('keyup', (event) => {
    if (event.code !== 'Space') return;
    spaceHeld = false;
    if (drag) {
      suppressClickUntil = performance.now() + 250;
      event.preventDefault();
    }
    paintCamera();
  });
  window.addEventListener('blur', () => {
    spaceHeld = false;
    pointerPressed = false;
    finishDrag();
    stopCameraMotion({ flatten: true });
    paintCamera();
    schedulePullback();
  });
  window.addEventListener('hashchange', () => {
    cancelArrival({ flatten: true });
    const id = requestedState();
    if (id && id !== currentState && manifest?.states[id]) navigate(id);
  });

  async function navigateParentScene(scene) {
    if (!manifest?.states[scene]) return;
    if (!isVisible()) {
      pendingParentScene = scene;
      return;
    }
    cancelArrival({ flatten: true });
    camera.cinematic = !reducedMotion.matches;
    const rendered = await navigate(scene, { userInitiated: true, remember: currentState !== scene, externalInitiated: true });
    if (rendered && currentState === scene) focusCameraOnAction(null, manifest.states[scene], { force: true });
  }

  window.addEventListener('message', (event) => {
    if (window.parent === window || event.source !== window.parent || event.origin !== window.location.origin) return;
    if (!event.data || event.data.type !== 'versepoint-showcase-scene' || typeof event.data.scene !== 'string') return;
    if (!ready) {
      pendingParentScene = event.data.scene;
      load();
    } else if (manifest.states[event.data.scene]) navigateParentScene(event.data.scene);
  });

  async function load() {
    if (loading || ready || !isVisible()) return;
    loading = true;
    try {
      const response = await fetch('states.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Manifest unavailable');
      manifest = await response.json();
      if (!manifest || typeof manifest.initial !== 'string' || !manifest.states?.[manifest.initial]) throw new Error('Manifest invalid');
      const requested = requestedState();
      const rendered = await navigate(manifest.states[requested] ? requested : manifest.initial);
      if (!rendered) throw new Error('Initial screen unavailable');
      ready = true;
      notifyParent('versepoint-showcase-ready');
      const scene = pendingParentScene;
      pendingParentScene = null;
      if (scene && manifest.states[scene]) await navigateParentScene(scene);
      else startArrivalIfVisible();
    } catch {
      showError('The application preview could not load. You can continue exploring VersePoint on the page.');
    } finally {
      loading = false;
    }
  }

  if (arrivalVisible) visibilityChanged();
})();
