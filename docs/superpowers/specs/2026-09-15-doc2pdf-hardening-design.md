# doc2pdf Hardening Design

**Date:** 2026-09-15
**Status:** Approved direction; awaiting written-spec review

## Goal

Make doc2pdf reliable for long documents, safer at extension trust boundaries,
usable across single-page navigation, and easier to control without replacing
the current raster-PDF engine or adding dependencies.

## Scope

This change will:

- render one selected page at a time instead of building a render tree for the
  whole document;
- cap image downloads at four concurrent requests and revoke every temporary
  object URL;
- provide Auto, High, Balanced, and Small quality presets;
- let the user select a contiguous page range, cancel an export, and see an
  estimated output size after the first rendered page;
- add and remove the export widget as SPA routes enter and leave document URLs;
- validate bridge requests against the sender, protocol, site family, timeout,
  and response-size limit;
- constrain `sd_docs` deletion to Scribd and expose an on/off setting;
- remove the unreliable HTML fallback and report actionable PDF errors;
- strengthen pure and live tests, update documentation and release metadata,
  and rebuild the distributable ZIP.

## Non-goals

- Searchable or selectable PDF text is not included. It requires reconstructing
  text coordinates, fonts, and glyph mappings that differ by provider and would
  make the current robust raster path substantially more fragile.
- Non-contiguous page expressions such as `1-3,7,10-12` are not included. Two
  numeric From/To inputs cover the useful case with much less parsing and UI.
- Partial PDFs are not downloaded after failure or cancellation. A partial file
  is easy to mistake for a complete export.
- No package manager, build system, PDF library, queue dependency, or UI
  framework will be added.

## Architecture

The Manifest V3 structure remains small:

- `content.js` stays in the main world because Scribd exposes `docManager` and
  Studocu exposes `__NEXT_DATA__` there. It owns extraction, the floating UI,
  per-page rendering, progress, cancellation, and download.
- `bridge.js` remains an isolated-world relay for the one operation the main
  world cannot perform directly: a privileged cross-origin extension fetch. It validates
  message shape before forwarding.
- `background.js` remains the privileged boundary. It validates both the
  content-script sender and requested URL, performs bounded fetches, and handles
  the opt-out unblur setting.
- `lib.js` owns pure policy and parsing functions so range, quality, domain, and
  PDF behavior stay testable in Node.
- `popup.html` and `popup.js` provide one extension setting: automatic removal
  of Scribd's `sd_docs` cookie. The default remains enabled for backward
  compatibility, but the user can disable it at any time.

This preserves the working provider integration and hardens its boundaries
without a risky main-world/isolated-world rewrite.

## Export UI and SPA Lifecycle

The existing floating button becomes a small shadow-DOM widget so host-page CSS
cannot restyle it. On document routes it offers:

- From page, default `1`;
- To page, blank meaning the final available page;
- Quality, default `Auto`;
- Start PDF;
- progress/status text with `aria-live="polite"`.

While exporting, Start becomes Cancel. Cancellation uses one `AbortController`
per export. Fetch/XHR work is aborted immediately; `html2canvas` cannot be
interrupted internally, so cancellation completes immediately after the active
page capture returns. Controls are restored in one `finally` block.

A `syncWidget()` function checks the current pathname. A lightweight
`MutationObserver`, plus `popstate` and `hashchange`, calls it. The widget is
created only on supported document routes and removed when leaving them. The
observer callback only compares the last URL before touching the DOM.

## Page Selection and Quality Policy

`lib.js` will expose pure helpers that:

- normalize From/To against the discovered total;
- reject non-integers, values below 1, From greater than To, and From greater
  than the document length;
- return the selected inclusive slice and user-facing range metadata;
- resolve a quality preset to `scale` and JPEG quality.

Quality values are:

| Preset | Scale | JPEG quality |
|---|---:|---:|
| High | 2 | 0.92 |
| Balanced | 1.5 | 0.88 |
| Small | 1 | 0.80 |

Auto uses the number of selected pages:

- 1-40 pages: High;
- 41-100 pages: Balanced;
- over 100 pages: Small.

Only selected pages are loaded and rendered. After each captured page, the UI
estimates final PDF size from the rolling average JPEG byte length multiplied by
the selected page count. The value is explicitly labelled an estimate.

## Long-document Pipeline

Extraction keeps provider page descriptors and HTML strings, but the renderer
uses a single off-screen page container:

1. Insert one page's HTML.
2. Fetch its non-data images through the existing `doc2pdf.mapPool` with a
   concurrency limit of four.
3. Assign object URLs, wait with timeout/abort support, and retain the URLs in a
   page-local list.
4. Capture the page with the resolved quality settings.
5. Convert the canvas to JPEG, release the canvas backing store, clear the page
   container, and revoke all page-local object URLs in `finally`.
6. Retain only JPEG bytes and dimensions required by the existing PDF writer.

The PDF writer remains unchanged initially because the final JPEG payload must
exist until the cross-reference table is generated. Rendering one DOM page at a
time, lowering scale for long documents, and avoiding leaked object URLs remove
the largest avoidable memory costs without inventing a streaming PDF subsystem.

## Privileged Fetch Boundary

`lib.js` will expose a pure request-policy helper consumed by
`background.js`. A bridge request is accepted only when:

- the requested URL uses HTTPS;
- `sender.url` is a supported Studocu or Scribd page;
- the requested hostname belongs to the same provider family as the sender;
- Scribd requests target only `scribd.com` or `scribdassets.com` subdomains;
- Studocu requests target only the currently supported Studocu/Studeersnel
  domains;
- the response is no larger than 5 MiB, checked using both `Content-Length`
  when present and the raw response body byte length;
- the request finishes within 20 seconds.

The background fetch includes provider credentials and returns stable
error codes/messages for invalid sender, URL, host, timeout, oversized response,
HTTP error, and network error. The
bridge accepts only a positive integer request ID and string URL, and echoes
only the matching response shape. This does not pretend the host page is a
trusted caller; it limits the relay to resources from that page's provider.

## Cookie Setting

The manifest gains `storage` permission and an action popup. The popup contains
one labelled checkbox and a short explanation. Its value is stored under
`unblurEnabled` in `chrome.storage.local`, defaulting to `true` to preserve
current behavior.

The cookie listener removes a cookie only when all conditions hold:

- the setting is enabled;
- the cookie was added or updated rather than removed;
- its name is exactly `sd_docs`;
- its normalized domain is `scribd.com` or a Scribd subdomain.

Cookie removal failures are caught so an unavailable cookie store cannot crash
the service worker.

## Failure Behavior

The HTML fallback is removed because it omits provider CSS/fonts and references
temporary or remote resources, so a successful download can still be unusable.
On PDF failure the widget instead identifies the failed page and recommends
retrying with a smaller range or lower quality. Cancellation reports
`Đã hủy` and never appears as an error. All temporary DOM, object URLs, XHRs,
and the download URL are cleaned up in `finally` paths.

## Testing

`test.mjs` remains the fast dependency-free suite and gains cases for:

- every Auto threshold and explicit quality preset;
- valid, defaulted, clamped, reversed, fractional, and out-of-range page input;
- allowed and rejected sender/request pairs, including HTTP, cross-provider,
  lookalike domains, and malformed URLs;
- exact Scribd cookie-domain matching.

`real-test.mjs` continues testing live provider extraction and one-page PDF
generation. A target passes only when extraction succeeds, the widget exists,
and `pdfProbe.ok === true`; a failed PDF probe must set a non-zero exit code.
The test's temporary Chrome profile remains ignored by Git and is removed in
`finally`.

Because current Chrome does not load an unpacked extension through the existing
automated CDP path, README will contain a short release smoke checklist covering
the remaining real-extension boundaries: popup persistence, bridge fallback,
SPA navigation, cancellation, download, and unblur toggle.

## Release and Success Criteria

The manifest version becomes `1.2.0`. `README.md` documents the controls,
quality policy, cancellation delay, PDF-only failure behavior, unblur setting,
tests, and the smoke checklist. `doc2pdf.zip` contains only runtime files and
README, including the new popup files.

The release is complete when:

- all JavaScript parses and `manifest.json` parses;
- every dependency-free test passes;
- both live targets pass with a successful PDF probe;
- the ZIP matches the release files byte-for-byte;
- the UTF-8/mojibake and whitespace checks remain clean;
- Git has focused commits and a clean working tree.
