(function () {
  const AISlop = window.AISlop;

  const els = {
    enabled: document.getElementById('enabled'),
    showOnWatchPage: document.getElementById('showOnWatchPage'),
    showOnThumbnails: document.getElementById('showOnThumbnails'),
    strictness: document.getElementById('strictness'),
    useChannelCadence: document.getElementById('useChannelCadence'),
    youtubeApiKey: document.getElementById('youtubeApiKey'),
    testApiKey: document.getElementById('testApiKey'),
    apiKeyStatus: document.getElementById('apiKeyStatus'),
    overridesList: document.getElementById('overridesList'),
    overridesEmpty: document.getElementById('overridesEmpty'),
    cacheStats: document.getElementById('cacheStats'),
    clearCache: document.getElementById('clearCache'),
    savedNote: document.getElementById('savedNote'),
  };

  let savedNoteTimer = null;
  function flashSaved() {
    els.savedNote.hidden = false;
    clearTimeout(savedNoteTimer);
    savedNoteTimer = setTimeout(() => (els.savedNote.hidden = true), 1200);
  }

  async function save(partial) {
    await AISlop.storage.setSettings(partial);
    flashSaved();
  }

  async function loadSettings() {
    const s = await AISlop.storage.getSettings();
    els.enabled.checked = s.enabled;
    els.showOnWatchPage.checked = s.showOnWatchPage;
    els.showOnThumbnails.checked = s.showOnThumbnails;
    els.strictness.value = s.strictness;
    els.useChannelCadence.checked = s.useChannelCadence;
    els.youtubeApiKey.value = s.youtubeApiKey || '';
  }

  els.enabled.addEventListener('change', () => save({ enabled: els.enabled.checked }));
  els.showOnWatchPage.addEventListener('change', () => save({ showOnWatchPage: els.showOnWatchPage.checked }));
  els.showOnThumbnails.addEventListener('change', () => save({ showOnThumbnails: els.showOnThumbnails.checked }));
  els.strictness.addEventListener('change', () => save({ strictness: els.strictness.value }));
  els.useChannelCadence.addEventListener('change', () => save({ useChannelCadence: els.useChannelCadence.checked }));
  els.youtubeApiKey.addEventListener('change', () => save({ youtubeApiKey: els.youtubeApiKey.value.trim() }));

  els.testApiKey.addEventListener('click', async () => {
    els.apiKeyStatus.textContent = 'Testing…';
    const key = els.youtubeApiKey.value.trim();
    const result = await AISlop.dataApi.testApiKey(key);
    els.apiKeyStatus.textContent = result.ok ? '✅ ' + result.message : '❌ ' + result.message;
  });

  async function renderOverrides() {
    const overrides = await AISlop.storage.getOverrides();
    const entries = Object.entries(overrides);
    els.overridesList.innerHTML = '';
    els.overridesEmpty.hidden = entries.length > 0;
    for (const [channelId, o] of entries) {
      const li = document.createElement('li');
      const label = (o.channelTitle || channelId) + ' — ' + (o.trusted ? '✅ trusted' : o.flagged ? '🚩 flagged' : '');
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        await AISlop.storage.setOverride(channelId, null);
        renderOverrides();
      });
      const span = document.createElement('span');
      span.textContent = label;
      li.appendChild(span);
      li.appendChild(removeBtn);
      els.overridesList.appendChild(li);
    }
  }

  async function renderCacheStats() {
    const stats = await AISlop.storage.cacheStats();
    els.cacheStats.textContent = `${stats.scoreEntries} cached video scores, ${stats.channelEntries} cached channel lookups.`;
  }

  els.clearCache.addEventListener('click', async () => {
    await AISlop.storage.clearCaches();
    await renderCacheStats();
    flashSaved();
  });

  loadSettings();
  renderOverrides();
  renderCacheStats();
})();
