"""Firefox test: installs the built add-on (dist/firefox) into Firefox as a temporary add-on and
checks it with test/firefox-harness.js.

Needs: pip install selenium, a Firefox-engine browser and geckodriver.
  FIREFOX=/path/to/firefox   (default: firefox on PATH)
  GECKODRIVER=/path/to/geckodriver   (default: geckodriver on PATH)
Run `node tools/build-firefox.js` and `npm run test:audio` first. Exits 1 if a check fails.
"""
import functools, http.server, json, os, shutil, statistics, subprocess, sys, tempfile, threading, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
ADDON_ID = 'boomguard@khadgachy07.github.io'
UUID = '7e57a5d2-0000-4000-8000-000000000001'

subprocess.run(['node', os.path.join(ROOT, 'tools', 'build-firefox.js')], check=True)
if not os.path.exists(os.path.join(OUT, 'movie.wav')):
    sys.exit('Missing test/out/movie.wav — run: npm run test:audio')

# Test copy of the add-on with the harness page added
addon = tempfile.mkdtemp(prefix='avt-ff-addon-')
shutil.copytree(os.path.join(ROOT, 'dist', 'firefox'), addon, dirs_exist_ok=True)
shutil.copy(os.path.join(HERE, 'firefox-harness.js'), addon)
shutil.copy(os.path.join(OUT, 'movie.wav'), addon)
open(os.path.join(addon, 'firefox-harness.html'), 'w').write(
    '<!doctype html><meta charset="utf-8"><script src="brain.js"></script><script src="firefox-harness.js"></script>')
# WebDriver may not open add-on pages itself, so the test copy's background page opens them
open(os.path.join(addon, 'test-autostart.js'), 'w').write(
    "browser.tabs.create({ url: 'popup.html' });"
    "setTimeout(() => browser.tabs.create({ url: 'firefox-harness.html' }), 2500);")
bg = open(os.path.join(addon, 'background.html')).read()
open(os.path.join(addon, 'background.html'), 'w').write(bg.replace('</body>', '<script src="test-autostart.js"></script></body>'))
# WebDriver can't read add-on pages either, so they post their results to the test server
open(os.path.join(addon, 'test-report-popup.js'), 'w').write(
    "setTimeout(() => fetch('http://127.0.0.1:8765/report/popup', { method: 'POST', body: document.body.innerText }), 1500);")
pop = open(os.path.join(addon, 'popup.html')).read()
open(os.path.join(addon, 'popup.html'), 'w').write(pop.replace('</body>', '<script src="test-report-popup.js"></script></body>'))

# Web pages for the content-script checks
web = tempfile.mkdtemp(prefix='avt-ff-web-')
shutil.copy(os.path.join(OUT, 'movie.wav'), web)
open(os.path.join(web, 'media.html'), 'w').write('<!doctype html><title>video page</title><audio src="movie.wav" autoplay loop></audio>')
open(os.path.join(web, 'empty.html'), 'w').write('<!doctype html><title>no video</title><p>nothing to play</p>')
reports = {}
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=web, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode('utf-8', 'replace')
        reports[self.path.rsplit('/', 1)[-1]] = body
        self.send_response(204); self.send_header('Access-Control-Allow-Origin', '*'); self.end_headers()
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

o = Options()
o.binary_location = os.environ.get('FIREFOX') or shutil.which('firefox') or sys.exit('Firefox not found — set FIREFOX')
o.add_argument('-headless')
for k, v in {'extensions.webextensions.uuids': json.dumps({ADDON_ID: UUID}),
             'media.autoplay.default': 0, 'media.autoplay.block-webaudio': False,
             'devtools.console.stdout.content': True, 'devtools.console.stdout.chrome': True}.items():
    o.set_preference(k, v)
log_path = os.path.join(OUT, 'firefox.log')
d = webdriver.Firefox(options=o, service=Service(os.environ.get('GECKODRIVER') or shutil.which('geckodriver'), log_output=log_path))
R, popup_text, install_error = None, '', None
try:
    print('Browser:', d.capabilities.get('browserName'), d.capabilities.get('browserVersion'))
    try:
        d.install_addon(addon, temporary=True)
    except Exception as e:
        install_error = str(e).splitlines()[0]
    if not install_error:
        print('Streaming the 65 s soundtrack through the Firefox AI pipeline…')
        for _ in range(400):
            if 'harness' in reports: break
            time.sleep(0.5)
        popup_text = reports.get('popup', '')
        R = json.loads(reports['harness']) if 'harness' in reports else None
finally:
    d.quit(); srv.shutdown()
    shutil.rmtree(addon, ignore_errors=True); shutil.rmtree(web, ignore_errors=True)

if install_error:
    sys.exit(f'FAIL  Firefox refused to install the add-on: {install_error}')
if not R:
    sys.exit('FAIL  harness did not finish')
json.dump(R, open(os.path.join(OUT, 'firefox_result.json'), 'w'))
browser_log = open(log_path, errors='replace').read()
addon_errors = [l for l in browser_log.splitlines() if ('moz-extension://' in l or 'AVT' in l) and ('Error' in l or 'error' in l)]

log = R.get('log') or []
def seg(a, b): return [e for e in log if a <= e[0] < b]
def avg_gain(a, b): return statistics.mean(e[2] for e in seg(a, b)) if seg(a, b) else 0
def main_scene(a, b):
    sc = [e[1] for e in seg(a, b)] or ['-']
    top = max(set(sc), key=sc.count); return top, round(100 * sc.count(top) / len(sc))
for k, (a, b) in {'dialogue': (28, 32), 'fight 1': (15, 22), 'whisper': (33, 39), 'music': (41, 47), 'fight 2': (57, 65)}.items():
    sc, pct = main_scene(a, b)
    print(f'  {k:9s} scene {sc:9s} {pct:3d}%   avg gain {avg_gain(a, b):6.1f} dB')

en, st, playing = R.get('mediaEnable') or {}, R.get('mediaStatus') or {}, R.get('mediaStillPlaying') or {}
safe = (en.get('ok') and st.get('hooked', 0) >= 1) or (en.get('reason') == 'needs-click' and st.get('hooked') == 0 and playing.get('paused') is False)
checks = [
    ('Firefox installs the add-on (manifest accepted)', True),
    ('Popup renders', 'Turn on for this tab' in popup_text),
    (f'AI models load in the Firefox background page ({R.get("aiReadyMs")} ms)', R.get('aiReady') is True),
    ('No errors in the add-on' + (f': {(R["errors"] + addon_errors)[:3]}' if R['errors'] or addon_errors else ''), not R['errors'] and not addon_errors),
    ('Fights recognised as action', main_scene(15, 22)[0] == 'action' and main_scene(57, 65)[0] == 'action'),
    ('Music recognised as music', main_scene(41, 47)[0] == 'music'),
    (f'Fight 1 turned down ({avg_gain(15, 22):.1f} dB, below -8)', avg_gain(15, 22) < -8),
    (f'Dialogue left alone ({avg_gain(28, 32):.1f} dB)', abs(avg_gain(28, 32)) < 2),
    (f'Whisper lifted ({avg_gain(33, 39):.1f} dB)', avg_gain(33, 39) > 0.5),
    (f'Learned from a volume change: {R.get("learned")}', (R.get('learned') or {}).get('scene') == 'action'),
    (f'Turning back up after the fight not learned ({R.get("undo")})', R.get('undo') == 'ignored'),
    (f'Fight 2 turned down more after learning ({avg_gain(15, 22):.1f} -> {avg_gain(57, 65):.1f} dB)', avg_gain(57, 65) < avg_gain(15, 22) - 0.5),
    (f'Content script runs on web pages ({R.get("mediaPing")})', (R.get('mediaPing') or {}).get('hasMedia') is True),
    (f'Never attaches while audio is off, video keeps playing (enable={en}, hooked={st.get("hooked")}, paused={playing.get("paused")})', safe),
    # Frames without media stay silent (so an embedded player in another frame can answer); the popup shows "No video found"
    (f'Page without video: nothing attached, popup gets no answer -> "No video found" ({R.get("noMediaEnable")})',
     R.get('noMediaEnable') in (None, {}) or (R.get('noMediaEnable') or {}).get('reason') == 'no-media'),
]
print('\nChecks:')
failed = 0
for label, ok in checks:
    print(f'  {"PASS" if ok else "FAIL"}  {label}')
    failed += not ok
print(f'\n{failed} check(s) FAILED' if failed else f'\nAll {len(checks)} checks passed')
sys.exit(1 if failed else 0)
