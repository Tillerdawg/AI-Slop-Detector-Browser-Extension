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

  function buildReasonsList(result) {
    const list = document.createElement('ul');
    list.className = 'aislop-panel__reasons';
    for (const reason of result.reasons || []) {
      const li = document.createElement('li');
      li.textContent = reason;
      list.appendChild(li);
    }
    return list;
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

    // Re-renders (e.g. right after clicking a trust/flag/clear-override
    // button) tear down and rebuild the whole panel -- preserve whether the
    // "Why?" section was open so that rebuild doesn't visibly collapse it.
    const existing = document.getElementById(PANEL_ID);
    const wasExpanded = !!existing && existing.querySelector('.aislop-panel__toggle')?.getAttribute('aria-expanded') === 'true';

    removePanel();
    const info = bandInfo(result.band);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'aislop-panel aislop-panel--' + result.band;
    panel.style.setProperty('--aislop-color', info.color);

    const header = document.createElement('div');
    header.className = 'aislop-panel__header';

    const emojiSpan = document.createElement('span');
    emojiSpan.className = 'aislop-panel__emoji';
    emojiSpan.textContent = info.emoji;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'aislop-panel__label';
    labelSpan.textContent = info.label;

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'aislop-panel__toggle';
    toggleBtn.setAttribute('aria-expanded', String(wasExpanded));
    toggleBtn.title = 'Show details';
    toggleBtn.textContent = 'Why?';

    header.appendChild(emojiSpan);
    header.appendChild(labelSpan);
    header.appendChild(toggleBtn);

    const body = document.createElement('div');
    body.className = 'aislop-panel__body';
    body.hidden = !wasExpanded;

    const reasonsIntro = document.createElement('p');
    reasonsIntro.className = 'aislop-panel__reasons-intro';
    reasonsIntro.textContent = 'Reasons for this categorization:';
    body.appendChild(reasonsIntro);

    body.appendChild(buildReasonsList(result));

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
      trustBtn.textContent = '✅ Mark video as human-made';
      trustBtn.addEventListener('click', () => handlers.onMarkTrusted && handlers.onMarkTrusted());

      const flagBtn = document.createElement('button');
      flagBtn.type = 'button';
      flagBtn.textContent = '🚩 Mark video as AI slop';
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

    toggleBtn.addEventListener('click', (e) => {
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
