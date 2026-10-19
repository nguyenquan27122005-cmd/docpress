import base64
import io
import json
import argparse
import tempfile
import time
from pathlib import Path

import pymupdf as fitz
from PIL import Image
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

parser = argparse.ArgumentParser(description='Reproduce the 2026-10-19 browser audit on controlled fixtures.')
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
SOURCE = parser.parse_args().source.resolve()
HERE = Path(tempfile.mkdtemp(prefix='docpress-audit-fixtures-'))
print('Evidence directory:', HERE)
if not (SOURCE / 'manifest.json').is_file():
    raise SystemExit('Extension manifest not found; pass --source with the repository root.')
RESULT = {'cases': [], 'console': [], 'pageErrors': [], 'requests': []}
image = Image.new('RGB', (80, 60), (220, 30, 200))
image_bytes = io.BytesIO()
image.save(image_bytes, format='PNG')
PNG = image_bytes.getvalue()
DATA = 'data:image/png;base64,' + base64.b64encode(PNG).decode()

def markup(n, image_src=DATA):
    color = '#ffe0a0' if n == 1 else '#b0e0ff'
    return f'<div style="width:300px;height:400px;background:{color};font-family:Arial;color:#111"><h1 style="margin:0;padding:20px;font-size:24px">AUDIT PAGE {n}</h1><p style="padding:10px">Visible document content {n}</p><img src="{image_src}" style="width:80px;height:60px;margin-left:20px"></div>'

def fixture(provider, kind):
    title = f'Audit {provider} {kind}'
    if provider == 'studocu':
        if kind == 'missing':
            script = ''
        else:
            src = 'https://assets.studocu.com/audit-broken.png' if kind == 'broken-image' else DATA
            src = 'https://assets.studocu.com/audit-slow.png' if kind == 'cancel' else src
            rows = [{'pageNumber': n, 'width': 300, 'height': 400, 'pageHtml': markup(n, src)} for n in (1, 2)]
            data = {'props': {'pageProps': {'documentAccess': {'url': 'https://assets.studocu.com/', 'objectKey': 'audit-'}, 'pageDataList': rows}}}
            script = 'window.__NEXT_DATA__=' + json.dumps(data) + ';'
        return f'<!doctype html><html><head><title>{title}</title></head><body><h2>Controlled Studocu fixture</h2><script>{script}</script></body></html>'
    if kind == 'jsonp':
        script = 'window.docManager={pages:{1:{pageNum:1,origWidth:300,origHeight:400,contentUrl:"https://html.scribdassets.com/audit/pages/1-audit.jsonp"}}};'
        body = '<h2>Controlled Scribd JSONP fixture</h2>'
    else:
        src = 'https://html.scribdassets.com/audit-wildcard.png' if kind == 'wildcard-image' else DATA
        body = '<div id="p1">' + markup(1, src) + '</div><div id="p2">' + markup(2, src) + '</div>'
        script = 'window.docManager={pages:{1:{pageNum:1,origWidth:300,origHeight:400,innerPageElem:document.querySelector("#p1"),containerElem:document.querySelector("#p1")},2:{pageNum:2,origWidth:300,origHeight:400,innerPageElem:document.querySelector("#p2"),containerElem:document.querySelector("#p2")}}};'
    return f'<!doctype html><html><head><title>{title}</title></head><body>{body}<script>{script}</script></body></html>'

def save_pdf(download, label):
    target = HERE / (label + '.pdf')
    download.save_as(target)
    doc = fitz.open(target)
    info = {'filename': download.suggested_filename, 'bytes': target.stat().st_size, 'magic': target.read_bytes()[:8].decode('ascii'), 'pages': len(doc), 'text': [], 'sizes': [], 'images': [], 'samplePixels': []}
    for n, page in enumerate(doc):
        info['text'].append(page.get_text())
        info['sizes'].append(list(page.rect))
        info['images'].append(len(page.get_images()))
        pix = page.get_pixmap(matrix=fitz.Matrix(96 / 72, 96 / 72))
        pix.save(HERE / (label + f'-page-{n + 1}.png'))
        im = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
        info['samplePixels'].append({'background': im.getpixel((290, 390)), 'image': im.getpixel((40, 170))})
    doc.close()
    return info

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(str(HERE / 'chromium-extension-profile'), channel='chromium', headless=True, accept_downloads=True, args=[f'--disable-extensions-except={SOURCE}', f'--load-extension={SOURCE}', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'])
    try:
        RESULT['browser'] = context.browser.version
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker', timeout=15000)
        RESULT['serviceWorker'] = worker.url
        RESULT['extensionVersion'] = worker.evaluate('chrome.runtime.getManifest().version')
        worker.evaluate('chrome.storage.local.set({unblurEnabled:false})')
        extension_id = worker.url.split('/')[2]
        popup = context.new_page()
        popup.goto(f'chrome-extension://{extension_id}/popup.html')
        popup.locator('#unblur').wait_for()
        RESULT['popupInitialOptOut'] = popup.locator('#unblur').is_checked()
        popup.locator('#unblur').check()
        popup.reload()
        RESULT['popupPersistenceOn'] = popup.locator('#unblur').is_checked()
        popup.locator('#unblur').uncheck()
        popup.reload()
        RESULT['popupPersistenceOff'] = not popup.locator('#unblur').is_checked()
        popup.close()
        # Playwright context routes do not intercept extension-worker fetches.
        # Stub only the controlled worker network response; keep the real
        # message bridge, request validation, timeout and response reader intact.
        worker.evaluate('''body => {
          const nativeFetch = globalThis.fetch;
          globalThis.__auditWorkerFetches = [];
          globalThis.fetch = (url, options) => {
            if (String(url).includes('/audit/pages/')) {
              globalThis.__auditWorkerFetches.push({url:String(url),credentials:options?.credentials,redirect:options?.redirect});
              return Promise.resolve(new Response(body, {status:200,headers:{'Content-Type':'application/javascript'}}));
            }
            return nativeFetch(url, options);
          };
        }''', 'window.page1_callback(' + json.dumps([markup(1)]) + ');')

        def route_handler(route):
            url = route.request.url
            RESULT['requests'].append({'url': url, 'resourceType': route.request.resource_type, 'serviceWorker': bool(route.request.service_worker)})
            if '/audit/pages/' in url:
                body = 'window.page1_callback(' + json.dumps([markup(1)]) + ');'
                if route.request.service_worker:
                    route.fulfill(status=200, content_type='application/javascript', body=body)
                else:
                    route.abort('failed')
            elif url.endswith('audit-wildcard.png'):
                route.fulfill(status=200, content_type='image/png', headers={'Access-Control-Allow-Origin': '*'}, body=PNG)
            elif url.endswith('audit-broken.png'):
                route.fulfill(status=404, body='Missing controlled fixture image')
            elif url.endswith('audit-slow.png'):
                route.abort('timedout')
            elif '/audit/' in url:
                provider = 'scribd' if 'scribd.com/' in url else 'studocu'
                kind = url.rsplit('/', 1)[-1]
                route.fulfill(status=200, content_type='text/html', body=fixture(provider, kind))
            else:
                route.continue_()

        context.route('**/*', route_handler)
        page = context.new_page()
        page.on('console', lambda msg: RESULT['console'].append({'type': msg.type, 'text': msg.text}))
        page.on('pageerror', lambda err: RESULT['pageErrors'].append(str(err)))

        def navigate(provider, kind):
            domain = 'www.scribd.com' if provider == 'scribd' else 'www.studocu.com'
            page.goto(f'https://{domain}/document/audit/{kind}')
            page.locator('#doc2pdf-start').wait_for()

        def capture(provider, kind, label, start=None, end=None):
            navigate(provider, kind)
            if start is not None:
                page.locator('#doc2pdf-from').fill(str(start))
            if end is not None:
                page.locator('#doc2pdf-to').fill(str(end))
            began = time.monotonic()
            try:
                with page.expect_download(timeout=35000) as pending:
                    page.locator('#doc2pdf-start').click()
                info = save_pdf(pending.value, label)
                RESULT['cases'].append({'name': label, 'seconds': round(time.monotonic() - began, 2), 'status': page.locator('#doc2pdf-status').inner_text(), 'pdf': info})
            except PlaywrightTimeout:
                RESULT['cases'].append({'name': label, 'seconds': round(time.monotonic() - began, 2), 'status': page.locator('#doc2pdf-status').inner_text(), 'download': False})
            (HERE / 'runtime-results.json').write_text(json.dumps(RESULT, indent=2, ensure_ascii=False), encoding='utf-8')

        capture('studocu', 'inline', 'studocu-inline')
        capture('studocu', 'inline', 'studocu-range-2', 2, 2)
        capture('scribd', 'dom', 'scribd-dom')
        capture('scribd', 'jsonp', 'scribd-jsonp-bridge')
        RESULT['workerFixtureFetches'] = worker.evaluate('globalThis.__auditWorkerFetches')
        RESULT['workerNetworkFixture'] = 'worker fetch stub returns controlled JSONP; actual extension relay and response reader execute'

        for provider, kind in [('studocu', 'missing'), ('studocu', 'broken-image'), ('scribd', 'wildcard-image')]:
            navigate(provider, kind)
            downloads = []
            on_download = lambda download: downloads.append(download)
            page.on('download', on_download)
            page.locator('#doc2pdf-start').click()
            page.wait_for_function('document.querySelector("#doc2pdf-btn").shadowRoot.querySelector("#doc2pdf-start").textContent.includes("PDF")')
            RESULT['cases'].append({'name': provider + '-' + kind, 'status': page.locator('#doc2pdf-status').inner_text(), 'downloads': len(downloads), 'controlsRestored': not page.locator('#doc2pdf-from').is_disabled(), 'stageRemoved': page.locator('#doc2pdf-print').count() == 0})
            page.remove_listener('download', on_download)

        navigate('studocu', 'inline')
        page.locator('#doc2pdf-from').fill('3')
        page.locator('#doc2pdf-start').click()
        page.wait_for_function('document.querySelector("#doc2pdf-btn").shadowRoot.querySelector("#doc2pdf-status").textContent.includes("vượt quá")')
        RESULT['cases'].append({'name': 'out-of-range', 'status': page.locator('#doc2pdf-status').inner_text()})
        page.evaluate('history.pushState({}, "", "/search")')
        page.locator('#doc2pdf-btn').wait_for(state='detached')
        absent = page.locator('#doc2pdf-btn').count() == 0
        page.evaluate('history.pushState({}, "", "/document/audit/inline")')
        page.locator('#doc2pdf-start').wait_for()
        RESULT['cases'].append({'name': 'spa-widget', 'removedOnSearch': absent, 'restoredOnDocument': page.locator('#doc2pdf-btn').count() == 1})
        page.evaluate('window.postMessage(null, location.origin)')
        page.wait_for_timeout(200)

        by_name = {case['name']: case for case in RESULT['cases']}
        for name, count in [('studocu-inline', 2), ('studocu-range-2', 1), ('scribd-dom', 2), ('scribd-jsonp-bridge', 1)]:
            assert by_name[name].get('pdf', {}).get('pages') == count, name + ': expected PDF not downloaded'
            expected_colors = [(176, 224, 255)] if name == 'studocu-range-2' else [(255, 224, 160), (176, 224, 255)][:count]
            for pixels, expected in zip(by_name[name]['pdf']['samplePixels'], expected_colors):
                assert all(abs(a - b) <= 3 for a, b in zip(pixels['background'], expected)), name + ': wrong page content/order'
                assert all(abs(a - b) <= 3 for a, b in zip(pixels['image'], (220, 30, 200))), name + ': image marker missing'
        assert len(RESULT['workerFixtureFetches']) == 1, 'Expected the real worker message path to execute once'
        assert RESULT['popupPersistenceOn'] and RESULT['popupPersistenceOff'], 'Popup setting did not persist'
        for name in ['studocu-missing', 'studocu-broken-image', 'scribd-wildcard-image']:
            case = by_name[name]
            assert case['downloads'] == 0 and case['controlsRestored'] and case['stageRemoved'], name
        assert by_name['spa-widget']['removedOnSearch'] and by_name['spa-widget']['restoredOnDocument']
        assert any('event.data' in error for error in RESULT['pageErrors']), 'Expected baseline null-message exception'
        RESULT['live'] = []
        (HERE / 'runtime-results.json').write_text(json.dumps(RESULT, indent=2, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'browser': RESULT['browser'], 'serviceWorker': RESULT['serviceWorker'], 'cases': RESULT['cases'], 'live': RESULT['live'], 'pageErrors': RESULT['pageErrors']}, indent=2, ensure_ascii=False))
    finally:
        context.close()
