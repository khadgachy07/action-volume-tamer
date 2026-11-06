// Watches the site's own video player volume. When you reach for the volume during a scene,
// the extension learns from it. (Only forwarded while the extension is on for this tab.)
(() => {
  if (window.__avtVolumeWatcher) return;
  window.__avtVolumeWatcher = true;

  const effective = (m) => (m.muted ? 0 : m.volume);

  const mainMedia = () => {
    const all = [...document.querySelectorAll('video, audio')];
    const playing = all.filter((m) => !m.paused);
    const pool = playing.length ? playing : all;
    return pool.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  };

  const report = (m) => {
    if (!m) return;
    chrome.runtime.sendMessage({ target: 'background', type: 'volume', volume: effective(m) }).catch(() => {});
  };

  // volumechange doesn't bubble, but a capture listener on the document still sees it
  document.addEventListener('volumechange', (e) => {
    if (e.target instanceof HTMLMediaElement && e.target === mainMedia()) report(e.target);
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'avt-report-volume') report(mainMedia());
  });

  report(mainMedia());
})();
