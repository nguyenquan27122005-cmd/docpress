// Real-test trên Scribd thật: mở Chrome, đọc window.docManager, chạy parser của lib.js.
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 9333;
const PROFILE = join(ROOT, ".chrome-real-test");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LIB = readFileSync(join(ROOT, "lib.js"), "utf8");
const H2C = readFileSync(join(ROOT, "html2canvas.min.js"), "utf8");
const CONTENT = readFileSync(join(ROOT, "content.js"), "utf8");

// Chrome branded 153+ bỏ --load-extension (hardcoded). --disable-extensions-except
// khiến Scribd trả 406 → chrome-error://. Inject script qua CDP như extension MAIN world.
// /embeds/1055407232/content hiện 404 — document path vẫn sống.
const TARGETS = [
  {
    name: "scribd",
    url: "https://www.scribd.com/document/1055407232/CV-Factory-Manager",
  },
  {
    name: "studocu",
    url: "https://www.studocu.com/en-us/document/university-of-cincinnati/ordinary-differential-equations/the-cornell-note-taking-system-with-examples/86074571",
  },
];
const HEADED = TARGETS.some((t) => /studocu/.test(t.url));

function cdp(ws, method, params = {}, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 45000);
    const onMsg = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitDevtools(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${base}/json/version`);
      if (r.ok) return r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome DevTools không lên");
}

async function evaluate(ws, expression, id, awaitPromise = true) {
  const res = await cdp(
    ws,
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise,
      timeout: 40000,
    },
    id
  );
  if (res.exceptionDetails) {
    const d = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
    throw new Error(d || "Runtime.evaluate exception");
  }
  return res.result?.value;
}

function waitEvent(ws, method, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      reject(new Error(`timeout waiting ${method}`));
    }, timeoutMs);
    const onMsg = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.method !== method) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      resolve(msg.params);
    };
    ws.addEventListener("message", onMsg);
  });
}

async function testUrl(browserWs, target, startId) {
  let id = startId;
  const created = await cdp(browserWs, "Target.createTarget", { url: "about:blank" }, id++);
  await sleep(400);
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const tab =
    tabs.find((t) => t.id === created.targetId) ||
    tabs.find((t) => t.type === "page") ||
    tabs[0];
  if (!tab?.webSocketDebuggerUrl) throw new Error("Không lấy được tab DevTools");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("tab websocket error")));
  });
  await cdp(ws, "Page.enable", {}, id++);
  await cdp(ws, "Runtime.enable", {}, id++);
  let href = "about:blank";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const loaded = waitEvent(ws, "Page.loadEventFired", 25000).catch(() => null);
    await cdp(ws, "Page.navigate", { url: target.url }, id++);
    await loaded;
    await sleep(3000);
    href = await evaluate(ws, "location.href", id++, false);
    if (typeof href === "string" && href.startsWith("http") && !href.startsWith("chrome-error:")) break;
    console.error(`navigate ${attempt}/3 -> ${href}`);
    if (attempt < 3) await sleep(2000);
  }
  if (/studocu/.test(target.url)) {
    await evaluate(
      ws,
      `(async () => {
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          if (window.__NEXT_DATA__?.props?.pageProps?.pageDataList?.length) return true;
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      })()`,
      id++,
      true
    );
  } else {
    await sleep(4000);
  }

  const probe = await evaluate(
    ws,
    `(() => {
      const challenge = /Client Challenge|_fs-ch-/.test(document.documentElement.innerHTML);
      return {
        href: location.href,
        title: document.title,
        pathname: location.pathname,
        challenge,
        errorText: (document.body && document.body.innerText || "").slice(0, 240),
        hasDocManager: typeof window.docManager !== "undefined",
        docManagerType: typeof window.docManager,
        pagesType: window.docManager && typeof window.docManager.pages,
        isArray: Array.isArray(window.docManager?.pages),
      };
    })()`,
    id++,
    false
  );

  // đợi docManager.pages như extension
  const ready = await evaluate(
    ws,
    `(async () => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const p = window.docManager?.pages;
        if (p && typeof p === "object" && Object.values(p).filter(Boolean).length) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return !!(window.docManager?.pages);
    })()`,
    id++,
    true
  );

  await evaluate(ws, LIB, id++, false);
  await evaluate(ws, H2C, id++, false);
  try {
    await evaluate(ws, CONTENT, id++, false);
  } catch (e) {
    console.error("content.js inject:", e.message || e);
  }

  const result = await evaluate(
    ws,
    `(async () => {
      const pp = window.__NEXT_DATA__?.props?.pageProps;
      const access = pp?.documentAccess;
      const nextList = pp?.pageDataList;
      if (access?.url && Array.isArray(nextList) && nextList.length) {
        const extracted = [];
        for (let i = 0; i < nextList.length; i++) {
          const row = nextList[i] ?? {};
          const num = row.pageNumber ?? i + 1;
          let inner =
            (typeof row.pageHtml === "string" && row.pageHtml) ||
            (typeof row.html === "string" && row.html) ||
            null;
          if (!inner) {
            try {
              const r = await fetch(doc2pdf.studocuPageUrl(access, num), { credentials: "include" });
              inner = await r.text();
            } catch {
              inner = doc2pdf.studocuScanHtml(access, num);
            }
            inner = String(inner || "").replaceAll("bg" + num.toString(16) + ".png", doc2pdf.studocuBgUrl(access, num));
          }
          const html = doc2pdf.studocuPageMarkup(row, inner);
          extracted.push({
            pageNum: num,
            htmlLen: html.length,
            hasText: html.length > 80,
            wrapped: html.includes("data-page-no") || html.includes("class=\\"pf"),
          });
        }
        return {
          pageCount: extracted.length,
          source: "next-data",
          extracted,
          leftoverOrig: [],
          xhr1: null,
          dump: { keys: Object.keys(nextList[0] || {}) },
          sample: extracted.slice(0, 3),
          htmlUrls: [],
          firstVisible: null,
          btn: !!document.getElementById("doc2pdf-btn"),
          html2canvas: typeof html2canvas,
        };
      }
      const dm = window.docManager;
      const list = doc2pdf.scribdPageList(dm);
      const fromHtml = list.length ? [] : doc2pdf.scribdPagesFromHtml(document.documentElement.innerHTML);
      const pages = list.length ? list : fromHtml;
      const raw0 = pages[0];
      const dump = raw0 && typeof raw0 === "object" ? {
        keys: Object.keys(raw0),
        own: Object.getOwnPropertyNames(raw0),
        proto: raw0.constructor?.name,
        types: Object.fromEntries(Object.getOwnPropertyNames(raw0).map((k) => {
          try {
            const v = raw0[k];
            const t = v == null ? String(v) : typeof v;
            if (typeof v === "string") return [k, t + ":" + v.slice(0, 100)];
            if (typeof v === "number" || typeof v === "boolean") return [k, t + ":" + v];
            if (v && v.nodeType) return [k, "node:" + v.nodeName + (v.id ? "#" + v.id : "")];
            if (typeof v === "function") return [k, "fn"];
            return [k, t];
          } catch (e) { return [k, "err"]; }
        })),
        load: typeof raw0.load,
        display: typeof raw0.display,
        turnOnImages: typeof raw0.turnOnImages,
        innerHTML: raw0.innerPageElem ? String(raw0.innerPageElem.innerHTML).slice(0, 80) : null,
        innerLen: raw0.innerPageElem ? raw0.innerPageElem.innerHTML.length : 0,
      } : null;
      const htmlUrls = (document.documentElement.innerHTML.match(/https?:\\/\\/[^"'\\s]+\\/pages\\/[0-9]+-[a-z0-9]+\\.jsonp/gi) || []).slice(0, 5);
      const sample = pages.slice(0, 3).map((p) => ({
        pageNum: p.pageNum,
        hasContentUrl: !!p.contentUrl,
        origWidth: p.origWidth,
        origHeight: p.origHeight,
        contentUrl: p.contentUrl ? String(p.contentUrl).slice(0, 120) : null,
      }));

      async function htmlFromPage(p) {
        if (typeof p.load === "function" && !p.innerPageElem && !p.loadHasStarted) {
          try { p.load(); } catch {}
        }
        const t = Date.now() + 8000;
        while (!p.innerPageElem && Date.now() < t) await new Promise((r) => setTimeout(r, 50));
        try { p.display?.(); } catch {}
        try { if (!p._imagesTurnedOn) p.turnOnImages?.(); } catch {}
        const inner = p.innerPageElem;
        if (!inner) return { pageNum: p.pageNum, htmlLen: 0 };
        inner.querySelectorAll("img[orig]").forEach((img) => {
          const orig = String(img.getAttribute("orig") || "").replaceAll("http://html.scribd.com", "https://html.scribdassets.com");
          if (orig && !img.getAttribute("src")) img.setAttribute("src", orig);
          img.style.display = "block";
        });
        const html = doc2pdf.rewriteScribdImageHosts(inner.innerHTML);
        return {
          pageNum: p.pageNum,
          htmlLen: html.length,
          hasText: html.includes("text_layer"),
          srcCount: (html.match(/src="/g) || []).length,
          origCount: (html.match(/orig="/g) || []).length,
        };
      }
      const extracted = [];
      for (const p of pages) extracted.push(await htmlFromPage(p));
      let xhr1 = null;
      const jsonp = htmlUrls[0] || pages.find((p) => p.contentUrl)?.contentUrl;
      if (jsonp) {
        try {
          xhr1 = await new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open("GET", jsonp);
            x.withCredentials = true;
            x.onload = () => {
              const json = doc2pdf.parseJsonp(x.responseText);
              const html = doc2pdf.scribdPageHtml(json, x.responseText);
              resolve({ status: x.status, htmlLen: html.length, hasNewpage: html.includes("newpage") });
            };
            x.onerror = () => reject(new Error("xhr error"));
            x.send();
          });
        } catch (e) {
          xhr1 = { error: String(e?.message || e) };
        }
      }

      const btn = !!document.getElementById("doc2pdf-btn");
      const leftoverOrig = pages[0]?.innerPageElem
        ? [...pages[0].innerPageElem.querySelectorAll("img[orig]")].map((img) => ({
            orig: String(img.getAttribute("orig") || "").slice(0, 80),
            src: String(img.getAttribute("src") || "").slice(0, 80),
          }))
        : [];
      return {
        pageCount: pages.length,
        source: list.length ? "docManager" : fromHtml.length ? "html-fallback" : "none",
        firstVisible: dm?.firstVisiblePage
          ? { origWidth: dm.firstVisiblePage.origWidth, origHeight: dm.firstVisiblePage.origHeight }
          : null,
        dump,
        htmlUrls,
        sample,
        extracted,
        leftoverOrig,
        xhr1,
        btn,
        html2canvas: typeof html2canvas,
      };
    })()`,
    id++,
    true
  );

  let pdfProbe = null;
  try {
    pdfProbe = await evaluate(
      ws,
      `(async () => {
        if (typeof html2canvas !== "function") return { ok: false, reason: "no html2canvas" };
        const p = doc2pdf.scribdPageList(window.docManager)[0];
        let html = "";
        let w = 794;
        let h = 1123;
        if (p) {
          html = p.containerElem
            ? doc2pdf.rewriteScribdImageHosts(p.containerElem.outerHTML)
            : p.innerPageElem
              ? doc2pdf.rewriteScribdImageHosts(p.innerPageElem.innerHTML)
              : "";
          w = p.origWidth || w;
          h = p.origHeight || h;
        } else {
          const row = window.__NEXT_DATA__?.props?.pageProps?.pageDataList?.[0];
          html = doc2pdf.studocuPageMarkup(row, null);
          const img = document.querySelector("div[data-page-index='0'] .page-content img.bi");
          w = img?.naturalWidth || w;
          h = img?.naturalHeight || h;
        }
        if (!html) return { ok: false, reason: "no html" };
        const box = document.createElement("div");
        box.style.cssText = "position:absolute;left:-20000px;top:0;background:#fff;width:" + w + "px;height:" + h + "px";
        box.innerHTML = html;
        document.body.append(box);
        try {
          const canvas = await html2canvas(box, {
            scale: 1,
            useCORS: true,
            allowTaint: false,
            backgroundColor: "#ffffff",
            logging: false,
          });
          const bytes = doc2pdf.dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.8));
          if (!bytes) return { ok: false, reason: "toDataURL" };
          const pdf = doc2pdf.jpegPagesToPdf([{
            jpeg: bytes,
            pageWidthPx: w,
            pageHeightPx: h,
            imgWidth: canvas.width,
            imgHeight: canvas.height,
          }]);
          return {
            ok: !!(pdf && pdf[0] === 37),
            pdfLen: pdf && pdf.length,
            jpegLen: bytes.length,
            canvas: [canvas.width, canvas.height],
          };
        } catch (e) {
          return { ok: false, reason: String(e && e.message || e) };
        } finally {
          box.remove();
        }
      })()`,
      id++,
      true
    );
  } catch (e) {
    pdfProbe = { ok: false, reason: String(e.message || e) };
  }

  try {
    ws.close();
  } catch {}
  return { probe, ready, result, pdfProbe, nextId: id };
}

let chromeProc;
try {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  const chromeArgs = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    ...(HEADED ? [] : ["--headless=new", "--disable-gpu"]),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--window-size=1280,900",
    "--disable-blink-features=AutomationControlled",
    "--disable-extensions",
    "about:blank",
  ];
  chromeProc = spawn(CHROME, chromeArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const chromeOut = [];
  chromeProc.stdout.on("data", (d) => chromeOut.push(String(d)));
  chromeProc.stderr.on("data", (d) => chromeOut.push(String(d)));
  chromeProc.on("exit", (code) => {
    if (code) console.error("Chrome exited", code, chromeOut.join("").slice(0, 1500));
  });

  await waitDevtools(`http://127.0.0.1:${PORT}`);
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.log("Chrome:", ver.Browser);
  const browserWs = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    browserWs.addEventListener("open", res);
    browserWs.addEventListener("error", rej);
  });

  let id = 1;
  let failed = 0;
  for (const target of TARGETS) {
    console.log(`\n=== ${target.name}: ${target.url} ===`);
    try {
      const { probe, ready, result, pdfProbe, nextId } = await testUrl(browserWs, target, id);
      id = nextId;
      console.log("probe", JSON.stringify(probe, null, 2));
      console.log("docManager.pages ready?", ready);
      console.log("extract", JSON.stringify(result, null, 2));
      console.log("pdfProbe", JSON.stringify(pdfProbe, null, 2));
      const extractedOk =
        Array.isArray(result.extracted) &&
        result.extracted.length > 0 &&
        result.extracted.every((p) => p.htmlLen > 80);
      const ok = result.pageCount > 0 && result.source !== "none" && extractedOk && result.btn;
      if (!ok) {
        failed++;
        console.error(`FAIL ${target.name}`);
      } else {
        console.log(`PASS ${target.name}: ${result.pageCount} pages via ${result.source}`);
      }
    } catch (e) {
      failed++;
      console.error(`FAIL ${target.name}:`, e.message || e);
    }
  }

  try {
    browserWs.close();
  } catch {}
  if (failed) {
    console.error(`\n${failed} real-test thất bại`);
    process.exitCode = 1;
  } else {
    console.log("\nReal-test: tất cả target pass.");
  }
} finally {
  if (chromeProc && !chromeProc.killed) chromeProc.kill();
  await sleep(500);
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
}
