/* Bridges the page world to the extension.
 *
 * hook.js runs in the page's world so it can wrap XMLHttpRequest, but that
 * world has no chrome.* APIs. This script has them, so it listens for the
 * hook's postMessage and forwards it.
 */

window.addEventListener("message", (event) => {
  // Only trust messages this page posted to itself. Without both checks any
  // frame or script on the page could inject fake payloads.
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "panopto-grab" || data.kind !== "deliveryinfo") return;
  if (typeof data.body !== "string") return;

  chrome.runtime.sendMessage(
    { type: "deliveryinfo", url: String(data.url || ""), body: data.body },
    () => void chrome.runtime.lastError, // worker may be asleep; nothing to handle
  );
});
