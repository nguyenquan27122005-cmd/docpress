// Content script: nút "PDF" nổi trên trang tài liệu Studocu/Scribd.
// Bấm nút -> lấy dữ liệu các trang -> tạo PDF -> tải qua thanh Download Chrome.
"use strict";
(() => {
  const BTN_ID = "doc2pdf-btn";
  const host = location.hostname;

  const site = /(^|\.)scribd\.com$/.test(host)
    ? "scribd"
    : /(^|\.)(studocu\.com|studeersnel\.nl|studocu\.id|studocu\.vn)$/.test(host)
      ? "studocu"
      : null;
  if (!globalThis.doc2pdf) return;
  // Studocu: /document/. Scribd: /doc|/document|/presentation (studotools) + /embeds.
  if (!site) return;

  let fetchSeq = 0;
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
      let cancelSent = false;
      const onAbort = () => {
        if (!cancelSent) {
          cancelSent = true;
          window.postMessage({ type: "doc2pdf-fetch-cancel", id }, location.origin);
        }
        finish(reject, abortError());
      };
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

  function waitForFonts(signal) {
    return new Promise((resolve, reject) => {
      throwIfAborted(signal);
      let settled = false;
      const timer = setTimeout(() => finish(resolve), 5000);
      const onAbort = () => finish(reject, abortError());
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn(value);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(document.fonts?.ready).then(
        () => finish(resolve),
        () => finish(resolve)
      );
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

  async function htmlFromScribdPage(p, signal) {
    throwIfAborted(signal);
    if (typeof p.load === "function" && !p.innerPageElem && !p.loadHasStarted) {
      try {
        p.load();
      } catch {}
    }
    await waitUntil(() => !!p.innerPageElem, 8000, signal);
    throwIfAborted(signal);

    const inner = p.innerPageElem;
    if (inner) {
      const template = document.createElement("template");
      template.content.append((p.containerElem || inner).cloneNode(true));
      const box = template.content.firstElementChild;
      box.querySelectorAll("img[orig]").forEach((img) => {
        const orig = String(img.getAttribute("orig") || "").replaceAll(
          "http://html.scribd.com",
          "https://html.scribdassets.com"
        );
        const src = String(img.getAttribute("src") || "");
        if (orig && !/^(data|blob):/i.test(src)) img.setAttribute("src", orig);
        img.removeAttribute("orig");
        img.style.display = "block";
      });
      throwIfAborted(signal);
      if (p.containerElem) {
        if (p.origWidth) box.style.width = `${p.origWidth}px`;
        if (p.origHeight) box.style.height = `${p.origHeight}px`;
        return doc2pdf.rewriteScribdImageHosts(box.outerHTML);
      }
      return doc2pdf.rewriteScribdImageHosts(box.innerHTML);
    }

    throwIfAborted(signal);
    if (!p.contentUrl) return "";
    const raw = await fetchText(p.contentUrl, signal);
    let html = doc2pdf.rewriteScribdImageHosts(doc2pdf.scribdPageHtml(doc2pdf.parseJsonp(raw), raw));
    if (p.containerElem) {
      const box = p.containerElem.cloneNode();
      box.innerHTML = html;
      if (p.origWidth) box.style.width = `${p.origWidth}px`;
      if (p.origHeight) box.style.height = `${p.origHeight}px`;
      html = box.outerHTML;
    }
    throwIfAborted(signal);
    return html;
  }

  function triggerChromeDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function xhrBlob(url, signal) {
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
      xhr.responseType = "blob";
      // Public image CDNs use Access-Control-Allow-Origin: *.
      // Cross-origin cookies would make those responses fail CORS.
      xhr.withCredentials = false;
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

  function waitForImage(img, signal) {
    return new Promise((resolve, reject) => {
      throwIfAborted(signal);
      let settled = false;
      const timer = setTimeout(
        () => finish(reject, new Error("Hết thời gian tải ảnh")),
        8000
      );
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
      img.onload = () => {
        if (img.naturalWidth > 0) finish(resolve);
        else finish(reject, new Error("Không đọc được ảnh"));
      };
      img.onerror = () => finish(reject, new Error("Không đọc được ảnh"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (img.complete) img.onload();
    });
  }

  function parseSrcset(value) {
    const input = String(value || "");
    const candidates = [];
    let index = 0;
    while (index < input.length) {
      while (index < input.length && /[\s,]/.test(input[index])) index++;
      if (index >= input.length) break;
      const start = index;
      while (index < input.length && !/\s/.test(input[index])) index++;
      let url = input.slice(start, index);
      if (url.endsWith(",")) {
        url = url.replace(/,+$/, "");
        if (url) candidates.push({ url, descriptor: "" });
        continue;
      }
      while (index < input.length && /\s/.test(input[index])) index++;
      const descriptorStart = index;
      let parentheses = 0;
      while (index < input.length) {
        if (input[index] === "(") parentheses++;
        if (input[index] === ")") parentheses = Math.max(0, parentheses - 1);
        if (input[index] === "," && parentheses === 0) break;
        index++;
      }
      const descriptor = input.slice(descriptorStart, index).trim();
      if (index < input.length) index++;
      if (url) candidates.push({ url, descriptor });
    }
    return candidates;
  }

  function remoteImageUrl(value) {
    const url = String(value || "").trim();
    if (!url || /^(data|blob):/i.test(url)) return "";
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  async function inlineImages(root, signal) {
    const urls = [];
    let failure;
    const cleanup = () => {
      for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    };
    try {
      const attributes = [];
      for (const element of root.querySelectorAll("img, picture source")) {
        for (const name of ["src", "srcset"]) {
          if (!element.hasAttribute(name)) continue;
          const value = element.getAttribute(name) || "";
          attributes.push({
            element,
            name,
            candidates: name === "srcset" ? parseSrcset(value) : [{ url: value, descriptor: "" }],
          });
        }
      }
      const sources = [...new Set(attributes.flatMap(({ candidates }) =>
        candidates.map(({ url }) => remoteImageUrl(url)).filter(Boolean)
      ))];
      const replacements = new Map();
      await doc2pdf.mapPool(sources, 4, async (src) => {
        if (failure) return;
        try {
          throwIfAborted(signal);
          const blob = await xhrBlob(src, signal);
          throwIfAborted(signal);
          const url = URL.createObjectURL(blob);
          urls.push(url);
          replacements.set(src, url);
        } catch (error) {
          failure ||= error;
        }
      });
      throwIfAborted(signal);
      if (failure) throw failure;
      for (const { element, name, candidates } of attributes) {
        const value = candidates.map(({ url, descriptor }) => {
          const replacement = replacements.get(remoteImageUrl(url)) || url;
          return descriptor ? replacement + " " + descriptor : replacement;
        }).join(", ");
        element.setAttribute(name, value);
      }
      return cleanup;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async function waitForImages(root, signal) {
    let failure;
    await doc2pdf.mapPool([...root.querySelectorAll("img")], 4, async (img) => {
      if (failure) return;
      const hasSource = img.currentSrc || img.getAttribute("src") ||
        img.closest("picture")?.querySelector("source[src], source[srcset]");
      if (!hasSource) return;
      try {
        await waitForImage(img, signal);
      } catch (error) {
        failure ||= error;
      }
    });
    throwIfAborted(signal);
    if (failure) throw failure;
  }

  async function flattenImageClips(root, signal) {
    // html2canvas ignores legacy clip:rect(), used by Scribd image sprites.
    // Bake that rectangle into transparent pixels, preserving the image layout.
    for (const img of root.querySelectorAll("img")) {
      throwIfAborted(signal);
      const style = getComputedStyle(img);
      const match = /^rect\((.*)\)$/.exec(style.clip);
      if (!match) continue;
      const width = parseFloat(style.width);
      const height = parseFloat(style.height);
      const edges = match[1].split(/[,\s]+/).filter(Boolean);
      const [top, right, bottom, left] = edges.map((edge, index) =>
        edge === "auto" ? [0, width, height, 0][index] : parseFloat(edge)
      );
      if (!width || !height || ![top, right, bottom, left].every(Number.isFinite)) continue;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      try {
        const ctx = canvas.getContext("2d");
        const xScale = canvas.width / width;
        const yScale = canvas.height / height;
        ctx.rect(left * xScale, top * yScale, Math.max(0, right - left) * xScale, Math.max(0, bottom - top) * yScale);
        ctx.clip();
        ctx.drawImage(img, 0, 0);
        img.removeAttribute("srcset");
        img.src = canvas.toDataURL("image/png");
        await waitForImage(img, signal);
      } finally {
        canvas.width = canvas.height = 1;
      }
    }
  }

  async function exportDocument({ from, to, preset, signal, setStatus, title }) {
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
        let width = Number(page.width) > 0 ? Number(page.width) : 0;
        let height = Number(page.height) > 0 ? Number(page.height) : 0;
        const pageBox = document.createElement("div");
        pageBox.style.cssText =
          "position:relative;overflow:hidden;background:#fff;width:" +
          (width ? width + "px" : "max-content") + ";height:" +
          (height ? height + "px" : "auto") + ";";
        const pageTemplate = document.createElement("template");
        pageTemplate.innerHTML = page.html;

        let releaseImages = () => {};
        let canvas;
        try {
          setStatus("Đang tải ảnh trang " + (index + 1) + "/" + data.pages.length + "…");
          releaseImages = await inlineImages(pageTemplate.content, signal);
          pageBox.append(pageTemplate.content);
          if (site === "scribd") {
            // Viewer zoom is independent of the document's original bounds.
            pageBox.querySelectorAll(".newpage").forEach((element) => {
              element.style.transform = "none";
            });
          }
          stage.replaceChildren(pageBox);
          await waitForImages(pageBox, signal);
          await flattenImageClips(pageBox, signal);
          await waitForFonts(signal);
          throwIfAborted(signal);
          // Measure the loaded wrapper/content before fixing the capture bounds.
          // Studocu often omits row.width/height entirely.
          width ||= Math.ceil(Math.max(pageBox.getBoundingClientRect().width, pageBox.scrollWidth)) || 794;
          height ||= Math.ceil(Math.max(pageBox.getBoundingClientRect().height, pageBox.scrollHeight)) || 1123;
          pageBox.style.width = width + "px";
          pageBox.style.height = height + "px";
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
        doc2pdf.downloadFilename(title, "pdf")
      );
    } finally {
      stage.remove();
    }
  }

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
      const title = document.title || "document";
      activeController = controller;
      activeHost = host;
      activeDocument = location.origin + location.pathname;
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
          title,
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
        controller.abort();
        if (activeController === controller) {
          activeController = null;
          activeHost = null;
          activeDocument = "";
        }
        from.disabled = false;
        to.disabled = false;
        quality.disabled = false;
        start.textContent = "↓ PDF";
      }
    });

    document.body.append(host);
  }

  let lastHref = "";
  let activeController = null;
  let activeHost = null;
  let activeDocument = "";

  function syncWidget() {
    const host = document.getElementById(BTN_ID);
    const supported = doc2pdf.isDocPath(location.pathname, site);
    if (
      !supported ||
      (activeController && (
        activeHost !== host ||
        activeDocument !== location.origin + location.pathname
      ))
    ) {
      activeController?.abort();
    }
    if (location.href === lastHref && host) return;
    lastHref = location.href;
    if (supported && !host && document.body) createWidget();
    if (!supported && host) {
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
})();
