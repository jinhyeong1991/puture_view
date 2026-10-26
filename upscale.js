/* 🔍 업스케일 워커: Lanczos3 리샘플링 (AI 아님 · 원본 픽셀만으로 확대해서 모양·글자·색을 바꾸지 않음) */
const TAPS = 6; // Lanczos3 확대 시 출력 1픽셀이 참고하는 원본 픽셀 수
const MAX_SIDE = 16384;
const MAX_PIXELS = 100e6;

function lanczos3(x) {
  if (x === 0) return 1;
  if (x <= -3 || x >= 3) return 0;
  const px = Math.PI * x;
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

// 출력 좌표마다 참고할 원본 인덱스와 가중치를 미리 계산 (가장자리는 끝 픽셀 반복, 합이 1이 되게 정규화)
function weights(inLen, outLen) {
  const scale = outLen / inLen;
  const idx = new Int32Array(outLen * TAPS), w = new Float32Array(outLen * TAPS);
  for (let o = 0; o < outLen; o++) {
    const center = (o + 0.5) / scale - 0.5;
    const base = Math.floor(center) - 2;
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const i = base + k, v = lanczos3(center - i);
      idx[o * TAPS + k] = Math.min(inLen - 1, Math.max(0, i)); w[o * TAPS + k] = v; sum += v;
    }
    for (let k = 0; k < TAPS; k++) w[o * TAPS + k] /= sum;
  }
  return { idx, w };
}

function checkSize(outW, outH) {
  if (outW > MAX_SIDE || outH > MAX_SIDE || outW * outH > MAX_PIXELS)
    throw new Error(`결과가 ${outW}×${outH}로 너무 큽니다 (브라우저 한계). 2배로 줄이거나 더 작은 이미지를 사용하세요.`);
}

// src: RGBA Uint8 (w×h) → RGBA Uint8ClampedArray (outW×outH). 알파는 곱한 상태로 섞어서 투명 가장자리 번짐을 막음
function upscaleRGBA(src, w, h, outW, outH, onProgress) {
  checkSize(outW, outH);
  const hx = weights(w, outW), vy = weights(h, outH);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const RING = 8; // 가로로 늘린 원본 행을 몇 줄만 들고 있어서 메모리를 아낌
  const ring = Array.from({ length: RING }, () => new Float32Array(outW * 4));
  const tag = new Int32Array(RING).fill(-1);
  const row = (y) => {
    const slot = y % RING, r = ring[slot];
    if (tag[slot] === y) return r;
    const off = y * w * 4;
    for (let x = 0; x < outW; x++) {
      let cr = 0, cg = 0, cb = 0, ca = 0;
      for (let k = 0; k < TAPS; k++) {
        const p = off + hx.idx[x * TAPS + k] * 4, wt = hx.w[x * TAPS + k], a = src[p + 3] * wt;
        cr += src[p] * a; cg += src[p + 1] * a; cb += src[p + 2] * a; ca += a;
      }
      const q = x * 4; r[q] = cr; r[q + 1] = cg; r[q + 2] = cb; r[q + 3] = ca;
    }
    tag[slot] = y; return r;
  };
  const rows = new Array(TAPS), wts = new Float32Array(TAPS);
  for (let y = 0; y < outH; y++) {
    for (let k = 0; k < TAPS; k++) { rows[k] = row(vy.idx[y * TAPS + k]); wts[k] = vy.w[y * TAPS + k]; }
    const o = y * outW * 4;
    for (let q = 0; q < outW * 4; q += 4) {
      let cr = 0, cg = 0, cb = 0, ca = 0;
      for (let k = 0; k < TAPS; k++) { const r = rows[k], wt = wts[k]; cr += r[q] * wt; cg += r[q + 1] * wt; cb += r[q + 2] * wt; ca += r[q + 3] * wt; }
      if (ca <= 0) { out[o + q + 3] = 0; continue; }
      out[o + q] = cr / ca; out[o + q + 1] = cg / ca; out[o + q + 2] = cb / ca; out[o + q + 3] = ca;
    }
    if (onProgress && (y & 63) === 0) onProgress(y / outH);
  }
  return out;
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = async ({ data }) => {
    try {
      const { bitmap, scale } = data;
      const w = bitmap.width, h = bitmap.height, outW = Math.round(w * scale), outH = Math.round(h * scale);
      checkSize(outW, outH);
      const c = new OffscreenCanvas(w, h), cx = c.getContext("2d", { willReadFrequently: true });
      cx.drawImage(bitmap, 0, 0); bitmap.close();
      const src = cx.getImageData(0, 0, w, h).data;
      let last = 0;
      const px = upscaleRGBA(src, w, h, outW, outH, (p) => { const n = Math.floor(p * 100); if (n >= last + 5) { last = n; self.postMessage({ progress: p }); } });
      const oc = new OffscreenCanvas(outW, outH);
      oc.getContext("2d").putImageData(new ImageData(px, outW, outH), 0, 0);
      self.postMessage({ progress: 1, encoding: true });
      const blob = await oc.convertToBlob({ type: "image/png" });
      self.postMessage({ done: true, blob, w, h, outW, outH });
    } catch (e) { self.postMessage({ error: e.message || String(e) }); }
  };
}

if (typeof module !== "undefined") module.exports = { upscaleRGBA, weights, lanczos3 };
