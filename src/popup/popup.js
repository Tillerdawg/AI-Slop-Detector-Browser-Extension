(function () {
  const AISlop = window.AISlop;
  const C = AISlop.constants;
  const api = AISlop.browserApi;

  const resultArea = document.getElementById('result-area');

  function bandInfo(band) {
    return C.RATING_BANDS[band] || C.RATING_BANDS.uncertain;
  }

  function setResultHtml(html) {
    resultArea.innerHTML = html;
  }

  function renderMessage(text) {
    setResultHtml(`<p class="muted">${text}</p>`);
  }

  function renderResult(result) {
    const info = bandInfo(result.band);
    const reasons = (result.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('');
    setResultHtml(`
      <div class="result-band" style="color:${info.color}">
        <span>${info.emoji}</span><span>${info.label}</span>
      </div>
      <p class="reasons-intro">Reasons for this categorization:</p>
      <ul class="result-reasons">${reasons}</ul>
    `);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function getActiveTab() {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  async function refreshResult() {
    const tab = await getActiveTab();
    if (!tab || !tab.url) return renderMessage('No active tab.');
    let url;
    try {
      url = new URL(tab.url);
    } catch (e) {
      return renderMessage('No active tab.');
    }
    const host = url.hostname.replace(/^m\./, '');
    if (host !== 'www.youtube.com' && host !== 'youtube.com') {
      return renderMessage('Open a YouTube video to see its rating.');
    }
    if (url.pathname !== '/watch') {
      return renderMessage('Open a specific video (not a feed/search page) to see its rating here. Thumbnail badges still work on this page if enabled below.');
    }
    renderMessage('Loading…');
    let resp;
    try {
      resp = await api.tabs.sendMessage(tab.id, { type: C.MESSAGE_TYPES.PING_CURRENT });
    } catch (e) {
      resp = null;
    }
    if (resp && resp.result) {
      renderResult(resp.result);
    } else {
      renderMessage('No rating yet for this video (still loading, or the extension is disabled).');
    }
  }

  function wireToggle(id, key) {
    const el = document.getElementById(id);
    el.addEventListener('change', async () => {
      await AISlop.storage.setSettings({ [key]: el.checked });
    });
  }

  async function loadSettingsUI() {
    const settings = await AISlop.storage.getSettings();
    document.getElementById('toggle-enabled').checked = settings.enabled;
    document.getElementById('toggle-watch').checked = settings.showOnWatchPage;
    document.getElementById('toggle-thumbs').checked = settings.showOnThumbnails;
  }

  wireToggle('toggle-enabled', 'enabled');
  wireToggle('toggle-watch', 'showOnWatchPage');
  wireToggle('toggle-thumbs', 'showOnThumbnails');

  document.getElementById('open-options').addEventListener('click', () => {
    if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
  });

  loadSettingsUI();
  refreshResult();
})();
