// Service worker: unblur cookie + proxy fetch CDN (MAIN world bị CORS).
importScripts("lib.js");

const FETCH_HOST =
  /(^|\.)(studocu\.com|studocu\.id|studocu\.vn|studeersnel\.nl|scribd\.com|scribdassets\.com)$/;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "doc2pdf-fetch" || typeof msg.url !== "string") return;
  let host;
  try {
    host = new URL(msg.url).hostname;
  } catch {
    sendResponse({ error: "bad url" });
    return true;
  }
  if (!FETCH_HOST.test(host)) {
    sendResponse({ error: "host" });
    return true;
  }
  fetch(msg.url)
    .then(async (r) => sendResponse({ status: r.status, text: await r.text() }))
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

// Xoá "sd_docs" ngay khi được ghi — cookie đếm lượt xem preview, không phải
// cookie đăng nhập. Theo mẫu chrome-extensions-samples (Apache-2.0), cùng cách
// studotools làm. Bỏ qua chính lúc bị xoá để không lặp vô hạn.
chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.cookie.name === "sd_docs" && !changeInfo.removed) {
    chrome.cookies.remove({
      url: doc2pdf.cookieUrl(changeInfo.cookie),
      name: "sd_docs",
      storeId: changeInfo.cookie.storeId,
    });
  }
});
