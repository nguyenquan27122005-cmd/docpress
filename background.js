// Service worker: unblur cookie + proxy fetch CDN (MAIN world bị CORS).
importScripts("lib.js");

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "doc2pdf-fetch") return;
  if (
    typeof msg.url !== "string" ||
    !doc2pdf.isAllowedFetch(sender.url, msg.url)
  ) {
    sendResponse({ error: "Yêu cầu tải bị chặn" });
    return;
  }

  const controller = new AbortController();
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
