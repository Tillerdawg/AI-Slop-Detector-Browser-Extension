/**
 * The detail card injected near the video title on the watch page.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});
  const C = AISlop.constants;

  const PANEL_ID = 'aislop-watch-panel';

  function bandInfo(band) {
    return C.RATING_BANDS[band] || C.RATING_BANDS.uncertain;
  }

  function findMountPoint() {
    // Prefer the modern "above the fold" title/info container; fall back to
    // the raw <h1> wrapper if the layout has changed under us.
    return (
      document.querySelector('#above-the-fold') ||
      document.querySelector('ytd-watch-metadata') ||
      document.querySelector('#title.ytd-watch-metadata') ||
      document.querySelector('h1.ytd-watch-metadata')?.closest('div') ||
      null
    );
  }

  function removePanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();
  }

  /**
   * @param {object} result heuristics.scoreVideo() output
   * @param {object} handlers { onMarkTrusted, onMarkFlagged, onClearOverride }
   */
  function renderWatchPanel(result, handlers) {
    handlers = handlers || {};
    const mount = findMountPoint();
    if (!mount) return false;

    removePanel();
    const info = bandInfo(result.band);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'aislop-panel aislop-panel--' + result.band;
    panel.style.setProperty('--aislop-color', info.color);

    const header = document.createElement('div');
    header.className = 'aislop-panel__header';
    header.innerHTML = `
      <span class="aislop-panel__emoji">${info.emoji}</span>
      <span class="aislop-panel__label">${info.label}</span>
      <span class="aislop-panel__score">${result.score}/100</span>
      <span class="aislop-panel__confidence">confidence: ${result.confidence}</span>
      <button type="button" class="aislop-panel__toggle" aria-expanded="false" title="Show details">Why?</button>
    `;

    const body = document.createElement('div');
    body.className = 'aislop-panel__body';
    body.hidden = true;
    const list = document.createElement('ul');
    for (const reason of result.reasons || []) {
      const li = document.createElement('li');
      li.textContent = reason;
      list.appendChild(li);
    }
    body.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'aislop-panel__actions';
    if (result.overridden) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'Remove manual override';
      clearBtn.addEventListener('click', () => handlers.onClearOverride && handlers.onClearOverride());
      actions.appendChild(clearBtn);
    } else {
      const trustBtn = document.createElement('button');
      trustBtn.type = 'button';
      trustBtn.textContent = '✅ Mark channel as human-made';
      trustBtn.addEventListener('click', () => handlers.onMarkTrusted && handlers.onMarkTrusted());

      const flagBtn = document.createElement('button');
      flagBtn.type = 'button';
      flagBtn.textContent = '🚩 Mark channel as AI slop';
      flagBtn.addEventListener('click', () => handlers.onMarkFlagged && handlers.onMarkFlagged());

      actions.appendChild(trustBtn);
      actions.appendChild(flagBtn);
    }
    body.appendChild(actions);

    const note = document.createElement('p');
    note.className = 'aislop-panel__note';
    note.textContent = 'Heuristic estimate based on public metadata (upload pattern, title/description text, and YouTube\'s own content-disclosure label where present). Not a certainty.';
    body.appendChild(note);

    panel.appendChild(header);
    panel.appendChild(body);

    header.querySelector('.aislop-panel__toggle').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      body.hidden = expanded;
    });

    mount.insertAdjacentElement('afterend', panel);
    return true;
  }

  AISlop.panel = { renderWatchPanel, removePanel };
})(typeof self !== 'undefined' ? self : this);
