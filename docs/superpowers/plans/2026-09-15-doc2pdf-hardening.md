# doc2pdf Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Harden doc2pdf for long documents, SPA navigation, privileged fetches, controllable unblur behavior, and reliable releases while preserving its dependency-free raster PDF engine.

**Architecture:** Keep provider extraction and export in the existing main-world content script, keep the isolated bridge as a narrow relay, and make the background worker the validated privileged boundary. Move all range, quality, domain, cookie, and response-size rules into pure lib.js helpers so the existing Node self-check can drive the implementation test-first.

**Tech Stack:** Chromium Manifest V3, classic JavaScript, DOM and Chrome extension APIs, html2canvas 1.4.1, Node.js self-tests, Chrome DevTools Protocol live test, Git, PowerShell ZIP packaging.

**Spec:** docs/superpowers/specs/2026-09-15-doc2pdf-hardening-design.md

## Global Constraints

- Keep PDF output raster-based; searchable/selectable text is out of scope.
- Add no package manager, build system, PDF library, queue dependency, or UI framework.
- Support one contiguous inclusive From/To page range.
- Auto quality is High for 1-40 selected pages, Balanced for 41-100, and Small above 100.
- High is scale 2 and JPEG quality 0.92; Balanced is scale 1.5 and 0.88; Small is scale 1 and 0.80.
- Run no more than four image downloads concurrently.
- Accept bridge fetches only over HTTPS, within the sender's provider family, for at most 20 seconds and 5 MiB.
- Default unblur to enabled for backward compatibility, but allow the user to disable it.
- Never download partial PDFs or the old unreliable HTML fallback.
- Preserve UTF-8 without BOM, LF endings, and zero trailing whitespace.

---

## File Map

- Modify lib.js: pure range, quality, request, response-size, and cookie-domain policies.
- Modify test.mjs: dependency-free regression tests for every new pure policy.
- Modify background.js: bounded sender-aware fetch and guarded cookie removal.
- Modify bridge.js: strict message shape and origin-targeted replies.
- Modify manifest.json: storage permission, action popup, and version 1.2.0.
- Create popup.html: accessible unblur setting UI.
- Create popup.js: load and persist unblurEnabled.
- Modify content.js: shadow-DOM controls, SPA lifecycle, cancellation, selected-page extraction, and one-page-at-a-time rendering.
- Modify real-test.mjs: require the new widget controls and a successful PDF probe.
- Modify README.md: user controls, quality policy, limitations, tests, and release smoke checklist.
- Replace doc2pdf.zip: package the exact 1.2.0 runtime files and README.

---

### Task 1: Add Pure Export and Security Policies

**Files:**
- Modify: test.mjs
- Modify: lib.js

**Interfaces:**
- Produces: qualitySettings(preset, selectedPageCount) -> { key, scale, jpegQuality }
- Produces: pageRange(fromValue, toValue, totalPages) -> { from, to, count }
- Produces: isAllowedFetch(senderUrl, requestUrl) -> boolean
- Produces: isScribdCookieDomain(domain) -> boolean
- Produces: responseTextWithinLimit(response, maxBytes) -> Promise<string>
- Consumes: isDocPath(pathname, site), already in lib.js

- [ ] **Step 1: Add failing test helpers and policy cases**

Add these names to the destructuring assignment near the top of test.mjs:

~~~js
  qualitySettings,
  pageRange,
  isAllowedFetch,
  isScribdCookieDomain,
  responseTextWithinLimit,
~~~

Add this rejection helper after check:

~~~js
async function checkRejects(name, fn, message) {
  try {
    await fn();
    check(name, "resolved", "rejected");
  } catch (error) {
    check(name, String(error?.message || error).includes(message), true);
  }
}
~~~

Add these cases before the existing mapPool tests:

~~~js
check("quality high", qualitySettings("high", 200), {
  key: "high",
  scale: 2,
  jpegQuality: 0.92,
});
check("quality balanced", qualitySettings("balanced", 1), {
  key: "balanced",
  scale: 1.5,
  jpegQuality: 0.88,
});
check("quality small", qualitySettings("small", 1), {
  key: "small",
  scale: 1,
  jpegQuality: 0.8,
});
check("quality auto 40", qualitySettings("auto", 40).key, "high");
check("quality auto 41", qualitySettings("auto", 41).key, "balanced");
check("quality auto 100", qualitySettings("auto", 100).key, "balanced");
check("quality auto 101", qualitySettings("auto", 101).key, "small");
check("quality unknown -> auto", qualitySettings("wat", 10).key, "high");

check("range defaults", pageRange("", "", 12), { from: 1, to: 12, count: 12 });
check("range selected", pageRange("3", "7", 12), { from: 3, to: 7, count: 5 });
check("range clamps end", pageRange(8, 99, 12), { from: 8, to: 12, count: 5 });
await checkRejects("range reversed", () => pageRange(8, 3, 12), "đầu");
await checkRejects("range fraction", () => pageRange(1.5, 3, 12), "số nguyên");
await checkRejects("range starts past total", () => pageRange(13, "", 12), "12");

check(
  "fetch scribd asset",
  isAllowedFetch(
    "https://www.scribd.com/document/1/title",
    "https://html.scribdassets.com/a/pages/1-x.jsonp"
  ),
  true
);
check(
  "fetch studocu asset",
  isAllowedFetch(
    "https://www.studocu.com/en/document/x",
    "https://cdn.studocu.com/a/1.page"
  ),
  true
);
check(
  "fetch rejects HTTP",
  isAllowedFetch(
    "https://www.scribd.com/document/1/title",
    "http://html.scribdassets.com/a"
  ),
  false
);
check(
  "fetch rejects cross-provider",
  isAllowedFetch(
    "https://www.scribd.com/document/1/title",
    "https://www.studocu.com/document/x"
  ),
  false
);
check(
  "fetch rejects lookalike",
  isAllowedFetch(
    "https://www.scribd.com/document/1/title",
    "https://scribdassets.com.evil.test/a"
  ),
  false
);
check(
  "fetch rejects non-document sender",
  isAllowedFetch("https://www.scribd.com/search", "https://www.scribd.com/a"),
  false
);
check("fetch rejects malformed URL", isAllowedFetch("bad", "also bad"), false);

check("cookie scribd root", isScribdCookieDomain("scribd.com"), true);
check("cookie scribd dotted", isScribdCookieDomain(".www.scribd.com"), true);
check("cookie lookalike", isScribdCookieDomain("evil-scribd.com"), false);
check("cookie other provider", isScribdCookieDomain(".studocu.com"), false);

check(
  "response under byte limit",
  await responseTextWithinLimit(new Response("abc"), 3),
  "abc"
);
await checkRejects(
  "response Content-Length too large",
  () =>
    responseTextWithinLimit(
      new Response("abc", { headers: { "content-length": "99" } }),
      3
    ),
  "quá lớn"
);
await checkRejects(
  "response body too large",
  () => responseTextWithinLimit(new Response("abcd"), 3),
  "quá lớn"
);
~~~

- [ ] **Step 2: Run the self-check and verify it is red**

Run:

~~~powershell
node test.mjs
~~~

Expected: FAIL before completing because qualitySettings and the other new exports do not exist.

- [ ] **Step 3: Implement the pure policies in lib.js**

Insert the following after isDocPath:

~~~js
const QUALITY_PRESETS = {
  high: { key: "high", scale: 2, jpegQuality: 0.92 },
  balanced: { key: "balanced", scale: 1.5, jpegQuality: 0.88 },
  small: { key: "small", scale: 1, jpegQuality: 0.8 },
};

function qualitySettings(preset, selectedPageCount) {
  const requested = String(preset ?? "auto").toLowerCase();
  if (QUALITY_PRESETS[requested]) return { ...QUALITY_PRESETS[requested] };
  const count = Math.max(0, Number(selectedPageCount) || 0);
  const key = count > 100 ? "small" : count > 40 ? "balanced" : "high";
  return { ...QUALITY_PRESETS[key] };
}

function pageRange(fromValue, toValue, totalPages) {
  const total = Number(totalPages);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error("Tài liệu không có trang hợp lệ");
  }
  const from = fromValue === "" || fromValue == null ? 1 : Number(fromValue);
  const requestedTo = toValue === "" || toValue == null ? total : Number(toValue);
  if (!Number.isInteger(from) || !Number.isInteger(requestedTo)) {
    throw new Error("Trang bắt đầu và kết thúc phải là số nguyên");
  }
  if (from < 1 || requestedTo < 1) {
    throw new Error("Số trang phải từ 1 trở lên");
  }
  if (from > total) {
    throw new Error("Trang bắt đầu vượt quá " + total);
  }
  const to = Math.min(requestedTo, total);
  if (from > to) {
    throw new Error("Trang bắt đầu phải nhỏ hơn hoặc bằng trang kết thúc");
  }
  return { from, to, count: to - from + 1 };
}

const STUDOCU_DOMAINS = [
  "studocu.com",
  "studeersnel.nl",
  "studocu.id",
  "studocu.vn",
];

function domainMatches(hostname, domain) {
  const host = String(hostname ?? "").toLowerCase();
  return host === domain || host.endsWith("." + domain);
}

function providerFamily(url, sender = false) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (domainMatches(parsed.hostname, "scribd.com")) {
    if (sender && !isDocPath(parsed.pathname, "scribd")) return null;
    return "scribd";
  }
  if (!sender && domainMatches(parsed.hostname, "scribdassets.com")) return "scribd";
  if (STUDOCU_DOMAINS.some((domain) => domainMatches(parsed.hostname, domain))) {
    if (sender && !isDocPath(parsed.pathname, "studocu")) return null;
    return "studocu";
  }
  return null;
}

function isAllowedFetch(senderUrl, requestUrl) {
  const senderFamily = providerFamily(senderUrl, true);
  return !!senderFamily && senderFamily === providerFamily(requestUrl, false);
}

function isScribdCookieDomain(domain) {
  return domainMatches(String(domain ?? "").replace(/^\./, ""), "scribd.com");
}

async function responseTextWithinLimit(response, maxBytes) {
  const limit = Math.max(1, Number(maxBytes) || 1);
  const declared = Number(response.headers?.get("content-length") || 0);
  if (declared > limit) throw new Error("Phản hồi quá lớn");
  const body = await response.arrayBuffer();
  if (body.byteLength > limit) throw new Error("Phản hồi quá lớn");
  return new TextDecoder().decode(body);
}
~~~

Add the five public helpers to doc2pdf:

~~~js
  qualitySettings,
  pageRange,
  isAllowedFetch,
  isScribdCookieDomain,
  responseTextWithinLimit,
~~~

- [ ] **Step 4: Normalize the cookie removal URL**

Replace cookieUrl with:

~~~js
function cookieUrl(cookie) {
  const protocol = cookie.secure ? "https:" : "http:";
  const domain = String(cookie.domain ?? "").replace(/^\./, "");
  const path = String(cookie.path || "/");
  return protocol + "//" + domain + path;
}
~~~

Change the existing cookie secure expectation in test.mjs from
https://.scribd.com/ to https://scribd.com/.

- [ ] **Step 5: Run focused verification**

Run:

~~~powershell
node --check lib.js
node --check test.mjs
node test.mjs
~~~

Expected: all syntax checks exit 0 and every self-check passes.

- [ ] **Step 6: Commit the pure policy layer**

Run:

~~~powershell
git add lib.js test.mjs
git commit -m "feat: add export and security policies"
~~~

---

### Task 2: Harden the Privileged Boundary and Add the Unblur Setting

**Files:**
- Modify: background.js
- Modify: bridge.js
- Modify: manifest.json
- Create: popup.html
- Create: popup.js

**Interfaces:**
- Consumes: doc2pdf.isAllowedFetch(senderUrl, requestUrl)
- Consumes: doc2pdf.responseTextWithinLimit(response, maxBytes)
- Consumes: doc2pdf.isScribdCookieDomain(domain)
- Produces: chrome.runtime message response { status, text } or { error }
- Produces: chrome.storage.local key unblurEnabled: boolean

- [ ] **Step 1: Replace background fetch handling with a bounded sender-aware handler**

Keep importScripts("lib.js"), delete FETCH_HOST, and use this listener:

~~~js
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
~~~

- [ ] **Step 2: Guard cookie removal by setting and domain**

Replace the cookies.onChanged body with:

~~~js
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
~~~

- [ ] **Step 3: Validate bridge message shape and target the page origin**

Replace bridge.js with:

~~~js
// Isolated-world relay: MAIN cannot call chrome.runtime directly.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "doc2pdf-fetch") return;
  const { id, url } = event.data;
  if (!Number.isSafeInteger(id) || id < 1 || typeof url !== "string") return;

  chrome.runtime.sendMessage({ type: "doc2pdf-fetch", url }, (response) => {
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
~~~

Update content.js in the same commit so its two window.postMessage calls use location.origin rather than "*".

- [ ] **Step 4: Add the popup setting**

Create popup.html:

~~~html
<!doctype html>
<html lang="vi">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>doc2pdf</title>
    <style>
      body { width: 260px; margin: 0; padding: 14px; font: 14px/1.45 system-ui, sans-serif; color: #202124; }
      label { display: flex; gap: 9px; align-items: flex-start; font-weight: 600; }
      input { margin-top: 3px; }
      p { margin: 8px 0 0 25px; color: #5f6368; font-size: 12px; }
    </style>
  </head>
  <body>
    <label>
      <input id="unblur" type="checkbox">
      Tự bỏ giới hạn preview Scribd
    </label>
    <p>Chỉ xóa cookie sd_docs trên scribd.com. Không đụng cookie đăng nhập.</p>
    <script src="popup.js"></script>
  </body>
</html>
~~~

Create popup.js:

~~~js
"use strict";

const checkbox = document.getElementById("unblur");
chrome.storage.local.get({ unblurEnabled: true }, ({ unblurEnabled }) => {
  checkbox.checked = !!unblurEnabled;
});
checkbox.addEventListener("change", () => {
  chrome.storage.local.set({ unblurEnabled: checkbox.checked });
});
~~~

- [ ] **Step 5: Update manifest permissions, popup, and version**

Change permissions and add action:

~~~json
  "version": "1.2.0",
  "permissions": ["cookies", "storage"],
  "action": {
    "default_title": "doc2pdf",
    "default_popup": "popup.html"
  },
~~~

Keep all existing host permissions and content-script declarations unchanged.

- [ ] **Step 6: Run focused verification**

Run:

~~~powershell
node --check background.js
node --check bridge.js
node --check popup.js
Get-Content -Raw -Encoding utf8 manifest.json | ConvertFrom-Json | Out-Null
node test.mjs
~~~

Expected: every command exits 0.

- [ ] **Step 7: Commit the privileged-boundary changes**

Run:

~~~powershell
git add background.js bridge.js content.js manifest.json popup.html popup.js
git commit -m "feat: harden fetch and unblur controls"
~~~

---

### Task 3: Add the SPA Widget and Long-document Export Pipeline

**Files:**
- Modify: real-test.mjs
- Modify: content.js

**Interfaces:**
- Consumes: doc2pdf.pageRange(from, to, total)
- Consumes: doc2pdf.qualitySettings(preset, selectedCount)
- Consumes: doc2pdf.mapPool(items, 4, worker)
- Produces: document host #doc2pdf-btn with an open shadow root
- Produces: shadow controls #doc2pdf-from, #doc2pdf-to, #doc2pdf-quality, #doc2pdf-start, and #doc2pdf-status
- Produces: one complete PDF download or no file on error/cancellation

- [ ] **Step 1: Tighten the live test before changing content.js**

In the browser-side result object in real-test.mjs, replace the btn boolean with:

~~~js
const widgetHost = document.getElementById("doc2pdf-btn");
const widgetRoot = widgetHost?.shadowRoot;
const widget = {
  exists: !!widgetHost,
  hasRange:
    !!widgetRoot?.getElementById("doc2pdf-from") &&
    !!widgetRoot?.getElementById("doc2pdf-to"),
  qualityOptions:
    widgetRoot?.getElementById("doc2pdf-quality")?.options.length || 0,
  hasStart: !!widgetRoot?.getElementById("doc2pdf-start"),
  hasStatus: !!widgetRoot?.getElementById("doc2pdf-status"),
};
~~~

Return widget instead of btn. Change the final pass condition to:

~~~js
const widgetOk =
  result.widget?.exists &&
  result.widget.hasRange &&
  result.widget.qualityOptions === 4 &&
  result.widget.hasStart &&
  result.widget.hasStatus;
const ok =
  result.pageCount > 0 &&
  result.source !== "none" &&
  extractedOk &&
  widgetOk &&
  pdfProbe?.ok === true;
~~~

- [ ] **Step 2: Run the live test and verify the new widget assertion is red**

Run:

~~~powershell
node real-test.mjs
~~~

Expected: both pages still extract, but each target reports FAIL because the old button has no shadow controls.

- [ ] **Step 3: Make fetch and wait helpers abort-aware**

Replace fetchViaBridge, fetchText, waitMs, and waitUntil with these abort-aware implementations:

~~~js
function abortError() {
  return new DOMException("Đã hủy", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function fetchViaBridge(url, signal) {
  const id = ++fetchSeq;
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let settled = false;
    const timer = setTimeout(
      () => finish(reject, new Error("bridge timeout")),
      20000
    );
    const onAbort = () => finish(reject, abortError());
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
    }
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }
    function onMessage(event) {
      if (
        event.source !== window ||
        event.data?.type !== "doc2pdf-fetch-result" ||
        event.data.id !== id
      ) {
        return;
      }
      if (event.data.error) finish(reject, new Error(event.data.error));
      else if (event.data.status >= 400) {
        finish(reject, new Error("HTTP " + event.data.status));
      } else {
        finish(resolve, event.data.text ?? "");
      }
    }
    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    window.postMessage({ type: "doc2pdf-fetch", id, url }, location.origin);
  });
}

function xhrText(url, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const xhr = new XMLHttpRequest();
    const onAbort = () => {
      cleanup();
      xhr.abort();
      reject(abortError());
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    xhr.open("GET", url);
    xhr.withCredentials = true;
    xhr.timeout = 15000;
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new Error("HTTP " + xhr.status + " khi tải trang"));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Không tải được trang"));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new Error("timeout khi tải trang"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send();
  });
}

async function fetchText(url, signal) {
  throwIfAborted(signal);
  try {
    const response = await fetch(url, {
      credentials: "include",
      signal,
    });
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " khi tải trang");
    }
    return await response.text();
  } catch (fetchError) {
    if (signal?.aborted) throw abortError();
    try {
      return await xhrText(url, signal);
    } catch {
      if (signal?.aborted) throw abortError();
      return await fetchViaBridge(url, signal);
    }
  }
}

function waitMs(ms, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitUntil(predicate, ms, signal) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (predicate()) return true;
    await waitMs(50, signal);
  }
  throwIfAborted(signal);
  return !!predicate();
}
~~~

Change htmlFromScribdPage to accept signal, call waitUntil with signal, pass
signal to fetchText, and call throwIfAborted before invoking Scribd page
methods and before returning HTML.

- [ ] **Step 4: Apply the selected range before provider page loading**

Change both extraction functions to accept one options object:

~~~js
async function extractStudocu({ from, to, signal, setStatus }) {
  const pageProps = window.__NEXT_DATA__?.props?.pageProps;
  const access = pageProps?.documentAccess;
  const list = pageProps?.pageDataList;
  if (
    !access?.url ||
    !access?.objectKey ||
    !Array.isArray(list) ||
    list.length === 0
  ) {
    throw new Error(
      "Không đọc được dữ liệu tài liệu Studocu (__NEXT_DATA__)"
    );
  }
  const range = doc2pdf.pageRange(from, to, list.length);
  const selected = list.slice(range.from - 1, range.to);
  let done = 0;
  const pages = await doc2pdf.mapPool(selected, 4, async (item, index) => {
    throwIfAborted(signal);
    const row = item ?? {};
    const pageNumber = row.pageNumber ?? range.from + index;
    let inner =
      (typeof row.pageHtml === "string" && row.pageHtml) ||
      (typeof row.html === "string" && row.html) ||
      null;
    if (!inner) {
      try {
        inner = await fetchText(
          doc2pdf.studocuPageUrl(access, pageNumber),
          signal
        );
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        inner = doc2pdf.studocuScanHtml(access, pageNumber);
      }
      inner = String(inner || "").replaceAll(
        "bg" + pageNumber.toString(16) + ".png",
        doc2pdf.studocuBgUrl(access, pageNumber)
      );
    }
    done++;
    setStatus("Đang lấy trang " + done + "/" + selected.length + "…");
    return {
      html: doc2pdf.studocuPageMarkup(row, inner),
      width: row.width,
      height: row.height,
      pageNumber,
    };
  });
  return { pages, range, total: list.length };
}

async function extractScribd({ from, to, signal, setStatus }) {
  let list = doc2pdf.scribdPageList(window.docManager);
  const deadline = Date.now() + 8000;
  while (list.length === 0 && Date.now() < deadline) {
    await waitMs(150, signal);
    list = doc2pdf.scribdPageList(window.docManager);
  }
  if (list.length === 0) {
    list = doc2pdf.scribdPagesFromHtml(document.documentElement.innerHTML);
  }
  if (list.length === 0) {
    throw new Error("Không đọc được docManager của Scribd");
  }
  const range = doc2pdf.pageRange(from, to, list.length);
  const selected = list.slice(range.from - 1, range.to);
  let done = 0;
  const pages = await doc2pdf.mapPool(selected, 4, async (page, index) => {
    throwIfAborted(signal);
    const pageNumber = page.pageNum ?? range.from + index;
    const html = await htmlFromScribdPage(page, signal);
    if (!html) {
      throw new Error("Scribd không trả nội dung trang " + pageNumber);
    }
    done++;
    setStatus("Đang lấy trang " + done + "/" + selected.length + "…");
    return {
      html,
      width: page.origWidth,
      height: page.origHeight,
      pageNumber,
    };
  });
  return { pages, range, total: list.length };
}
~~~

Retain each selected page's own width and height. Use the first selected page for defaults rather than the document's first visible page.

- [ ] **Step 5: Replace whole-document image loading with page-local bounded loading**

Add an abort-aware XHR blob loader and page-local object URL cleanup:

~~~js
function xhrBlob(url, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const xhr = new XMLHttpRequest();
    const onAbort = () => {
      xhr.abort();
      reject(abortError());
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    xhr.open("GET", url);
    xhr.responseType = "blob";
    xhr.withCredentials = true;
    xhr.timeout = 8000;
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error("HTTP " + xhr.status));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Không tải được ảnh"));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new Error("Hết thời gian tải ảnh"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    xhr.send();
  });
}

function assignImageUrl(img, url, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(resolve), 8000);
    const onAbort = () => finish(reject, abortError());
    function cleanup() {
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      signal?.removeEventListener("abort", onAbort);
    }
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }
    img.onload = () => finish(resolve);
    img.onerror = () => finish(resolve);
    signal?.addEventListener("abort", onAbort, { once: true });
    img.src = url;
    if (img.complete) finish(resolve);
  });
}

async function inlineImages(root, signal) {
  const urls = [];
  const cleanup = () => {
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  };
  try {
    await doc2pdf.mapPool([...root.querySelectorAll("img")], 4, async (img) => {
      throwIfAborted(signal);
      const src = img.currentSrc || img.getAttribute("src") || "";
      if (!src || src.startsWith("data:") || src.startsWith("blob:")) return;
      try {
        const blob = await xhrBlob(src, signal);
        const url = URL.createObjectURL(blob);
        urls.push(url);
        await assignImageUrl(img, url, signal);
      } catch (error) {
        if (signal.aborted) throw abortError();
      }
    });
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
~~~

- [ ] **Step 6: Render one page at a time and estimate the final size**

Delete standaloneHtml and the old whole-document inlineImages/export block. Implement exportDocument with this structure:

~~~js
async function exportDocument({ from, to, preset, signal, setStatus }) {
  setStatus("Đang đọc tài liệu…");
  const data =
    site === "scribd"
      ? await extractScribd({ from, to, signal, setStatus })
      : await extractStudocu({ from, to, signal, setStatus });
  const quality = doc2pdf.qualitySettings(preset, data.pages.length);
  const jpegPages = [];
  let jpegBytes = 0;

  const stage = document.createElement("div");
  stage.id = "doc2pdf-print";
  stage.style.cssText =
    "position:absolute;left:-20000px;top:0;pointer-events:none;";
  document.body.append(stage);

  try {
    for (let index = 0; index < data.pages.length; index++) {
      throwIfAborted(signal);
      const page = data.pages[index];
      const width = page.width || 794;
      const height = page.height || 1123;
      const pageBox = document.createElement("div");
      pageBox.style.cssText =
        "position:relative;overflow:hidden;background:#fff;width:" +
        width +
        "px;height:" +
        height +
        "px;";
      pageBox.innerHTML = page.html;
      stage.replaceChildren(pageBox);

      let releaseImages = () => {};
      let canvas;
      try {
        setStatus("Đang tải ảnh trang " + (index + 1) + "/" + data.pages.length + "…");
        releaseImages = await inlineImages(pageBox, signal);
        await document.fonts.ready.catch(() => {});
        throwIfAborted(signal);
        setStatus("Đang chụp trang " + (index + 1) + "/" + data.pages.length + "…");
        canvas = await html2canvas(pageBox, {
          scale: quality.scale,
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#ffffff",
          logging: false,
          imageTimeout: 4000,
        });
        throwIfAborted(signal);
        const bytes = doc2pdf.dataUrlToBytes(
          canvas.toDataURL("image/jpeg", quality.jpegQuality)
        );
        if (!bytes) throw new Error("Không tạo được JPEG");
        jpegBytes += bytes.length;
        jpegPages.push({
          jpeg: bytes,
          pageWidthPx: width,
          pageHeightPx: height,
          imgWidth: canvas.width,
          imgHeight: canvas.height,
        });
        const estimatedMiB =
          (jpegBytes / (index + 1)) * data.pages.length / 1024 / 1024;
        setStatus(
          "Đã chụp " +
            (index + 1) +
            "/" +
            data.pages.length +
            " · ước tính " +
            estimatedMiB.toFixed(1) +
            " MB"
        );
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        throw new Error(
          "Trang " +
            (page.pageNumber || data.range.from + index) +
            ": " +
            String(error?.message || error)
        );
      } finally {
        if (canvas) {
          canvas.width = 1;
          canvas.height = 1;
        }
        releaseImages();
        stage.replaceChildren();
      }
    }

    throwIfAborted(signal);
    setStatus("Đang ghép PDF…");
    const pdf = doc2pdf.jpegPagesToPdf(jpegPages);
    if (!pdf) throw new Error("Không ghép được PDF");
    triggerChromeDownload(
      new Blob([pdf], { type: "application/pdf" }),
      doc2pdf.downloadFilename(document.title || "document", "pdf")
    );
  } finally {
    stage.remove();
  }
}
~~~

Verify html2canvas exists before extraction. Do not catch PDF errors into an HTML download.

- [ ] **Step 7: Replace the floating button with an accessible shadow widget**

Keep the host ID doc2pdf-btn for compatibility. Define the shadow markup once:

~~~js
const WIDGET_MARKUP = [
  "<style>",
  ":host{all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;font:13px/1.35 system-ui,sans-serif;color:#202124}",
  ".panel{width:250px;padding:12px;border-radius:14px;background:#fff;box-shadow:0 3px 16px rgba(0,0,0,.35)}",
  ".row{display:flex;gap:8px;margin-bottom:8px}",
  "label{flex:1;display:grid;gap:3px}",
  "input,select,button{box-sizing:border-box;min-height:34px;font:inherit}",
  "input,select{width:100%;border:1px solid #dadce0;border-radius:7px;padding:5px 7px}",
  "button{width:100%;border:0;border-radius:18px;background:#1a73e8;color:#fff;font-weight:700;cursor:pointer}",
  "#doc2pdf-status{min-height:18px;margin-top:7px;color:#5f6368;overflow-wrap:anywhere}",
  "</style>",
  '<div class="panel">',
  '<div class="row">',
  '<label>Từ trang<input id="doc2pdf-from" type="number" min="1" step="1" value="1"></label>',
  '<label>Đến trang<input id="doc2pdf-to" type="number" min="1" step="1" placeholder="Cuối"></label>',
  "</div>",
  "<label>Chất lượng",
  '<select id="doc2pdf-quality">',
  '<option value="auto">Tự động</option>',
  '<option value="high">Cao</option>',
  '<option value="balanced">Cân bằng</option>',
  '<option value="small">Nhẹ</option>',
  "</select>",
  "</label>",
  '<button id="doc2pdf-start" type="button">↓ PDF</button>',
  '<div id="doc2pdf-status" role="status" aria-live="polite"></div>',
  "</div>",
].join("");
~~~

Attach an open shadow root and wire the controls with:

~~~js
function createWidget() {
  if (document.getElementById(BTN_ID) || !document.body) return;
  const host = document.createElement("div");
  host.id = BTN_ID;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = WIDGET_MARKUP;

  const from = root.getElementById("doc2pdf-from");
  const to = root.getElementById("doc2pdf-to");
  const quality = root.getElementById("doc2pdf-quality");
  const start = root.getElementById("doc2pdf-start");
  const status = root.getElementById("doc2pdf-status");
  const setStatus = (text) => {
    status.textContent = text;
    start.title = text;
  };

  start.addEventListener("click", async () => {
    if (activeController) {
      activeController.abort();
      setStatus("Đang hủy…");
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    from.disabled = true;
    to.disabled = true;
    quality.disabled = true;
    start.textContent = "Hủy";
    try {
      if (typeof html2canvas !== "function") {
        throw new Error("Thiếu html2canvas");
      }
      await exportDocument({
        from: from.value,
        to: to.value,
        preset: quality.value,
        signal: controller.signal,
        setStatus,
      });
      setStatus("Đã tải PDF");
    } catch (error) {
      if (error?.name === "AbortError") {
        setStatus("Đã hủy");
      } else {
        setStatus(
          String(error?.message || error) +
            ". Thử phạm vi ngắn hơn hoặc chất lượng thấp hơn."
        );
      }
    } finally {
      if (activeController === controller) activeController = null;
      from.disabled = false;
      to.disabled = false;
      quality.disabled = false;
      start.textContent = "↓ PDF";
    }
  });

  document.body.append(host);
}
~~~

Define WIDGET_MARKUP once immediately before createWidget as a string containing
the exact HTML and CSS block above. Do not rebuild or query host-page controls
outside the shadow root.

- [ ] **Step 8: Add deterministic SPA lifecycle handling**

Remove the early return based on the initial pathname. Keep the early return for unsupported hostname or missing doc2pdf. Add:

~~~js
let lastHref = "";
let activeController = null;

function syncWidget() {
  if (location.href === lastHref) return;
  lastHref = location.href;
  const supported = doc2pdf.isDocPath(location.pathname, site);
  const host = document.getElementById(BTN_ID);
  if (supported && !host && document.body) createWidget();
  if (!supported && host) {
    activeController?.abort();
    host.remove();
  }
}

for (const method of ["pushState", "replaceState"]) {
  const original = history[method];
  history[method] = function (...args) {
    const result = Reflect.apply(original, this, args);
    queueMicrotask(syncWidget);
    return result;
  };
}
window.addEventListener("popstate", syncWidget);
window.addEventListener("hashchange", syncWidget);
new MutationObserver(syncWidget).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
syncWidget();
~~~

The createWidget guard above prevents host-page rerenders from duplicating the
widget.

- [ ] **Step 9: Run focused and live verification**

Run:

~~~powershell
node --check content.js
node --check real-test.mjs
node test.mjs
node real-test.mjs
~~~

Expected: all self-tests pass; Scribd and Studocu each report PASS, the widget has four quality options, and pdfProbe.ok is true.

- [ ] **Step 10: Commit the export pipeline**

Run:

~~~powershell
git add content.js real-test.mjs
git commit -m "feat: stabilize long document exports"
~~~

---

### Task 4: Document, Package, and Verify Release 1.2.0

**Files:**
- Modify: README.md
- Replace: doc2pdf.zip

**Interfaces:**
- Consumes: manifest version 1.2.0 and all runtime files from Tasks 1-3
- Produces: installation ZIP containing manifest.json, background.js, bridge.js, content.js, lib.js, html2canvas.min.js, popup.html, popup.js, and README.md

- [ ] **Step 1: Rewrite the user workflow in README**

Document these exact behaviors:

- The floating panel accepts From/To and Auto/High/Balanced/Small.
- Blank To means the final available page.
- Auto uses High through 40 pages, Balanced through 100, and Small above 100.
- Clicking Hủy aborts network work immediately but may wait for the active canvas capture.
- Errors do not create an HTML or partial PDF; retry with a smaller range or lower quality.
- The toolbar popup controls automatic sd_docs deletion and affects only Scribd domains.
- node test.mjs is the fast test; node real-test.mjs opens temporary Chrome and tests both live providers.

Add this release smoke checklist:

~~~markdown
## Smoke test trước khi phát hành

- Load unpacked và xác nhận popup lưu được công tắc unblur sau khi đóng/mở lại.
- Mở một tài liệu từ trang tìm kiếm bằng SPA; panel phải xuất hiện, rồi biến mất khi rời tài liệu.
- Xuất 2 trang ở Auto; PDF phải có đúng 2 trang và mở được.
- Bấm Hủy khi đang chụp; không được tải file một phần.
- Tắt unblur, tạo sd_docs và xác nhận cookie còn; bật lại và xác nhận cookie bị xóa.
- Thử một tài liệu cần bridge fallback và xác nhận vẫn tải được nội dung cùng provider.
~~~

- [ ] **Step 2: Rebuild doc2pdf.zip from the exact release file list**

Run from D:\scribd:

~~~powershell
$releaseFiles = @(
  "manifest.json",
  "background.js",
  "bridge.js",
  "content.js",
  "lib.js",
  "html2canvas.min.js",
  "popup.html",
  "popup.js",
  "README.md"
)
Compress-Archive -LiteralPath $releaseFiles -DestinationPath "doc2pdf.zip" -Force
~~~

Expected: the ZIP contains nine flat entries and no test, Git, docs, or temporary-profile files.

- [ ] **Step 3: Run the full static, unit, live, encoding, and package checks**

Run:

~~~powershell
node --check lib.js
node --check content.js
node --check bridge.js
node --check background.js
node --check popup.js
node --check test.mjs
node --check real-test.mjs
Get-Content -Raw -Encoding utf8 manifest.json | ConvertFrom-Json | Out-Null
node test.mjs
node real-test.mjs
git diff --check
~~~

Run the UTF-8 regression check:

~~~powershell
$strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$files = @(rg --files -g "*.js" -g "*.mjs" -g "*.json" -g "*.md" -g "*.html")
foreach ($file in $files) {
  $text = $strictUtf8.GetString([IO.File]::ReadAllBytes((Join-Path $PWD $file)))
  if ($text -match "\u00C3|\u00C2|\u00E2\u20AC|\u00C4|\u00C6|\u00E1\u00BA|\u00E1\u00BB|\u00EF\u00BF\u00BD|\uFFFD") {
    throw "Mojibake: $file"
  }
}
~~~

Verify every ZIP entry byte-for-byte with:

~~~powershell
Add-Type -AssemblyName System.IO.Compression
$releaseFiles = @(
  "manifest.json",
  "background.js",
  "bridge.js",
  "content.js",
  "lib.js",
  "html2canvas.min.js",
  "popup.html",
  "popup.js",
  "README.md"
)
$stream = [IO.File]::OpenRead((Resolve-Path "doc2pdf.zip"))
$zip = [IO.Compression.ZipArchive]::new(
  $stream,
  [IO.Compression.ZipArchiveMode]::Read
)
try {
  if ($zip.Entries.Count -ne $releaseFiles.Count) {
    throw "ZIP entry count: $($zip.Entries.Count)"
  }
  foreach ($entry in $zip.Entries) {
    if ($entry.FullName -notin $releaseFiles) {
      throw "Unexpected ZIP entry: $($entry.FullName)"
    }
    $entryStream = $entry.Open()
    try {
      $sha = [Security.Cryptography.SHA256]::Create()
      $zipHash = ([BitConverter]::ToString(
        $sha.ComputeHash($entryStream)
      )).Replace("-", "")
      $diskHash = (Get-FileHash -Algorithm SHA256 $entry.FullName).Hash
      if ($zipHash -ne $diskHash) {
        throw "ZIP mismatch: $($entry.FullName)"
      }
    } finally {
      $entryStream.Dispose()
    }
  }
} finally {
  $zip.Dispose()
  $stream.Dispose()
}
~~~

Expected: the command exits without output.

- [ ] **Step 4: Perform the README smoke checklist**

Load D:\scribd through chrome://extensions and complete all six checks. Record any failure before committing the release; do not treat the CDP injection test as coverage for popup, bridge, cookie, or actual download behavior.

- [ ] **Step 5: Commit the release**

Run:

~~~powershell
git add README.md doc2pdf.zip
git commit -m "docs: release doc2pdf 1.2.0"
git status --short --branch
~~~

Expected: the final status shows branch main with no modified or untracked files.
