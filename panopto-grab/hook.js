/* Runs in the page's own JavaScript world.
 *
 * chrome.webRequest exposes headers and URLs but never response bodies, and
 * DeliveryInfo is a POST whose body carries everything useful: duration, slide
 * timings, the podcast MP4 URL, whether captions exist. So the only way to read
 * it is to wrap the transport the page itself uses.
 *
 * This world has no chrome.* access, so findings go out via postMessage and
 * relay.js forwards them.
 */

(() => {
  const MARK = "__panoptoGrabHooked";
  if (window[MARK]) return;
  window[MARK] = true;

  const TARGET = /\/DeliveryInfo\.aspx/i;

  function publish(url, body) {
    if (typeof body !== "string" || body.length < 2) return;
    try {
      window.postMessage({ source: "panopto-grab", kind: "deliveryinfo", url, body }, window.location.origin);
    } catch {
      // Body too large to structured-clone, or origin mismatch. Nothing to do.
    }
  }

  // XMLHttpRequest — what the Panopto viewer actually uses.
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this[MARK + "Url"] = String(url);
    } catch { /* frozen instance */ }
    return open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this[MARK + "Url"] || "";
      if (TARGET.test(url)) {
        this.addEventListener("load", () => {
          try {
            // responseType "json" gives an object, not text.
            const body = this.responseType === "json"
              ? JSON.stringify(this.response)
              : this.responseText;
            publish(url, body);
          } catch { /* cross-origin or unreadable */ }
        });
      }
    } catch { /* never break the page */ }
    return send.apply(this, args);
  };

  // fetch, in case a future viewer build switches transport.
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const promise = originalFetch.call(this, input, init);
      if (!TARGET.test(url)) return promise;
      return promise.then((response) => {
        try {
          response.clone().text().then((body) => publish(url, body)).catch(() => {});
        } catch { /* body already consumed */ }
        return response;
      });
    };
  }
})();
