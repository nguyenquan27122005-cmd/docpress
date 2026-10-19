// Isolated-world relay: MAIN cannot call chrome.runtime directly.
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || typeof event.data !== "object") return;
  const { id, url } = event.data;
  if (!Number.isSafeInteger(id) || id < 1) return;
  if (event.data.type === "doc2pdf-fetch-cancel") {
    chrome.runtime.sendMessage({ type: "doc2pdf-fetch-cancel", id }, () => void chrome.runtime.lastError);
    return;
  }
  if (event.data.type !== "doc2pdf-fetch" || typeof url !== "string") return;

  chrome.runtime.sendMessage({ type: "doc2pdf-fetch", id, url }, (response) => {
    const error = chrome.runtime.lastError?.message;
    window.postMessage(
      error
        ? { type: "doc2pdf-fetch-result", id, error }
        : {
            type: "doc2pdf-fetch-result",
            id,
            ...(response || { error: "Không có phản hồi" }),
          },
      location.origin
    );
  });
});
