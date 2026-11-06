// Assembles the Firefox add-on in dist/firefox from firefox/ plus the files it shares with the
// Chrome version (brain.js, popup.html, models, runtime). Usage: node tools/build-firefox.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'firefox');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

fs.cpSync(path.join(root, 'firefox'), out, { recursive: true });
for (const shared of ['brain.js', 'popup.html', 'models', 'lib']) {
  fs.cpSync(path.join(root, 'extension', shared), path.join(out, shared), { recursive: true });
}
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, f), path.join(out, f));

// Keep the versions in step
const ff = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
const cr = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
if (ff.version !== cr.version) {
  console.error(`Version mismatch: firefox/manifest.json ${ff.version} vs extension/manifest.json ${cr.version}`);
  process.exit(1);
}
console.log(`Built Firefox add-on ${ff.version} in dist/firefox`);
