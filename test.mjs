// Self-check cho phần logic thuần trong lib.js (chạy: node test.mjs).
// lib.js là classic script gắn globalThis.doc2pdf — bọc bằng new Function để chạy trong Node.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lib.js"), "utf8");
new Function(src)(); // gắn globalThis.doc2pdf
const {
  parseJsonp,
  studocuPageUrl,
  studocuBgUrl,
  rewriteScribdImageHosts,
  cookieUrl,
  scribdPageList,
  scribdPageHtml,
  scribdPagesFromHtml,
  isDocPath,
  downloadFilename,
  dataUrlToBytes,
  jpegPagesToPdf,
  mapPool,
  studocuPageMarkup,
  studocuScanHtml,
  qualitySettings,
  pageRange,
  isAllowedFetch,
  isScribdCookieDomain,
  responseTextWithinLimit,
} = globalThis.doc2pdf;

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.error(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

async function checkRejects(name, fn, message) {
  try {
    await fn();
    check(name, "resolved", "rejected");
  } catch (error) {
    check(name, String(error?.message || error).includes(message), true);
  }
}

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
let streamCancelled = false;
let streamPulledAfterOverflow = false;
let streamStarted = false;
await checkRejects(
  "response streaming body too large",
  () =>
    responseTextWithinLimit(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("abcd"));
          },
          pull(controller) {
            if (streamStarted) {
              streamPulledAfterOverflow = true;
              controller.close();
            }
            streamStarted = true;
          },
          cancel() {
            streamCancelled = true;
          },
        })
      ),
      3
    ),
  "quá lớn"
);
check("response streaming cancels promptly", streamCancelled, true);
check("response streaming avoids extra pull", streamPulledAfterOverflow, false);

// parseJsonp
check("jsonp chuẩn", parseJsonp(`pageCb_3({"html":"<div>x</div>","n":1});`), {
  html: "<div>x</div>",
  n: 1,
});
check("jsonp không có dấu ; cuối", parseJsonp(`cb({"a":true})`), { a: true });
check("jsonp JSON hỏng -> null", parseJsonp(`cb({broken)`), null);
check("jsonp không khớp mẫu -> null", parseJsonp("chỉ là html thường"), null);
check("jsonp đầu vào rỗng -> null", parseJsonp(""), null);

// studocuPageUrl / studocuBgUrl
const access = {
  url: "https://cdn.studocu.com/",
  objectKey: "docs/abc/",
  signedQueryParams: { global: "?sig=xyz&exp=1" },
};
check("studocu page url", studocuPageUrl(access, 3), "https://cdn.studocu.com/docs/abc/3.page?sig=xyz&exp=1");
check("studocu bg url hex (16 -> 10)", studocuBgUrl(access, 16), "https://cdn.studocu.com/bg10.png?sig=xyz&exp=1");
check("studocu bg url hex (1 -> 1)", studocuBgUrl(access, 1), "https://cdn.studocu.com/bg1.png?sig=xyz&exp=1");
check("studocu thiếu access -> null", studocuPageUrl(null, 1), null);
check("studocu thiếu objectKey -> null", studocuPageUrl({ url: "https://x/" }, 1), null);
check("studocu không có params -> url trần", studocuBgUrl({ url: "https://x/", objectKey: "k/" }, 2), "https://x/bg2.png");

const liveAccess = {
  url: "https://doc-assets.studocu.com/hash/html/",
  objectKey: "hash",
  signedQueryParams: {
    png: "?P=png",
    html: "?P=html",
    pages: [{ pageNumber: 2, signedQueryParams: "?P=p2" }],
  },
};
check("studocu page url chữ ký từng trang", studocuPageUrl(liveAccess, 2), "https://doc-assets.studocu.com/hash/html/hash2.page?P=p2");
check("studocu page url fallback html", studocuPageUrl(liveAccess, 3), "https://doc-assets.studocu.com/hash/html/hash3.page?P=html");
check("studocu bg png không gắn objectKey", studocuBgUrl(liveAccess, 1), "https://doc-assets.studocu.com/hash/html/bg1.png?P=png");
check(
  "studocu markup wrapper + pageHtml",
  studocuPageMarkup({ pageHtml: "<p>x</p>", pageHtmlWrapper: '<div id="pf1">' }, null),
  '<div id="pf1"><p>x</p></div>'
);
check(
  "studocu markup fetched",
  studocuPageMarkup({ pageHtmlWrapper: '<div id="pf2">' }, "<p>y</p>"),
  '<div id="pf2"><p>y</p></div>'
);
check("studocu markup rỗng", studocuPageMarkup(null, ""), "");
check("studocu scan html dùng bg png", studocuScanHtml(liveAccess, 1).includes("bg1.png?P=png"), true);
check("studocu scan html thiếu url -> rỗng", studocuScanHtml({}, 1), "");

// rewriteScribdImageHosts
check(
  "scribd đổi host ảnh http -> https",
  rewriteScribdImageHosts('<img src="http://html.scribd.com/1.jpg"><img src="https://html.scribd.com/2.jpg">'),
  '<img src="https://html.scribdassets.com/1.jpg"><img src="https://html.scribd.com/2.jpg">'
);
check("scribd đầu vào null -> chuỗi rỗng", rewriteScribdImageHosts(null), "");

// cookieUrl
check("cookie secure", cookieUrl({ secure: true, domain: ".scribd.com", path: "/" }), "https://scribd.com/");
check("cookie thường", cookieUrl({ secure: false, domain: "www.studocu.com", path: "/docs" }), "http://www.studocu.com/docs");

// scribdPageList — Scribd lưu pages theo pageNum (1-based object), không phải Array
const p1 = { pageNum: 1, contentUrl: "https://html.scribdassets.com/x/pages/1-aa.jsonp", origWidth: 612, origHeight: 792 };
const p2 = { pageNum: 2, contentUrl: "https://html.scribdassets.com/x/pages/2-bb.jsonp", origWidth: 612, origHeight: 792 };
check("scribd pages là object map", scribdPageList({ pages: { 1: p1, 2: p2 } }), [p1, p2]);
check("scribd pages là array", scribdPageList({ pages: [p1, p2] }), [p1, p2]);
check("scribd pages sparse array (index 0 trống)", scribdPageList({ pages: [, p1, p2] }), [p1, p2]);
check("scribd pages object lệch thứ tự key", scribdPageList({ pages: { 2: p2, 1: p1 } }), [p1, p2]);
check("scribd thiếu docManager -> []", scribdPageList(null), []);
check("scribd pages rỗng -> []", scribdPageList({ pages: {} }), []);

// scribdPageHtml — JSONP hiện tại là callback(["<html>"]), không còn {html: "..."}
check(
  "scribd jsonp mảng html",
  scribdPageHtml(parseJsonp(`window.page1_callback(["<div class=\\"newpage\\">x</div>"]);`)),
  '<div class="newpage">x</div>'
);
check("scribd jsonp object html", scribdPageHtml({ html: "<p>a</p>" }), "<p>a</p>");
check("scribd jsonp object content", scribdPageHtml({ content: "<p>b</p>" }), "<p>b</p>");
check("scribd jsonp null -> chuỗi rỗng", scribdPageHtml(null, ""), "");

// scribdPagesFromHtml — fallback khi không đọc được window.docManager.pages
check(
  "scribd html trích contentUrl jsonp",
  scribdPagesFromHtml(
    `pageParams.contentUrl = "https://html.scribdassets.com/abc/pages/1-deadbeef.jsonp";\n` +
      `pageParams.contentUrl = "https://html.scribdassets.com/abc/pages/2-cafebabe.jsonp";`
  ),
  [
    { pageNum: 1, contentUrl: "https://html.scribdassets.com/abc/pages/1-deadbeef.jsonp" },
    { pageNum: 2, contentUrl: "https://html.scribdassets.com/abc/pages/2-cafebabe.jsonp" },
  ]
);

// rewriteScribdImageHosts: giống studotools — orig=http://html.scribd.com → src=https://html.scribdassets.com + display:block
check(
  "scribd ảnh orig -> src https (studotools)",
  rewriteScribdImageHosts('<img class="absimg" orig="http://html.scribd.com/x/images/1-aa.png"/>'),
  '<img class="absimg" style="display: block;" src="https://html.scribdassets.com/x/images/1-aa.png"/>'
);

// path: studotools (/doc|/document|/presentation) + greasyfork (/embeds)
check("path scribd /document/", isDocPath("/document/123/title", "scribd"), true);
check("path scribd /doc/", isDocPath("/doc/123/title", "scribd"), true);
check("path scribd /presentation/", isDocPath("/presentation/123/slides", "scribd"), true);
check("path scribd /embeds/", isDocPath("/embeds/123/content", "scribd"), true);
check("path scribd search -> false", isDocPath("/search", "scribd"), false);
check("path studocu /en/document/", isDocPath("/en/document/1/x", "studocu"), true);

check("tên file bỏ ký tự cấm", downloadFilename('A<>:"/\\|?*B.pdf', "pdf"), "A B.pdf");
check("tên file rỗng -> document.pdf", downloadFilename("   ", "pdf"), "document.pdf");
check("tên file html", downloadFilename("CV Factory Manager", "html"), "CV Factory Manager.html");

const tinyJpeg =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/9k=";
const jpegBytes = dataUrlToBytes(tinyJpeg);
check("dataUrl jpeg có SOI", jpegBytes && jpegBytes[0] === 0xff && jpegBytes[1] === 0xd8, true);
const pdf = jpegPagesToPdf([
  { jpeg: jpegBytes, pageWidthPx: 902, pageHeightPx: 1167, imgWidth: 1, imgHeight: 1 },
  { jpeg: jpegBytes, pageWidthPx: 902, pageHeightPx: 1167, imgWidth: 1, imgHeight: 1 },
]);
const pdfHead = String.fromCharCode(...pdf.slice(0, 8));
check("pdf magic", pdfHead.startsWith("%PDF-1."), true);
check("pdf EOF", String.fromCharCode(...pdf.slice(-6)).includes("EOF"), true);
check("pdf 2 trang", pdf && new TextDecoder().decode(pdf).includes("/Count 2"), true);

const pooled = await mapPool([1, 2, 3], 2, async (n) => n * 2);
check("mapPool giữ thứ tự", pooled, [2, 4, 6]);
check("mapPool rỗng", await mapPool([], 3, async (n) => n), []);
check("mapPool thiếu fn -> []", await mapPool([1], 2, null), []);

let running = 0;
let maxRun = 0;
await mapPool([1, 2, 3, 4], 2, async () => {
  running++;
  maxRun = Math.max(maxRun, running);
  await new Promise((r) => setTimeout(r, 20));
  running--;
});
check("mapPool không vượt limit", maxRun <= 2, true);
check("mapPool có chạy song song", maxRun === 2, true);

if (failed) {
  console.error(`\n${failed} test thất bại`);
  process.exit(1);
}
console.log("\nTất cả test đều pass.");
