// Generates the spoken test lines with meSpeak (a JavaScript port of eSpeak).
const fs = require('fs');
const path = require('path');
const meSpeak = require('mespeak');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
meSpeak.loadConfig(require('mespeak/src/mespeak_config.json'));
meSpeak.loadVoice(require('mespeak/voices/en/en-us.json'));

const lines = [
  'I told you we should never have come back here.',
  'Get the car, we have to leave right now.',
  'Listen to me, everything is going to be fine.'
];
lines.forEach((text, i) => {
  const wav = Buffer.from(meSpeak.speak(text, { rawdata: 'buffer', speed: 150 }));
  fs.writeFileSync(path.join(OUT, `speech${i}.wav`), wav);
});
console.log(`wrote ${lines.length} speech clips to test/out/`);
