# 🛡️ BoomGuard

**AI movie volume leveler for Firefox and Chrome.**

A **Firefox** and **Chrome / Edge / Brave** extension for the classic movie problem: **the dialogue is quiet, then the action scene blows your ears off.**

It listens to the movie's audio, works out what kind of scene is playing, and adjusts the volume smoothly in real time:

- **Action** (explosions, gunfire, crashes, engines) is turned down toward dialogue level.
- **Whispers** get a small lift. It only lifts real speech, never background hiss.
- **Shouted lines** in a fight are allowed to stay a bit louder, so you still catch them.
- **Loud music** is levelled separately from action.
- **It learns your taste.** Turn the volume down during a fight, and next time it turns action down more by itself.

All AI runs on your computer: no internet, no account, no API key.

## Install

Downloads are on the [latest release](https://github.com/khadgachy07/boomguard/releases/latest) page.

### Firefox (140 or newer)

- **Permanent:** if the release lists **`boomguard-firefox-<version>.xpi`**, open it in Firefox and click **Add**. It's signed by Mozilla.
- **Try it out:** download **`boomguard-firefox-<version>.zip`**, open `about:debugging` → **This Firefox** → **Load Temporary Add-on…**, and pick the zip. It stays until Firefox restarts.

### Chrome, Edge, Brave

1. Download **`boomguard-chrome-<version>.zip`** and unzip it.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. Pin the extension to your toolbar.

Working from the source code instead? For Chrome, load the **`extension`** folder. For Firefox, run `npm run build:firefox` and load **`dist/firefox`**.

## Use

1. Start your movie in a tab.
2. Click the extension icon → **Turn on for this tab**. About a second later the popup shows **AI on**.
   In Firefox, if it says *"click once anywhere on the video page"*, do that and it finishes turning on.
3. It learns the movie's normal dialogue level from the first few lines spoken, then takes over.
4. Switching movies? Settings → **Re-learn**.

### Teaching it

- **Change the player's own volume** (YouTube/Netflix slider or keys) during a scene you don't like.
- **Shortcuts:** `Alt+Shift+↓` too loud, `Alt+Shift+↑` too quiet. Change them at `chrome://extensions/shortcuts`, or in Firefox at `about:addons` → ⚙ → **Manage Extension Shortcuts**.
- **Too loud / Too quiet** buttons in the popup.

What it has learned shows in the popup, with a **Forget** button. Changing the volume during normal dialogue counts as setting your overall volume and isn't learned. So is turning the volume back up right after a fight ends.

## How it works

```
movie audio ─┬─> AI-controlled volume ─> compressor ─> limiter ─> speakers
             ├─> loudness + bass/voice balance (20× per second)
             └─> 16 kHz ─┬─> Silero VAD : is someone talking?        (every 32 ms)
                         └─> YAMNet     : 521 sound types, e.g.      (every 0.48 s)
                                          Explosion, Gunshot, Music
```

Where the audio comes from differs by browser:
- **Chrome:** the whole tab's audio, via Chrome's tab-capture feature.
- **Firefox:** Firefox has no tab capture, so the add-on attaches to the page's own video player with Web Audio. The AI runs in the add-on's background page.

| Model | Job | Size | Speed (measured) |
|---|---|---|---|
| **Silero VAD v5** | Detects speech, so it learns the dialogue level from real speech only | 2.3 MB | ~0.5 ms per check |
| **YAMNet** (Google, 8-bit) | Recognises explosions, gunfire, crashes, engines, music… | 4.9 MB | ~12 ms per second of audio |

Both models run with ONNX Runtime Web (WebAssembly) in a hidden background page. `extension/brain.js` combines them with loudness and bass measurements, so a loud boom counts as action even when YAMNet is unsure. It also holds the volume down between explosions, so there's no pumping. If the models can't load, the extension falls back to a loudness-only "Basic mode".

Why not a chatbot-style LLM? They work on text and take a second or more per answer, so an explosion would be over before one replied. These small audio models react in milliseconds.

### Files

| Path | What it is |
|---|---|
| `extension/` | The extension. This is the folder you load in Chrome. |
| `extension/brain.js` | Scene detection, volume decisions and learning (shared with the tests) |
| `extension/offscreen.js` | Audio capture, processing graph and model wiring |
| `extension/content.js` | Notices when you change a site's video volume |
| `extension/popup.*` | The popup UI |
| `firefox/` | The Firefox version's own files: attaching to the video, safety checks, background AI, popup logic |
| `tools/build-firefox.js` | Builds the Firefox add-on in `dist/firefox` (adds the shared brain, popup page, models and runtime) |
| `test/` | Automated tests (below) |
| `tools/rebuild_models.sh` | Re-downloads and re-converts the bundled models |

## Tests

The tests build a 65-second "movie" soundtrack: dialogue, a gunfight with a shouted line, a whisper, loud music, and a second fight. They play it through the extension and check the results.

```bash
npm install
pip install numpy playwright selenium
python -m playwright install chromium
npm test               # or the steps separately:
npm run test:audio     # make the test soundtrack (test/out/movie.wav)
npm run test:sim       # offline: real models + brain.js in Node, basic vs AI vs AI-after-learning
npm run test:chrome    # live: loads the Chrome version in Chromium and plays the soundtrack (~70 s)
npm run test:firefox   # installs the Firefox version in Firefox and runs its AI pipeline + safety checks
```

`test:firefox` needs Firefox and geckodriver (set `FIREFOX=` and `GECKODRIVER=` if they're not on your PATH).

`test:chrome` uses Playwright's Chromium. Regular Google Chrome no longer allows tests to load unpacked extensions; you can still use Chromium or Chrome for Testing via `CHROME=/path/to/browser`. The same tests run on GitHub Actions before every release.

Latest results:
- 40 of 40 checks pass: 13 offline, 12 for the Chrome version, 15 for the Firefox version.
- Mozilla's add-on checker (`web-ext lint`): 0 errors.
- Fights started about 16 dB louder than dialogue. They end up 3–4.5 dB above dialogue with the AI, and level with it after one "volume down" lesson.
- Dialogue is left untouched, whispers get lifted, and music is recognised as music.

## Permissions, and why

- **Chrome: tab capture**: to hear and adjust the tab's audio. Chrome shows a "sharing audio" indicator while it's on.
- **Read sites (all URLs)**: Chrome uses it only to notice when you change a video player's volume. Firefox also uses it to attach to the video player. Nothing is sent anywhere.

## Limits

- **Chrome:** one tab at a time. Doesn't work on `chrome://` pages or the Chrome Web Store.
- **Firefox:** sites that block audio processing (some copy-protected streams, or video served from another site without permission) go quiet when attached. The add-on notices within about 5 seconds, turns itself off for that site, and offers **Reload page** to bring the sound back. Firefox's own code allows add-ons to process copy-protected audio such as Netflix, but that hasn't been tested on Netflix itself yet.
- Once the Firefox version attaches to a video, turning it off sends the audio straight through untouched. It fully detaches on the next page reload.
- Not for Safari.
- Tested with synthetic sounds and a computer voice. Real-movie tuning feedback is welcome.

## Licence

MIT for the code in this repo. The bundled models and runtime keep their own licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
