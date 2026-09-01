(function () {
  const AISlop = window.AISlop;
  const C = AISlop.constants;
  const api = AISlop.browserApi;

  const resultArea = document.getElementById('result-area');

  function bandInfo(band) {
    return C.RATING_BANDS[band] || C.RATING_BANDS.uncertain;
  }

  function clearResultArea() {
    while (resultArea.firstChild) resultArea.removeChild(resultArea.firstChild);
  }

  function renderMessage(text) {
    clearResultArea();
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = text;
    resultArea.appendChild(p);
  }

  function renderResult(result) {
    const info = bandInfo(result.band);
    clearResultArea();

    const bandDiv = document.createElement('div');
    bandDiv.className = 'result-band';
    bandDiv.style.color = info.color;
    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = info.emoji;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = info.label;
    bandDiv.appendChild(emojiSpan);
    bandDiv.appendChild(labelSpan);

    const intro = document.createElement('p');
    intro.className = 'reasons-intro';
    intro.textContent = 'Reasons for this categorization:';

    const list = document.createElement('ul');
    list.className = 'result-reasons';
    for (const reason of result.reasons || []) {
      const li = document.createElement('li');
      li.textContent = reason;
      list.appendChild(li);
    }

    resultArea.appendChild(bandDiv);
    resultArea.appendChild(intro);
    resultArea.appendChild(list);
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
