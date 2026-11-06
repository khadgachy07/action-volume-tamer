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
let tab, toastTimer;

const send = async (target, msg) => {
  try { return await chrome.runtime.sendMessage({ target, ...msg }); } catch { return null; }
};
const getActive = async () => (await chrome.storage.session.get('activeTabId')).activeTabId;
const fmtDb = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { settings = {} } = await chrome.storage.local.get('settings');
  for (const key of Object.keys(DEFAULTS)) {
    $(key).value = settings[key] ?? DEFAULTS[key];
    $(key + 'Val').textContent = $(key).value;
    $(key).addEventListener('input', onSlider);
  }
  $('toggle').addEventListener('click', toggle);
  $('reset').addEventListener('click', () => send('offscreen', { type: 'reset' }));
  $('tooLoud').addEventListener('click', () => teach(-3));
  $('tooQuiet').addEventListener('click', () => teach(3));
  $('forget').addEventListener('click', forget);
  refresh();
  setInterval(refresh, 250);
}

async function onSlider(e) {
  $(e.target.id + 'Val').textContent = e.target.value;
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) settings[key] = Number($(key).value);
  await chrome.storage.local.set({ settings });
  send('offscreen', { type: 'settings', settings });
}

async function toggle() {
  $('error').textContent = '';
  try {
    if ((await getActive()) === tab.id) {
      await send('background', { type: 'stop' });
    } else {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const res = await send('background', { type: 'start', tabId: tab.id, streamId });
      if (!res?.ok) throw new Error(res?.error || 'Could not start');
    }
  } catch (e) {
    $('error').textContent = "Couldn't capture this tab's audio. " + (e?.message || '');
  }
  refresh();
}

async function teach(delta) {
  const res = await send('offscreen', { type: 'feedback', delta });
  if (!res?.ok) return toast('Turn it on for this tab first.');
  if (!res.learned) return toast("That's dialogue – it's the reference level. Use your normal volume for that.");
  toast(`Got it: ${PREF_LABELS[res.learned.scene].toLowerCase()} now ${fmtDb(res.learned.value)}`);
}

async function forget() {
  await chrome.storage.local.remove('prefs');
  await send('offscreen', { type: 'forget' });
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
    $('learned').appendChild(li);
    return;
  }
  for (const k of items) {
    const li = document.createElement('li');
    const a = document.createElement('span'); a.textContent = PREF_LABELS[k];
    const b = document.createElement('b'); b.textContent = fmtDb(prefs[k]);
    li.append(a, b);
    $('learned').appendChild(li);
  }
}

async function refresh() {
  const activeTabId = await getActive();
  const on = activeTabId === tab.id;
  $('toggle').textContent = on ? 'Turn off for this tab' : 'Turn on for this tab';
  $('toggle').classList.toggle('on', on);
  $('tooLoud').disabled = $('tooQuiet').disabled = !on;

  const st = on ? await send('offscreen', { type: 'status' }) : null;
  const aiState = st?.running ? st.aiState : 'off';
  $('ai').textContent = AI_LABELS[aiState] || aiState;
  $('ai').className = aiState === 'ready' ? 'ready' : '';

  if (!st?.running) {
    setScene(on ? 'Starting…' : activeTabId ? 'Active on another tab' : 'Off', 'var(--muted)', 0, '');
    const { prefs } = await chrome.storage.local.get('prefs');
    showLearned(prefs);
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
