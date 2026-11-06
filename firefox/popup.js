// Firefox popup: same UI as the Chrome version, but it talks to the page's content script.
const DEFAULTS = { maxCut: 12, boost: 4, threshold: 6 };
const SCENES = {
  learning: ['Learning the dialogue level…', 'var(--muted)'],
  dialogue: ['Dialogue', 'var(--accent)'],
  action: ['Action – turning down', 'var(--warn)'],
  quiet: ['Whisper – lifting', 'var(--quiet)'],
  music: ['Music', 'var(--music)'],
  ambient: ['Effects / background', 'var(--muted)'],
  silence: ['Silence', 'var(--muted)']
};
const PREF_LABELS = { action: 'Action scenes', music: 'Music', ambient: 'Effects / background', quiet: 'Whispers' };
const AI_LABELS = { off: 'AI off', loading: 'AI loading…', ready: 'AI on', basic: 'Basic mode' };

const $ = (id) => document.getElementById(id);
let tab, host = '', toastTimer;

const send = (msg) => browser.tabs.sendMessage(tab.id, msg).catch(() => null);
const fmtDb = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';

async function init() {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try { host = new URL(tab.url).hostname; } catch { /* about: pages */ }
  const { settings = {} } = await browser.storage.local.get('settings');
  for (const key of Object.keys(DEFAULTS)) {
    $(key).value = settings[key] ?? DEFAULTS[key];
    $(key + 'Val').textContent = $(key).value;
    $(key).addEventListener('input', onSlider);
  }
  $('toggle').addEventListener('click', toggle);
  $('reset').addEventListener('click', () => send({ type: 'avt-reset' }));
  $('tooLoud').addEventListener('click', () => teach(-3));
  $('tooQuiet').addEventListener('click', () => teach(3));
  $('forget').addEventListener('click', forget);
  refresh();
  setInterval(refresh, 250);
}

async function ensureScript() {
  if (await send({ type: 'avt-ping' })) return true;
  try { // tab was open before the add-on was installed
    await browser.tabs.executeScript(tab.id, { file: 'brain.js', allFrames: true });
    await browser.tabs.executeScript(tab.id, { file: 'content.js', allFrames: true });
    return true;
  } catch { return false; }
}

async function onSlider(e) {
  $(e.target.id + 'Val').textContent = e.target.value;
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) settings[key] = Number($(key).value);
  await browser.storage.local.set({ settings });
  send({ type: 'avt-settings', settings });
}

function showProblem(text, button) {
  const el = $('error');
  el.textContent = text;
  if (button) {
    const b = document.createElement('button');
    b.className = 'small'; b.style.marginTop = '6px'; b.textContent = button.label;
    b.addEventListener('click', button.onClick);
    el.append(document.createElement('br'), b);
  }
}

async function toggle() {
  $('error').textContent = '';
  const st = await send({ type: 'avt-status' });
  if (st?.running) { await send({ type: 'avt-disable' }); return refresh(); }
  if (!(await ensureScript())) return showProblem("Firefox doesn't allow add-ons on this page.");
  const res = await send({ type: 'avt-enable' });
  if (res?.ok) return refresh();
  const reason = res?.reason || 'no-media';
  if (reason === 'no-media') showProblem('No video found on this page yet. Start the movie, then try again.');
  else if (reason === 'needs-click') showProblem('Almost there: click once anywhere on the video page and it turns on by itself.');
  else if (reason === 'blocked') blockedMessage(true);
  refresh();
}

function blockedMessage(fromToggle) {
  showProblem(
    `${host || 'This site'} doesn't allow add-ons to process its audio (copy protection). ` +
    (fromToggle ? 'It was turned off here earlier.' : 'Reload the page to get the sound back.'),
    fromToggle
      ? { label: 'Try again on this site', onClick: async () => {
          const { blockedSites = [] } = await browser.storage.local.get('blockedSites');
          await browser.storage.local.set({ blockedSites: blockedSites.filter((h) => h !== host) });
          browser.tabs.reload(tab.id); window.close();
        } }
      : { label: 'Reload page', onClick: () => { browser.tabs.reload(tab.id); window.close(); } }
  );
}

async function teach(delta) {
  const res = await send({ type: 'avt-feedback', delta });
  if (!res?.ok) return toast('Turn it on for this tab first.');
  if (!res.learned) return toast("That's dialogue – it's the reference level. Use your normal volume for that.");
  toast(`Got it: ${PREF_LABELS[res.learned.scene].toLowerCase()} now ${fmtDb(res.learned.value)}`);
}

async function forget() {
  await browser.storage.local.remove('prefs');
  await send({ type: 'avt-forget' });
  toast('Forgot everything it learned.');
  refresh();
}

function toast(text) {
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 4000);
}

function showLearned(prefs) {
  const items = Object.keys(PREF_LABELS).filter((k) => prefs && Math.abs(prefs[k] || 0) >= 0.1);
  $('learned').innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = "Nothing yet. Turn the volume down during a scene you don't like and it'll remember.";
    return $('learned').appendChild(li);
  }
  for (const k of items) {
    const li = document.createElement('li');
    const a = document.createElement('span'); a.textContent = PREF_LABELS[k];
    const b = document.createElement('b'); b.textContent = fmtDb(prefs[k]);
    li.append(a, b);
    $('learned').appendChild(li);
  }
}

let shownProblem = null;
async function refresh() {
  const st = await send({ type: 'avt-status' });
  const on = !!st?.running;
  $('toggle').textContent = on ? 'Turn off for this tab' : 'Turn on for this tab';
  $('toggle').classList.toggle('on', on);
  $('tooLoud').disabled = $('tooQuiet').disabled = !on;
  const aiState = on ? st.aiState : 'off';
  $('ai').textContent = AI_LABELS[aiState] || aiState;
  $('ai').className = aiState === 'ready' ? 'ready' : '';

  if (st?.problem === 'blocked' && shownProblem !== 'blocked') { shownProblem = 'blocked'; blockedMessage(false); }

  if (!on) {
    setScene(st?.waitingForClick ? 'Waiting for a click on the page…' : 'Off', 'var(--muted)', 0, '');
    showLearned(st?.prefs || (await browser.storage.local.get('prefs')).prefs);
    return;
  }
  const [label, color] = SCENES[st.scene] || [st.scene, 'var(--muted)'];
  const heard = [];
  if (st.topSound) heard.push(st.topSound);
  if (st.speech > 0.5) heard.push(`speech ${Math.round(st.speech * 100)}%`);
  if (st.music > 0.5) heard.push('music');
  setScene(label, color, st.gainDb, heard.length ? 'Hearing: ' + heard.join(' · ') : '');
  showLearned(st.prefs);
}

function setScene(label, color, gainDb, hearing) {
  $('scene').textContent = label;
  $('scene').style.color = color;
  $('hearing').textContent = hearing || ' ';
  $('gain').textContent = fmtDb(gainDb);
  const bar = $('bar'), zero = 66.6;
  if (gainDb < 0) {
    const w = Math.min(1, -gainDb / 24) * zero;
    bar.style.left = zero - w + '%'; bar.style.width = w + '%'; bar.style.background = 'var(--warn)';
  } else {
    const w = Math.min(1, gainDb / 12) * (100 - zero);
    bar.style.left = zero + '%'; bar.style.width = w + '%'; bar.style.background = 'var(--quiet)';
  }
}

init();
