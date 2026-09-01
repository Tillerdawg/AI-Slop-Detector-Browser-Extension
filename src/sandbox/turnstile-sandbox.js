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

  function render() {
    const siteKey = getSiteKey();
    if (!siteKey) {
      post({ error: 'missing_sitekey' });
      return;
    }
    if (typeof window.turnstile === 'undefined') {
      setTimeout(render, 200);
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
