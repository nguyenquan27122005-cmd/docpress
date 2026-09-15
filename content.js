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
  if (!site || !doc2pdf.isDocPath(location.pathname, site)) return;

  let fetchSeq = 0;
  function fetchViaBridge(url) {
    const id = ++fetchSeq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        window.removeEventListener("message", onMsg);
        reject(new Error("bridge timeout"));
      }, 20000);
      function onMsg(ev) {
        if (ev.source !== window || ev.data?.type !== "doc2pdf-fetch-result" || ev.data.id !== id) return;
        clearTimeout(t);
        window.removeEventListener("message", onMsg);
        if (ev.data.error) reject(new Error(ev.data.error));
        else if (ev.data.status && ev.data.status >= 400) reject(new Error(`HTTP ${ev.data.status}`));
        else resolve(ev.data.text ?? "");
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ type: "doc2pdf-fetch", id, url }, location.origin);
    });
  }

  async function fetchText(url) {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status} khi tải trang`);
      return await r.text();
    } catch (fetchErr) {
      try {
        return await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open("GET", url);
          x.withCredentials = true;
          x.timeout = 15000;
          x.onload = () =>
            x.status >= 200 && x.status < 300
              ? resolve(x.responseText)
              : reject(new Error(`HTTP ${x.status} khi tải trang`));
          x.onerror = () => reject(fetchErr);
          x.ontimeout = () => reject(new Error("timeout khi tải trang"));
          x.send();
        });
      } catch {
        return await fetchViaBridge(url);
      }
    }
  }

  function waitMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitUntil(pred, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await waitMs(50);
    }
    return !!pred();
  }

  async function extractStudocu(setStatus) {
    const pp = window.__NEXT_DATA__?.props?.pageProps;
    const access = pp?.documentAccess;
    const list = pp?.pageDataList;
    if (!access?.url || !access?.objectKey || !Array.isArray(list) || list.length === 0) {
      throw new Error("Không đọc được dữ liệu tài liệu Studocu (__NEXT_DATA__)");
    }
    let done = 0;
    const pages = await doc2pdf.mapPool(list, 4, async (p, i) => {
      const row = p ?? {};
      const num = row.pageNumber ?? i + 1;
      let inner =
        (typeof row.pageHtml === "string" && row.pageHtml) ||
        (typeof row.html === "string" && row.html) ||
        null;
      if (!inner) {
        try {
          inner = await fetchText(doc2pdf.studocuPageUrl(access, num));
        } catch {
          inner = doc2pdf.studocuScanHtml(access, num);
        }
        inner = inner.replaceAll(`bg${num.toString(16)}.png`, doc2pdf.studocuBgUrl(access, num));
      }
      done++;
      setStatus(`Đang lấy trang ${done}/${list.length}…`);
      return { html: doc2pdf.studocuPageMarkup(row, inner), width: row.width, height: row.height };
    });
    const firstImg = document.querySelector("div[data-page-index='0'] .page-content img.bi");
    return {
      pages,
      width: list[0]?.width ?? firstImg?.naturalWidth,
      height: list[0]?.height ?? firstImg?.naturalHeight,
    };
  }

  async function htmlFromScribdPage(p) {
    if (typeof p.load === "function" && !p.innerPageElem && !p.loadHasStarted) {
      try {
        p.load();
      } catch {}
    }
    await waitUntil(() => !!p.innerPageElem, 8000);
    try {
      p.display?.();
    } catch {}
    try {
      if (!p._imagesTurnedOn) p.turnOnImages?.();
    } catch {}

    const inner = p.innerPageElem;
    if (inner) {
      inner.querySelectorAll("img[orig]").forEach((img) => {
        const orig = String(img.getAttribute("orig") || "").replaceAll(
          "http://html.scribd.com",
          "https://html.scribdassets.com"
        );
        if (orig && !img.getAttribute("src")) img.setAttribute("src", orig);
        img.style.display = "block";
      });
      await waitUntil(
        () => [...inner.querySelectorAll("img")].every((img) => img.complete),
        400
      );
      if (p.containerElem) {
        const box = p.containerElem.cloneNode(true);
        if (p.origWidth) box.style.width = `${p.origWidth}px`;
        if (p.origHeight) box.style.height = `${p.origHeight}px`;
        return doc2pdf.rewriteScribdImageHosts(box.outerHTML);
      }
      return doc2pdf.rewriteScribdImageHosts(inner.innerHTML);
    }

    if (!p.contentUrl) return "";
    const raw = await fetchText(p.contentUrl);
    let html = doc2pdf.rewriteScribdImageHosts(doc2pdf.scribdPageHtml(doc2pdf.parseJsonp(raw), raw));
    if (p.containerElem) {
      const box = p.containerElem.cloneNode();
      box.innerHTML = html;
      if (p.origWidth) box.style.width = `${p.origWidth}px`;
      if (p.origHeight) box.style.height = `${p.origHeight}px`;
      html = box.outerHTML;
    }
    return html;
  }

  async function extractScribd(setStatus) {
    // Live Scribd: pages là object 1-based, không phải Array. contentUrl bị xóa
    // sau khi load; fetch jsonp bị webpack bọc. Ưu tiên load()+DOM, jsonp là fallback.
    let list = doc2pdf.scribdPageList(window.docManager);
    const deadline = Date.now() + 8000;
    while (list.length === 0 && Date.now() < deadline) {
      await waitMs(150);
      list = doc2pdf.scribdPageList(window.docManager);
    }
    if (list.length === 0) {
      list = doc2pdf.scribdPagesFromHtml(document.documentElement.innerHTML);
    }
    if (list.length === 0) {
      throw new Error("Không đọc được docManager của Scribd");
    }

    setStatus(`Đang lấy trang 0/${list.length}…`);
    // ponytail: 4 trang một lúc — Scribd load() nặng; tài liệu hàng trăm trang
    // nâng lên p-limit/queue nếu máy đứng.
    let done = 0;
    const pages = (
      await doc2pdf.mapPool(list, 4, async (p) => {
        const html = await htmlFromScribdPage(p);
        done++;
        setStatus(`Đang lấy trang ${done}/${list.length}…`);
        return html ? { html, width: p.origWidth, height: p.origHeight } : null;
      })
    ).filter(Boolean);

    if (pages.length === 0) throw new Error("Scribd không trả nội dung trang nào");
    const first = window.docManager?.firstVisiblePage;
    return {
      pages,
      width: first?.origWidth ?? pages[0].width,
      height: first?.origHeight ?? pages[0].height,
    };
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

  function standaloneHtml(pages, W, H, title) {
    const safe = String(title ?? "document").replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${safe}</title>
<style>body{margin:0}.pg{position:relative;overflow:hidden;page-break-after:always}@page{margin:0;size:${W}px ${H}px}</style>
</head><body>
${pages.map((p) => `<div class="pg" style="width:${p.width ?? W}px;height:${p.height ?? H}px">${p.html}</div>`).join("")}
</body></html>`;
  }

  async function inlineImages(root) {
    const imgs = [...root.querySelectorAll("img")];
    await Promise.all(
      imgs.map(async (img) => {
        const src = img.currentSrc || img.getAttribute("src") || "";
        if (!src || src.startsWith("data:") || src.startsWith("blob:")) return;
        try {
          const blob = await new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open("GET", src);
            x.responseType = "blob";
            x.withCredentials = true;
            x.timeout = 8000;
            x.onload = () =>
              x.status >= 200 && x.status < 300 ? resolve(x.response) : reject(new Error(String(x.status)));
            x.onerror = () => reject(new Error("xhr"));
            x.ontimeout = () => reject(new Error("timeout"));
            x.send();
          });
          img.src = URL.createObjectURL(blob);
          await new Promise((res) => {
            img.onload = img.onerror = res;
          });
        } catch {}
      })
    );
  }

  async function exportDocument(setStatus) {
    setStatus("Đang đọc tài liệu…");
    const data = site === "scribd" ? await extractScribd(setStatus) : await extractStudocu(setStatus);
    const { pages } = data;
    const W = data.width ?? 794;
    const H = data.height ?? 1123;
    const title = document.title || "document";

    document.getElementById("doc2pdf-print")?.remove();

    setStatus(`Đang dựng ${pages.length} trang…`);
    const wrap = document.createElement("div");
    wrap.id = "doc2pdf-print";
    wrap.style.cssText = "position:absolute;left:-20000px;top:0;pointer-events:none;";
    for (const p of pages) {
      const pg = document.createElement("div");
      pg.style.cssText = `position:relative;overflow:hidden;background:#fff;width:${p.width ?? W}px;height:${p.height ?? H}px;`;
      pg.innerHTML = p.html;
      wrap.appendChild(pg);
    }
    document.body.append(wrap);
    try {
    setStatus("Đang tải ảnh…");
    await inlineImages(wrap);
    await Promise.all(
      [...wrap.querySelectorAll("img")].map((img) =>
        img.complete
          ? null
          : new Promise((res) => {
              img.onload = img.onerror = res;
            })
      )
    );
    try {
      await document.fonts.ready;
    } catch {}
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    let blob;
    let filename;
    try {
      if (typeof html2canvas !== "function") throw new Error("html2canvas missing");
      const jpegPages = [];
      for (let i = 0; i < wrap.children.length; i++) {
        setStatus(`Đang chụp trang ${i + 1}/${wrap.children.length}…`);
        const canvas = await html2canvas(wrap.children[i], {
          scale: 2,
          useCORS: true,
          allowTaint: false,
          backgroundColor: "#ffffff",
          logging: false,
          imageTimeout: 4000,
        });
        const bytes = doc2pdf.dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92));
        if (!bytes) throw new Error("toDataURL");
        jpegPages.push({
          jpeg: bytes,
          pageWidthPx: pages[i].width ?? W,
          pageHeightPx: pages[i].height ?? H,
          imgWidth: canvas.width,
          imgHeight: canvas.height,
        });
      }
      const pdf = doc2pdf.jpegPagesToPdf(jpegPages);
      if (!pdf) throw new Error("pdf");
      blob = new Blob([pdf], { type: "application/pdf" });
      filename = doc2pdf.downloadFilename(title, "pdf");
    } catch {
      setStatus("Canvas lỗi, đang tải HTML…");
      blob = new Blob([standaloneHtml(pages, W, H, title)], { type: "text/html;charset=utf-8" });
      filename = doc2pdf.downloadFilename(title, "html");
    }

    triggerChromeDownload(blob, filename);
    } finally {
      wrap.remove();
    }
  }

  async function onDownload(btn) {
    const idle = "↓ PDF";
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await exportDocument((s) => (btn.textContent = s));
      btn.textContent = idle;
    } catch (e) {
      const msg = String(e?.message || e);
      btn.textContent = `Lỗi: ${msg.slice(0, 60)}`;
      btn.title = msg; // giữ lại đến lần bấm sau để kịp đọc
    } finally {
      btn.disabled = false;
    }
  }

  function addButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.textContent = "↓ PDF";
    btn.title = "Tải tài liệu về máy (thanh Download của Chrome)";
    btn.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#1a73e8;color:#fff;" +
      "border:none;border-radius:24px;padding:10px 16px;font:600 14px/1 sans-serif;cursor:pointer;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.35);";
    btn.addEventListener("click", () => onDownload(btn), { once: false });
    document.body.appendChild(btn);
  }

  if (document.body) addButton();
  // Trang SPA re-render và xoá mất nút — thêm lại khi thấy nút biến mất.
  new MutationObserver(addButton).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
