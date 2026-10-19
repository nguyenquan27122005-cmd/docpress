# Browser regressions and 2026-10-19 audit reproductions

These probes load the actual unpacked extension into a fresh Chromium profile and serve controlled fixtures at supported provider origins. By default they verify the corrected behavior in 1.2.1. They do not visit live provider pages unless `--live` is supplied, and never modify extension source.

Use Python 3.10 or newer. From the repository root:

```powershell
python -m pip install -r audits/2026-10-19/requirements.txt
python -m playwright install chromium
python -X utf8 audits/2026-10-19/browser_fixtures.py
python -X utf8 audits/2026-10-19/edge_cases.py
```

The source root defaults to two levels above each script. To audit another checkout, pass `--source /path/to/checkout`.

Each run prints the path of a newly created operating-system temporary directory. PDFs, PNG previews, JSON results, and an isolated browser profile are written there. The scripts leave those local artifacts available for inspection. Do not commit browser profiles or document downloads.

`browser_fixtures.py` checks real PDF downloads and image pixels, page order/range, public wildcard-CORS images, clipped Scribd sprites at viewer zoom, popup persistence, error cleanup, SPA lifecycle, and safe null-message handling. The bridge fixture aborts page fetch/XHR and stubs only the worker's network response for its controlled JSONP URL; the real isolated relay, worker request validation and bounded response reader still execute. It demonstrates the messaging/conversion path, not live CDN compatibility.

`edge_cases.py` verifies cancellation of a pending image request and full Studocu page bounds without row dimensions, including a small page, absolutely positioned content, and a scan at its natural image size. Its main PDF/PNG must retain the bottom-right green marker.

Exit status zero means the selected expectations passed. To reproduce the original defects against a separate baseline checkout, use `--source /path/to/baseline --expect-baseline-bugs` on both scripts. That optional mode deliberately expects the original wildcard-CORS failure, missing-dimension cropping and null-message exception; the default mode expects those defects to be fixed.

`npm run test:real` invokes this script with `--live`. It loads the actual extension with automatic preview-cookie removal disabled, waits for public document data, clicks page 1 export and validates the downloaded one-page PDF. Provider blocks or missing data/downloads return nonzero. Rendered PNGs allow manual visual checks; successful download alone is not a visual-completeness assertion. Use `--headed` to show the isolated browser. The former separate injected PDF probe was removed in 1.2.1.
