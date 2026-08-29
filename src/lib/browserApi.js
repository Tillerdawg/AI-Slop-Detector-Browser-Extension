/**
 * Cross-browser WebExtension API shim. Firefox exposes the promise-based
 * `browser` global natively; Chrome (MV3, v88+) exposes `chrome` whose
 * storage/runtime/tabs methods already return a Promise when no callback is
 * passed. So `browser || chrome` is enough -- no polyfill dependency needed.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});
  AISlop.browserApi = (typeof root.browser !== 'undefined' ? root.browser : root.chrome);
})(typeof self !== 'undefined' ? self : this);
