/**
 * Runs inside a sandboxed extension page (see manifest `sandbox.pages`).
 * MV3 forbids remote script in normal extension pages, so the Turnstile
 * widget -- which loads its own script from challenges.cloudflare.com --
 * has to live here instead, communicating with options.js only via
 * postMessage (sandboxed pages get no chrome.* API access).
 */
(function () {
  function getSiteKey() {
    const params = new URLSearchParams(window.location.search);
    return params.get('sitekey') || '';
  }

  function post(data) {
    window.parent.postMessage(Object.assign({ source: 'aislop-turnstile' }, data), '*');
  }

  // The remote Turnstile script may never load (blocked remote script, CDN
  // down, or a browser whose extension-page CSP forbids it -- e.g. Firefox,
  // which has no Chrome-style sandboxed pages). Give up loudly instead of
  // polling forever with no diagnostics.
  const MAX_LOAD_ATTEMPTS = 50; // ~10s at 200ms/attempt

  function render(attempt) {
    attempt = attempt || 0;
    const siteKey = getSiteKey();
    if (!siteKey) {
      post({ error: 'missing_sitekey' });
      return;
    }
    if (typeof window.turnstile === 'undefined') {
      if (attempt >= MAX_LOAD_ATTEMPTS) {
        post({ error: 'turnstile_load_failed' });
        return;
      }
      setTimeout(() => render(attempt + 1), 200);
      return;
    }
    window.turnstile.render('#turnstile-widget', {
      sitekey: siteKey,
      callback: (token) => post({ turnstileToken: token }),
      'error-callback': () => post({ error: 'turnstile_error' }),
    });
  }

  render();
})();
