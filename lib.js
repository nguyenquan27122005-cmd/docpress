// Logic thuần (không phụ thuộc DOM) — classic script vì content script MV3
// không chạy được ES module. Node test chạy qua new Function wrapper.
// Đây là nơi duy nhất chứa regex/patterns — khi trang đổi cấu trúc, sửa ở đây.

// Scribd trả nội dung trang dạng JSONP:  <tên hàm>( {...} );  — trả object bên
// trong, hoặc null nếu không khớp / JSON hỏng.
function parseJsonp(text) {
  const m = /^[^(]*\((.*)\);?\s*$/s.exec(String(text ?? "").trim());
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Studocu: URL HTML của trang, có chữ ký kèm theo:
// `${url}${objectKey}${pageNumber}.page${params}`
function studocuSign(documentAccess, pageNumber, kind) {
  const qs = documentAccess?.signedQueryParams;
  if (!qs || typeof qs !== "object") return "";
  if (kind === "page") {
    const per = Array.isArray(qs.pages)
      ? qs.pages.find((p) => Number(p.pageNumber) === Number(pageNumber))?.signedQueryParams
      : null;
    return per ?? qs.html ?? qs.global ?? "";
  }
  if (kind === "png") return qs.png ?? qs.global ?? "";
  return qs.global ?? "";
}

function studocuPageUrl(documentAccess, pageNumber) {
  if (!documentAccess?.url || !documentAccess?.objectKey) return null;
  return `${documentAccess.url}${documentAccess.objectKey}${pageNumber}.page${studocuSign(documentAccess, pageNumber, "page")}`;
}

// Ảnh nền scan: `${url}bg{hex}.png` + chữ ký png (không gắn objectKey — URL live + studotools).
function studocuBgUrl(documentAccess, pageNumber) {
  if (!documentAccess?.url) return null;
  return `${documentAccess.url}bg${pageNumber.toString(16)}.png${studocuSign(documentAccess, pageNumber, "png")}`;
}

// Studocu: pageHtml nằm trong pageHtmlWrapper (`<div id="pfN" class="pf ...">`).
function studocuScanHtml(documentAccess, pageNumber) {
  const bg = studocuBgUrl(documentAccess, pageNumber);
  if (!bg) return "";
  return `<div class="pc w0 h0"><img class="bi x0 y0 w1 h1" alt="" src="${bg}"></div>`;
}

function studocuPageMarkup(row, fetchedHtml) {
  const inner =
    (typeof row?.pageHtml === "string" && row.pageHtml) ||
    (typeof row?.html === "string" && row.html) ||
    (typeof fetchedHtml === "string" && fetchedHtml) ||
    "";
  const wrap = typeof row?.pageHtmlWrapper === "string" ? row.pageHtmlWrapper : "";
  if (!wrap) return inner;
  return `${wrap}${inner}</div>`;
}

// Scribd lưu docManager.pages theo pageNum (1, 2, 3…) — object/sparse array,
// không phải Array đặc. Trả danh sách page đã lọc, sort theo pageNum.
function scribdPageList(docManager) {
  const raw = docManager?.pages;
  if (raw == null || typeof raw !== "object") return [];
  const list = Array.isArray(raw) ? raw.filter(Boolean) : Object.values(raw).filter(Boolean);
  return list
    .filter((p) => p && typeof p === "object")
    .sort((a, b) => (Number(a.pageNum) || 0) - (Number(b.pageNum) || 0));
}

// JSONP trang: hiện tại window.pageN_callback(["<html>"]); trước đây {html|content}.
function scribdPageHtml(json, raw) {
  if (typeof json === "string") return json;
  if (Array.isArray(json)) {
    const first = json.find((x) => typeof x === "string" && x);
    return first ?? "";
  }
  if (json && typeof json === "object") {
    const html = json.html ?? json.pageHtml ?? json.content ?? json.body;
    if (typeof html === "string") return html;
  }
  return typeof raw === "string" ? raw : "";
}

// Fallback: quét contentUrl *.jsonp trong HTML/script của trang.
function scribdPagesFromHtml(html) {
  const text = String(html ?? "");
  const byNum = new Map();
  const re = /https?:\/\/[^"'\\\s]+\/pages\/(\d+)-[^"'\\\s]+\.jsonp/g;
  let m;
  while ((m = re.exec(text))) {
    const pageNum = Number(m[1]);
    const contentUrl = m[0].replaceAll("\\", "");
    if (!byNum.has(pageNum)) byNum.set(pageNum, { pageNum, contentUrl });
  }
  return [...byNum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, p]) => p);
}

// Ảnh scan Scribd dùng orig= (không có src). Đổi đúng như studotools:
// orig="http://html.scribd.com  →  style="display: block;" src="https://html.scribdassets.com
// rồi đổi nốt src= http còn lại.
function rewriteScribdImageHosts(html) {
  return String(html ?? "")
    .replace(/orig="http:\/\/html\.scribd\.com/g, 'style="display: block;" src="https://html.scribdassets.com')
    .replaceAll("http://html.scribd.com", "https://html.scribdassets.com");
}

// Trang tài liệu: Studocu /document/; Scribd /doc|/document|/presentation (studotools)
// và /embeds (Greasy Fork hay chuyển sang đây vì docManager ổn hơn).
function isDocPath(pathname, site) {
  const p = String(pathname ?? "");
  if (site === "scribd") return /\/(doc(ument)?|presentation|embeds)\//.test(p);
  if (site === "studocu") return /\/document\//.test(p);
  return false;
}

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

const STUDOCU_DOMAINS = ["studocu.com", "studeersnel.nl", "studocu.id", "studocu.vn"];

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
  const reader = response.body?.getReader?.();
  if (!reader) {
    const body = await response.arrayBuffer();
    if (body.byteLength > limit) throw new Error("Phản hồi quá lớn");
    return new TextDecoder().decode(body);
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value?.byteLength || 0;
    if (size > limit) {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // Cancellation is best effort; the size-limit error takes precedence.
      }
      throw new Error("Phản hồi quá lớn");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function downloadFilename(title, ext = "pdf") {
  let base = String(title ?? "document")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!base) base = "document";
  return `${base}.${ext}`;
}

function dataUrlToBytes(dataUrl) {
  const m = /^data:[^;]+;base64,(.+)$/s.exec(String(dataUrl ?? ""));
  if (!m) return null;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// PDF 1.4: mỗi trang một ảnh JPEG. pageWidthPx/pageHeightPx = khổ giấy (CSS px @96dpi).
function jpegPagesToPdf(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const enc = new TextEncoder();
  const parts = [];
  let pos = 0;
  const offsets = [];
  const put = (u8) => {
    parts.push(u8);
    pos += u8.length;
  };
  const putStr = (s) => put(enc.encode(s));

  putStr("%PDF-1.4\n");
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const n = pages.length;
  const pageIds = pages.map((_, i) => 3 + i * 3);

  function obj(id, dict, stream) {
    offsets[id] = pos;
    if (stream) {
      putStr(`${id} 0 obj\n${dict}\nstream\n`);
      put(stream);
      putStr("\nendstream\nendobj\n");
    } else {
      putStr(`${id} 0 obj\n${dict}\nendobj\n`);
    }
  }

  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);

  pages.forEach((p, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const jpeg = p.jpeg;
    const imgW = Math.max(1, Math.round(p.imgWidth || p.pageWidthPx || 1));
    const imgH = Math.max(1, Math.round(p.imgHeight || p.pageHeightPx || 1));
    const wPt = +((p.pageWidthPx || imgW) * 72 / 96).toFixed(2);
    const hPt = +((p.pageHeightPx || imgH) * 72 / 96).toFixed(2);
    obj(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    const content = enc.encode(`q ${wPt} 0 0 ${hPt} 0 0 cm /Im0 Do Q`);
    obj(contentId, `<< /Length ${content.length} >>`, content);
    obj(
      imageId,
      `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`,
      jpeg
    );
  });

  const xrefPos = pos;
  const maxId = 2 + n * 3;
  putStr(`xref\n0 ${maxId + 1}\n`);
  putStr("0000000000 65535 f \n");
  for (let id = 1; id <= maxId; id++) {
    putStr(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  putStr(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  const out = new Uint8Array(pos);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

// Dựng URL xoá cookie từ chính thuộc tính của cookie (background.js dùng).
function cookieUrl(cookie) {
  const protocol = cookie.secure ? "https:" : "http:";
  const domain = String(cookie.domain ?? "").replace(/^\./, "");
  const path = String(cookie.path || "/");
  return protocol + "//" + domain + path;
}

// Chạy fn trên từng phần tử, tối đa `limit` tác vụ cùng lúc, giữ thứ tự.
function mapPool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0 || typeof fn !== "function") return Promise.resolve([]);
  const out = new Array(list.length);
  let next = 0;
  const n = Math.max(1, Math.min(Number(limit) || 1, list.length));
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  }
  return Promise.all(Array.from({ length: n }, worker)).then(() => out);
}

const doc2pdf = {
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
};
globalThis.doc2pdf = doc2pdf;
