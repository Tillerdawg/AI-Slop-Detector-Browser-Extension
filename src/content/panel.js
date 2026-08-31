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

  function buildBreakdownSection(result) {
    const section = document.createElement('div');
    section.className = 'aislop-panel__breakdown';

    const legend = document.createElement('p');
    legend.className = 'aislop-panel__legend';
    legend.textContent = C.SCORE_LEGEND.scale;
    section.appendChild(legend);

    const confidenceLegend = document.createElement('p');
    confidenceLegend.className = 'aislop-panel__legend';
    confidenceLegend.textContent =
      C.SCORE_LEGEND.confidence + ` Gathered ${result.totalWeight}/100 possible evidence weight for this video.`;
    section.appendChild(confidenceLegend);

    const scoreColumnLegend = document.createElement('p');
    scoreColumnLegend.className = 'aislop-panel__legend';
    scoreColumnLegend.textContent =
      'A numeric Score means that signal was checked (0 = checked, nothing suspicious found). Text in that column means it couldn\'t be checked for this video, and why.';
    section.appendChild(scoreColumnLegend);

    const table = document.createElement('table');
    table.className = 'aislop-panel__breakdown-table';

    const headerRow = document.createElement('tr');
    for (const heading of ['Category', 'Weight', 'Score']) {
      const th = document.createElement('th');
      th.textContent = heading;
      headerRow.appendChild(th);
    }
    table.appendChild(headerRow);

    let contributionSum = 0;
    for (const item of result.breakdown) {
      const row = document.createElement('tr');
      const labelCell = document.createElement('td');
      labelCell.textContent = item.label;
      const weightCell = document.createElement('td');
      weightCell.textContent = String(item.maxWeight);
      const scoreCell = document.createElement('td');
      if (item.evaluated) {
        contributionSum += item.contribution;
        scoreCell.textContent = String(item.contribution);
      } else {
        scoreCell.textContent = item.hint || 'not enough data';
        row.className = 'aislop-panel__breakdown-unevaluated';
      }
      row.appendChild(labelCell);
      row.appendChild(weightCell);
      row.appendChild(scoreCell);
      table.appendChild(row);
    }

    const totalRow = document.createElement('tr');
    totalRow.className = 'aislop-panel__breakdown-total';
    const totalLabelCell = document.createElement('td');
    totalLabelCell.textContent = 'Total (of gathered evidence)';
    const totalWeightCell = document.createElement('td');
    totalWeightCell.textContent = String(result.totalWeight);
    const totalScoreCell = document.createElement('td');
    totalScoreCell.textContent = String(contributionSum);
    totalRow.appendChild(totalLabelCell);
    totalRow.appendChild(totalWeightCell);
    totalRow.appendChild(totalScoreCell);
    table.appendChild(totalRow);

    section.appendChild(table);

    return section;
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
      <span class="aislop-panel__score">${AISlop.heuristics.formatScore(result.score)}</span>
      <span class="aislop-panel__confidence">confidence: ${result.confidence}</span>
      <button type="button" class="aislop-panel__toggle" aria-expanded="false" title="Show details">Why?</button>
    `;

    const body = document.createElement('div');
    body.className = 'aislop-panel__body';
    body.hidden = true;

    if (result.breakdown && result.breakdown.length > 0) {
      body.appendChild(buildBreakdownSection(result));
    }

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
