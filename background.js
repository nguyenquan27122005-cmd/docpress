// Service worker: unblur cookie + proxy fetch CDN (MAIN world bị CORS).
importScripts("lib.js");

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;
const activeRequests = new Map();

function requestKey(sender, id) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  const documentId = sender.documentId;
  if (
    !Number.isSafeInteger(id) || id < 1 ||
    !Number.isSafeInteger(tabId) || tabId < 0 ||
    !Number.isSafeInteger(frameId) || frameId < 0 ||
    typeof documentId !== "string" || !documentId
  ) {
    return "";
  }
  return tabId + ":" + frameId + ":" + documentId + ":" + id;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const key = requestKey(sender, msg?.id);
  if (msg?.type === "doc2pdf-fetch-cancel") {
    if (key) activeRequests.get(key)?.abort();
    return;
  }
  if (msg?.type !== "doc2pdf-fetch") return;
  if (
    !key || activeRequests.has(key) ||
    typeof msg.url !== "string" ||
    !doc2pdf.isAllowedFetch(sender.url, msg.url)
  ) {
    sendResponse({ error: "Yêu cầu tải bị chặn" });
    return;
  }

  const controller = new AbortController();
  activeRequests.set(key, controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  (async () => {
    try {
      const response = await fetch(msg.url, {
        credentials: "include",
        redirect: "error",
        signal: controller.signal,
      });
      const text = await doc2pdf.responseTextWithinLimit(
        response,
        MAX_RESPONSE_BYTES
      );
      sendResponse({ status: response.status, text });
    } catch (error) {
      sendResponse({
        error: timedOut
          ? "Hết thời gian tải"
          : String(error?.message || error || "Lỗi mạng"),
      });
    } finally {
      if (activeRequests.get(key) === controller) activeRequests.delete(key);
      controller.abort();
      clearTimeout(timer);
    }
  })();
  return true;
});

chrome.cookies.onChanged.addListener((changeInfo) => {
  const cookie = changeInfo.cookie;
  if (
    changeInfo.removed ||
    cookie.name !== "sd_docs" ||
    !doc2pdf.isScribdCookieDomain(cookie.domain)
  ) {
    return;
  }

  chrome.storage.local.get({ unblurEnabled: true }, ({ unblurEnabled }) => {
    if (chrome.runtime.lastError || !unblurEnabled) return;
    chrome.cookies.remove(
      {
        url: doc2pdf.cookieUrl(cookie),
        name: "sd_docs",
        storeId: cookie.storeId,
      },
      () => void chrome.runtime.lastError
    );
  });
});
