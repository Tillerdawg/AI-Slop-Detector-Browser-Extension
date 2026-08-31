/**
 * Cross-browser WebExtension API shim. Firefox exposes the promise-based
 * `browser` global natively; Chrome (MV3, v88+) exposes `chrome` whose
 * storage/runtime/tabs methods already return a Promise when no callback is
 * passed. So `browser || chrome` is enough -- no polyfill dependency needed.
 *
 * Read as bare identifiers, not as properties of `root` -- in Firefox content
 * scripts `browser`/`chrome` are injected into the scope chain but are NOT
 * properties of `window`/`self` (https://bugzilla.mozilla.org/show_bug.cgi?id=1502726),
 * so `root.browser` is undefined there even though plain `browser` works.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});
  /* eslint-disable no-undef */
  AISlop.browserApi =
    typeof browser !== 'undefined' ? browser : typeof chrome !== 'undefined' ? chrome : undefined;
  /* eslint-enable no-undef */
})(typeof self !== 'undefined' ? self : this);
