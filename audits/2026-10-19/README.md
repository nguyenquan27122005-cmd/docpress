# 2026-10-19 audit reproductions

These probes reproduce observations from the runtime audit of baseline commit `c8df165597d8a792b454d1b8c5ddc5b5d95ef219`. They load the actual unpacked extension into a fresh Chromium profile and serve controlled fixtures at supported provider origins. They do not visit live provider pages or modify extension source.

Use Python 3.10 or newer. From the repository root:

```powershell
python -m pip install -r audits/2026-10-19/requirements.txt
python -m playwright install chromium
python -X utf8 audits/2026-10-19/browser_fixtures.py
python -X utf8 audits/2026-10-19/edge_cases.py
```

The source root defaults to two levels above each script. To audit another checkout, pass `--source /path/to/checkout`.

Each run prints the path of a newly created operating-system temporary directory. PDFs, PNG previews, JSON results, and an isolated browser profile are written there. The scripts leave those local artifacts available for inspection. Do not commit browser profiles or document downloads.

`browser_fixtures.py` checks real PDF downloads, page order/range, popup persistence, error cleanup, SPA widget lifecycle, and the known wildcard-image and null-message failures. The bridge fixture aborts page fetch/XHR and stubs only the worker's network response for its controlled JSONP URL; the real isolated relay, worker request validation and bounded response reader still execute. It demonstrates the messaging/conversion path, not live CDN compatibility.

`edge_cases.py` demonstrates successful cancellation of a pending image request and the known silent cropping of Studocu HTML without row dimensions. Open its PDF/PNG: the top-left text remains, while bottom-right text and a green marker are missing.

Exit status zero means the baseline observations were reproduced, including the documented defects. These scripts are audit reproductions, not release acceptance tests; a future fix can intentionally invalidate their defect assertions.

For live reproduction, use a fresh signed-out browser profile, load the extension manually, disable automatic preview-cookie removal, and open the public targets listed in `real-test.mjs`. Select only an already visible page and click the extension's PDF control. Compare its download/status and DevTools CORS errors with `npm run test:real`. The shipped test manually injects scripts and runs a separate one-page probe, so its PASS result alone does not establish that the control can export. Do not change preview/access controls or sign in for this reproduction.
