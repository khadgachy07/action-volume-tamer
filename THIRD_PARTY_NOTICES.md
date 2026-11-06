# Third-party components

| File | Component | Licence | Source |
|---|---|---|---|
| `extension/models/yamnet.onnx` | YAMNet sound classifier (8-bit), converted from TFLite to ONNX | Apache 2.0 | Google / TensorFlow Models — https://github.com/tensorflow/models/tree/master/research/audioset/yamnet |
| `extension/models/silero_vad.onnx` | Silero VAD v5 | MIT | https://github.com/snakers4/silero-vad (via @ricky0123/vad-web) |
| `extension/lib/ort*.{js,mjs,wasm}` | ONNX Runtime Web 1.22.0 | MIT | Microsoft — https://github.com/microsoft/onnxruntime |

Test-only (not shipped in the extension): meSpeak (GPL-3.0) generates the spoken test lines.
