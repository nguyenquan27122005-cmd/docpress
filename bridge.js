// Isolated world: MAIN không gọi được chrome.runtime (CORS chặn fetch CDN).
window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.data?.type !== "doc2pdf-fetch") return;
  const { id, url } = ev.data;
  chrome.runtime.sendMessage({ type: "doc2pdf-fetch", url }, (res) => {
    const err = chrome.runtime.lastError?.message;
    window.postMessage(
      err
        ? { type: "doc2pdf-fetch-result", id, error: err }
        : { type: "doc2pdf-fetch-result", id, ...(res || { error: "empty" }) },
      "*"
    );
  });
});
