"""Live test: loads the real extension into Chrome, replaces tab capture with the test soundtrack
(test-harness.js), and checks what the unmodified offscreen.js decides in real time (~70 s).

Needs: pip install playwright, and Google Chrome or Chromium (set CHROME=/path/to/chrome if needed).
Exits with code 1 if any check fails.
"""
import json, os, shutil, statistics, sys, tempfile, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(HERE), 'extension')
OUT = os.path.join(HERE, 'out')
CHROME = os.environ.get('CHROME') or next((p for p in ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] if os.path.exists(p)), None)

HARNESS_HTML = '''<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="lib/ort.wasm.min.js"></script><script src="brain.js"></script>
<script src="offscreen.js"></script><script src="test-harness.js"></script></body></html>'''

if not os.path.exists(os.path.join(OUT, 'movie.wav')):
    sys.exit('Missing test/out/movie.wav — run: npm run test:audio')
if not CHROME:
    sys.exit('Chrome not found — set CHROME=/path/to/chrome')

# Temporarily place the harness inside the extension (removed again afterwards)
temp = {'test-harness.html': None, 'test-harness.js': os.path.join(HERE, 'test-harness.js'), 'movie.wav': os.path.join(OUT, 'movie.wav')}
for name, src in temp.items():
    dst = os.path.join(EXT, name)
    if src: shutil.copy(src, dst)
    else: open(dst, 'w').write(HARNESS_HTML)

errors, res, stored = [], None, None
profile = tempfile.mkdtemp(prefix='avt-chrome-')
try:
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            profile, executable_path=CHROME, headless=False,
            args=['--headless=new', f'--disable-extensions-except={EXT}', f'--load-extension={EXT}',
                  '--disable-features=DisableLoadExtensionCommandLineSwitch',
                  '--autoplay-policy=no-user-gesture-required', '--no-sandbox'])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker', timeout=15000)
        ext_id = sw.url.split('/')[2]
        print('Extension loaded in Chrome:', ext_id)

        def watch(page, who):
            page.on('console', lambda m: m.type in ('error', 'warning') and errors.append(f'{who}: {m.text}'))
            page.on('pageerror', lambda e: errors.append(f'{who}: {e}'))

        pop = ctx.new_page(); watch(pop, 'popup')
        pop.set_viewport_size({'width': 320, 'height': 700})
        pop.goto(f'chrome-extension://{ext_id}/popup.html')
        time.sleep(1.5)
        pop.screenshot(path=os.path.join(OUT, 'popup.png'), full_page=True)
        popup_text = pop.inner_text('body')

        page = ctx.new_page(); watch(page, 'audio')
        page.goto(f'chrome-extension://{ext_id}/test-harness.html')
        print('Playing the 65 s test soundtrack in real time…')
        for _ in range(240):
            res = page.evaluate('() => window.__done || null')
            if res: break
            time.sleep(0.5)
        stored = sw.evaluate('() => chrome.storage.local.get("prefs")')
        ctx.close()
finally:
    for name in temp:
        if os.path.exists(os.path.join(EXT, name)): os.remove(os.path.join(EXT, name))
    shutil.rmtree(profile, ignore_errors=True)

if not res or 'error' in res:
    sys.exit(f'Harness failed: {res and res.get("error")}  errors: {errors}')
json.dump(res, open(os.path.join(OUT, 'chrome_result.json'), 'w'))

log = res['log']
def avg_gain(a, b): return statistics.mean(e['gainDb'] for e in log if a <= e['t'] < b)
def main_scene(a, b):
    sc = [e['scene'] for e in log if a <= e['t'] < b]
    top = max(set(sc), key=sc.count); return top, round(100 * sc.count(top) / len(sc))
ready_at = next((e['t'] for e in log if e['aiState'] == 'ready'), None)
prefs = (stored or {}).get('prefs') or {}
s = res['stats']
segments = {'dialogue': (28, 32), 'fight 1': (15, 22), 'whisper': (33, 39), 'music': (41, 47), 'fight 2': (57, 65)}
for k, (a, b) in segments.items():
    sc, pct = main_scene(a, b)
    print(f'  {k:9s} scene {sc:9s} {pct:3d}%   avg gain {avg_gain(a, b):6.1f} dB')

checks = [
    ('No errors in popup or audio page' + (f': {errors[:3]}' if errors else ''), not errors),
    ('Popup renders', 'Turn on for this tab' in popup_text),
    (f'AI models loaded and running (ready at {ready_at} s, audio at {res["sampleRate"]} Hz)', ready_at is not None and ready_at <= 3),
    (f'Speech model {s["vadMs"] / s["vadRuns"]:.2f} ms/frame, YAMNet {s["yamMs"] / s["yamRuns"]:.1f} ms/window', s['vadMs'] / s['vadRuns'] < 5 and s['yamMs'] / s['yamRuns'] < 100),
    ('Fights recognised as action', main_scene(15, 22)[0] == 'action' and main_scene(57, 65)[0] == 'action'),
    ('Music recognised as music', main_scene(41, 47)[0] == 'music'),
    (f'Fight 1 turned down ({avg_gain(15, 22):.1f} dB, below -8)', avg_gain(15, 22) < -8),
    (f'Dialogue left alone ({avg_gain(28, 32):.1f} dB)', abs(avg_gain(28, 32)) < 2),
    (f'Whisper lifted ({avg_gain(33, 39):.1f} dB)', avg_gain(33, 39) > 0.5),
    (f'Learned from the player volume change and saved it: {prefs}', prefs.get('action', 0) < 0),
    ('Turning volume back up after the fight was NOT learned as a preference', prefs.get('quiet', 0) == 0 and prefs.get('adjustments') == 1),
    (f'Fight 2 turned down more after learning ({avg_gain(15, 22):.1f} -> {avg_gain(57, 65):.1f} dB)', avg_gain(57, 65) < avg_gain(15, 22) - 0.5),
]
print('\nChecks:')
failed = 0
for label, ok in checks:
    print(f'  {"PASS" if ok else "FAIL"}  {label}')
    failed += not ok
print(f'\n{failed} check(s) FAILED' if failed else f'\nAll {len(checks)} checks passed')
sys.exit(1 if failed else 0)
