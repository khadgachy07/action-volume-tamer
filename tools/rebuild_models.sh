#!/usr/bin/env bash
# Rebuilds the bundled AI models and runtime in extension/models and extension/lib.
# You don't need this to use the extension — the files are already committed.
#
#   YAMNet:     8-bit TFLite model (from the @apocaliss92/scrypted-yamnet npm package),
#               converted to ONNX with tf2onnx.
#   Silero VAD: v5 ONNX model from the @ricky0123/vad-web npm package.
#   Runtime:    ONNX Runtime Web (WebAssembly build).
#
# Needs: node/npm, python3, pip install tensorflow-cpu tf2onnx
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

npm pack @apocaliss92/scrypted-yamnet@0.0.3 @ricky0123/vad-web@0.0.31 onnxruntime-web@1.22.0 --silent >/dev/null
mkdir yam vad ort
tar xzf apocaliss92-scrypted-yamnet-0.0.3.tgz -C yam
tar xzf ricky0123-vad-web-0.0.31.tgz -C vad
tar xzf onnxruntime-web-1.22.0.tgz -C ort

python3 -m tf2onnx.convert --tflite yam/package/src/model/yamnet.tflite --output yamnet.onnx --opset 17
mkdir -p "$ROOT/extension/models" "$ROOT/extension/lib"
cp yamnet.onnx "$ROOT/extension/models/yamnet.onnx"
cp vad/package/dist/silero_vad_v5.onnx "$ROOT/extension/models/silero_vad.onnx"
cp ort/package/dist/ort.wasm.min.js ort/package/dist/ort-wasm-simd-threaded.mjs ort/package/dist/ort-wasm-simd-threaded.wasm "$ROOT/extension/lib/"
echo "Models and runtime rebuilt in extension/"
