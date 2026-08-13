// AURUM branded loading overlay controller
// Exposes AURUM.Loader.show() / AURUM.Loader.hide()

(function () {
  window.AURUM = window.AURUM || {};

  let overlayEl = null;
  let showTimestamp = 0;
  const MIN_VISIBLE_MS = 400; // avoid a jarring flash on fast navigations

  function ensureOverlay() {
    if (overlayEl) return overlayEl;

    overlayEl = document.createElement('div');
    overlayEl.id = 'aurum-loader';
    overlayEl.className = 'aurum-loader--hidden';
    overlayEl.innerHTML = `
      <div class="aurum-loader__mark">
        <img src="favicon-512x512.png" alt="" />
        <div class="aurum-loader__shimmer"></div>
      </div>
      <div class="aurum-loader__label">AURUM</div>
    `;
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function show() {
    const el = ensureOverlay();
    showTimestamp = Date.now();
    el.classList.remove('aurum-loader--hidden');
  }

  function hide() {
    const el = ensureOverlay();
    const elapsed = Date.now() - showTimestamp;
    const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
    setTimeout(() => {
      el.classList.add('aurum-loader--hidden');
    }, wait);
  }

  window.AURUM.Loader = { show, hide };
})();
