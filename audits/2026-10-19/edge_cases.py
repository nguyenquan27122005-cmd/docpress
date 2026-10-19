import json
import argparse
import tempfile
from urllib.parse import quote
from pathlib import Path
import pymupdf
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description='Reproduce baseline page clipping and cancellation behavior.')
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--expect-baseline-bugs', action='store_true')
args = parser.parse_args()
SOURCE = args.source.resolve()
HERE = Path(tempfile.mkdtemp(prefix='docpress-audit-edges-'))
print('Evidence directory:', HERE)
if not (SOURCE / 'manifest.json').is_file():
    raise SystemExit('Extension manifest not found; pass --source with the repository root.')
results = []
with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(str(HERE / 'edge-profile'), channel='chromium', headless=True, accept_downloads=True, args=[f'--disable-extensions-except={SOURCE}', f'--load-extension={SOURCE}'])
    try:
        page = context.new_page()
        pending = []
        downloads = []
        page.on('download', lambda download: downloads.append(download))
        def handle(route):
            if route.request.url.endswith('/slow.png'):
                pending.append(route)
                return
            mode = route.request.url.rsplit('/',1)[-1]
            if mode == 'cancel':
                html = '<img src="https://www.studocu.com/slow.png">'
            elif mode == 'small':
                html = '<div style="width:300px;height:400px;background:#b0e0ff">Small page</div>'
            elif mode == 'absolute':
                html = '<div style="position:absolute;left:0;top:0;width:1000px;height:1400px;background:#ffe0a0">Absolute page</div>'
            elif mode == 'scan':
                svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1225" height="1585"><rect width="1225" height="1585" fill="yellow"/></svg>'
                html = '<img style="display:block" src="data:image/svg+xml,' + quote(svg) + '">'
            else:
                html = '<div style="position:relative;width:1000px;height:1400px;background:#ffe0a0;font:30px Arial"><span style="position:absolute;top:20px;left:20px">TOP LEFT VISIBLE</span><span style="position:absolute;top:1320px;left:700px">BOTTOM RIGHT LOST</span><div style="position:absolute;top:1300px;left:900px;width:80px;height:80px;background:#00ff00"></div></div>'
            data = {'props':{'pageProps':{'documentAccess':{'url':'https://www.studocu.com/','objectKey':'audit-'},'pageDataList':[{'pageNumber':1,'pageHtml':html}]}}}
            body = '<!doctype html><title>Audit '+mode+'</title><body><script>window.__NEXT_DATA__='+json.dumps(data)+'</script></body>'
            route.fulfill(status=200,content_type='text/html',body=body)
        context.route('**/*',handle)
        page.goto('https://www.studocu.com/document/audit/no-dimensions')
        page.locator('#doc2pdf-start').wait_for()
        with page.expect_download() as download:
            page.locator('#doc2pdf-start').click()
        target = HERE / 'studocu-no-dimensions.pdf'
        download.value.save_as(target)
        pdf = pymupdf.open(target)
        pix = pdf[0].get_pixmap()
        pix.save(HERE / 'studocu-no-dimensions-page-1.png')
        marker = pix.pixel(700, 1000)[:3] if pix.width > 700 and pix.height > 1000 else None
        results.append({'case':'studocu-no-dimensions','sourceContentCssPx':[1000,1400],'expectedPdfPt':[750,1050],'actualPdfPt':[pdf[0].rect.width,pdf[0].rect.height],'status':page.locator('#doc2pdf-status').inner_text(),'bottomRightMarkerFits':pdf[0].rect.width >= 750 and pdf[0].rect.height >= 1050})
        pdf.close()
        if not args.expect_baseline_bugs:
            for mode, expected in [('small', [225, 300]), ('absolute', [750, 1050]), ('scan', [918.75, 1188.75])]:
                page.goto('https://www.studocu.com/document/audit/' + mode)
                with page.expect_download() as other:
                    page.locator('#doc2pdf-start').click()
                path = HERE / (mode + '.pdf')
                other.value.save_as(path)
                with pymupdf.open(path) as other_pdf:
                    actual = [other_pdf[0].rect.width, other_pdf[0].rect.height]
                    assert actual == expected, (mode, actual, expected)
                    print('PASS page bounds', mode, actual)
        page.goto('https://www.studocu.com/document/audit/cancel')
        page.locator('#doc2pdf-start').wait_for()
        before = len(downloads)
        page.locator('#doc2pdf-start').click()
        page.wait_for_timeout(100)
        assert pending, 'Image request should be pending before cancellation'
        page.locator('#doc2pdf-start').click()
        page.wait_for_function('document.querySelector("#doc2pdf-btn").shadowRoot.querySelector("#doc2pdf-status").textContent === "Đã hủy"')
        results.append({'case':'cancel-pending-image','status':page.locator('#doc2pdf-status').inner_text(),'downloads':len(downloads)-before,'controlsRestored':not page.locator('#doc2pdf-from').is_disabled(),'stageRemoved':page.locator('#doc2pdf-print').count()==0})
        for route in pending:
            try:
                route.abort()
            except Exception:
                pass
    finally:
        context.close()
(HERE / 'edge-results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False),encoding='utf-8')
print(json.dumps(results,indent=2,ensure_ascii=False))

if args.expect_baseline_bugs:
    assert not results[0]['bottomRightMarkerFits'], 'Baseline clipping was not reproduced'
else:
    assert results[0]['actualPdfPt'] == [750, 1050], 'Page without dimensions was cropped or resized'
    assert marker and marker[1] > 240 and marker[0] < 20 and marker[2] < 20, 'Bottom-right content missing'
assert results[1]['downloads'] == 0 and results[1]['controlsRestored'] and results[1]['stageRemoved'], 'Cancellation cleanup failed'
