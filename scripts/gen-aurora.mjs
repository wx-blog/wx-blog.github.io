// 首屏夜空纹理生成器：sky.webp + aurora-a/b/c.webp。
// 极光是同一片帘幕的三个噪声相位；T 只改相位、褶皱和亮度，不改构图。
// 从仓库根目录运行（sharp 已是依赖）：
//   AURORA_FRAME=a AURORA_T=0 node scripts/gen-aurora.mjs
//   AURORA_FRAME=b AURORA_T=0.3333333 node scripts/gen-aurora.mjs
//   AURORA_FRAME=c AURORA_T=0.6666667 node scripts/gen-aurora.mjs
// 三帧必须用同一份参数生成，只改 T，否则交叉淡化时构图会对不上。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');

const W = 2800;
const H = 1200;
// 同一个生成器跑三遍，T=0 / 1/3 / 2/3 各出一帧。
// T 只改噪声相位、褶皱高度和亮度，不改构图；网页端靠交叉淡化让帘幕“变形”。
const T = Number(process.env.AURORA_T || 0);
const FRAME = process.env.AURORA_FRAME || 'a';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.AURORA_OUT || path.join(ROOT, 'public/textures');
fs.mkdirSync(OUT, { recursive: true });

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const fract = (x) => x - Math.floor(x);
const hash2 = (x, y, seed = 0) => fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123);

function vnoise(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return mix(mix(a, b, u), mix(c, d, u), v);
}
function fbm(x, y, oct = 4, seed = 0) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * freq, y * freq, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
const fbm1 = (x, seed = 0, oct = 4) => fbm(x, 0.37, oct, seed);

// ---------- sky ----------
const sky = new Float32Array(W * H * 3);
const sr = new Float32Array(W * H);
const sg = new Float32Array(W * H);
const sb = new Float32Array(W * H);

function addLight(buf, cx, cy, rx, ry, r, g, b, power) {
  const x0 = Math.max(0, Math.floor(cx - rx * 3));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx * 3));
  const y0 = Math.max(0, Math.floor(cy - ry * 3));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry * 3));
  for (let y = y0; y <= y1; y++) {
    const dy = (y - cy) / ry;
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const d2 = dx * dx + dy * dy;
      if (d2 > 9) continue;
      const f = Math.exp(-d2 * 1.4) * power;
      const i = y * W + x;
      buf[i * 3] += r * f;
      buf[i * 3 + 1] += g * f;
      buf[i * 3 + 2] += b * f;
    }
  }
}

// base vertical gradient + broad sky glows
for (let y = 0; y < H; y++) {
  const t = y / H;
  // deep blue-black top, slightly warmer near the horizon
  let r = mix(0.006, 0.020, Math.pow(t, 1.7));
  let g = mix(0.012, 0.030, Math.pow(t, 1.6));
  let b = mix(0.028, 0.052, Math.pow(t, 1.4));
  // subtle top-right violet
  const xw = t < 0.55 ? 1 - t / 0.55 : 0;
  r += xw * 0.012;
  g += xw * 0.004;
  b += xw * 0.026;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    sky[i] = r;
    sky[i + 1] = g;
    sky[i + 2] = b;
  }
}

// broad aurora atmosphere (static)
addLight(sky, W * 0.18, H * 0.24, W * 0.46, H * 0.26, 0.06, 0.34, 0.26, 0.5);
addLight(sky, W * 0.44, H * 0.18, W * 0.36, H * 0.2, 0.04, 0.2, 0.3, 0.38);
addLight(sky, W * 0.82, H * 0.2, W * 0.32, H * 0.25, 0.12, 0.06, 0.3, 0.4);
addLight(sky, W * 0.9, H * 0.55, W * 0.3, H * 0.34, 0.1, 0.04, 0.22, 0.22);

// ----- stars -----
let rs = 90210;
const rnd = () => {
  rs = (rs * 1664525 + 1013904223) >>> 0;
  return rs / 4294967296;
};
function drawStar(cx, cy, radius, power, warm = 0) {
  const x0 = Math.max(0, Math.floor(cx - 4));
  const x1 = Math.min(W - 1, Math.ceil(cx + 4));
  const y0 = Math.max(0, Math.floor(cy - 4));
  const y1 = Math.min(H - 1, Math.ceil(cy + 4));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const f = Math.exp(-d2 / (2 * radius * radius)) * power;
      const i = (y * W + x) * 3;
      sky[i] += f * (1 + warm * 0.25);
      sky[i + 1] += f * (1 - warm * 0.05);
      sky[i + 2] += f * (1 - warm * 0.2);
    }
  }
}
for (let n = 0; n < 980; n++) {
  const x = rnd() * W;
  const y = rnd() * 0.8 * H;
  const mag = Math.pow(rnd(), 3.1);
  const radius = 0.45 + mag * 1.15;
  const power = 0.18 + mag * 1.5;
  drawStar(x, y, radius, power, rnd() < 0.18 ? rnd() : 0);
}
// a few bright stars with a faint cross
for (const [sx, sy, p] of [
  [0.13, 0.1, 1.9],
  [0.52, 0.055, 1.5],
  [0.88, 0.12, 1.7],
  [0.72, 0.31, 1.2],
]) {
  drawStar(sx * W, sy * H, 1.9, p, 0.2);
}

// ----- horizon light pollution -----
{
  const ridgeY = 0.972 * H;
  const reach = 0.34 * H;
  for (let y = Math.floor(ridgeY - reach); y < H; y++) {
    const u = clamp(1 - (ridgeY - y) / reach); // 0 far up, 1 at the horizon
    const up = Math.pow(u, 1.9);
    for (let x = 0; x < W; x++) {
      const xn = x / W;
      const poolA = Math.exp(-(((xn - 0.27) / 0.17) ** 2));
      const poolB = Math.exp(-(((xn - 0.55) / 0.13) ** 2));
      const poolC = Math.exp(-(((xn - 0.75) / 0.18) ** 2));
      const grain = 0.55 + 0.45 * fbm(x * 0.004, y * 0.006, 3, 15);
      const warm = (poolA * 0.72 + poolB * 0.24 + poolC * 0.46) * grain;
      const rose = (poolC * 0.3 + poolB * 0.1) * grain;
      const blue = (0.045 + poolA * 0.02) * grain;
      const haze = up * 0.92;
      const i = (y * W + x) * 3;
      sky[i] += (warm * 1.0 + rose * 0.92) * haze * 0.5;
      sky[i + 1] += (warm * 0.5 + rose * 0.36 + blue * 0.4) * haze * 0.5;
      sky[i + 2] += (warm * 0.22 + rose * 0.7 + blue * 1.0) * haze * 0.5;
    }
  }
  // a thin, bright horizon line just above the rooftops
  for (let x = 0; x < W; x++) {
    const xn = x / W;
    const p =
      Math.exp(-(((xn - 0.29) / 0.2) ** 2)) * 0.22 +
      Math.exp(-(((xn - 0.72) / 0.22) ** 2)) * 0.14 +
      Math.exp(-(((xn - 0.52) / 0.3) ** 2)) * 0.05;
    const y = Math.floor(H * 0.925);
    for (let yy = y - 5; yy <= y + 5; yy++) {
      const f = p * Math.exp(-((yy - y) ** 2) / 9);
      const i = (yy * W + x) * 3;
      sky[i] += f * 1.0;
      sky[i + 1] += f * 0.58;
      sky[i + 2] += f * 0.34;
    }
  }
  // a lit haze band sitting just above the city
  for (let y = Math.floor(H * 0.78); y < Math.floor(H * 0.96); y++) {
    const hN = y / H;
    const band = Math.exp(-(((hN - 0.884) / 0.055) ** 2));
    for (let x = 0; x < W; x++) {
      const xn = x / W;
      const n = fbm(x * 0.005, y * 0.014, 4, 77);
      const dust = smooth(0.42, 0.72, n) * band * 0.05;
      const pool = Math.exp(-(((xn - 0.33) / 0.3) ** 2)) * 0.7 + Math.exp(-(((xn - 0.72) / 0.28) ** 2)) * 0.5;
      const i = (y * W + x) * 3;
      sky[i] += dust * pool * 1.0;
      sky[i + 1] += dust * pool * 0.6;
      sky[i + 2] += dust * pool * 0.45;
    }
  }
}

// ----- distant city silhouette + lights at the very bottom -----
{
  const ridge = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const xn = x / W;
    const n = fbm1(xn * 7.2, 71, 4);
    const base = 0.972 + (n - 0.5) * 0.026;
    // a couple of low clusters / buildings
    const b1 = Math.exp(-(((xn - 0.3) / 0.05) ** 2)) * 0.006;
    const b2 = Math.exp(-(((xn - 0.72) / 0.06) ** 2)) * 0.004;
    ridge[x] = (base - b1 - b2) * H;
  }
  for (let x = 0; x < W; x++) {
    const top = ridge[x];
    for (let y = Math.floor(top); y < H; y++) {
      const depth = (y - top) / H;
      const f = clamp(0.5 + depth * 3);
      const i = (y * W + x) * 3;
      sky[i] = mix(sky[i], 0.004, f);
      sky[i + 1] = mix(sky[i + 1], 0.006, f);
      sky[i + 2] = mix(sky[i + 2], 0.011, f);
    }
  }
  // city lights along the ridge: two loose clusters, not an even runway
  for (let n = 0; n < 180; n++) {
    let xn;
    const pick = rnd();
    if (pick < 0.5) xn = 0.3 + (rnd() + rnd() - 1) * 0.09;
    else if (pick < 0.82) xn = 0.72 + (rnd() + rnd() - 1) * 0.1;
    else xn = rnd();
    if (xn < 0.03 || xn > 0.97) continue;
    const x = xn * W;
    const y = ridge[Math.floor(x)] - 2 + rnd() * 5;
    const mag = Math.pow(rnd(), 2.4);
    drawStar(x, y, 0.5 + mag * 1.3, 0.2 + mag * 2.1, 1);
  }
}

// subtle left-side darkening for the copy column
for (let y = 0; y < H; y++) {
  const t = y / H;
  for (let x = 0; x < W; x++) {
    const xn = x / W;
    const f = Math.exp(-(((xn - 0.12) / 0.34) ** 2)) * (0.18 + 0.2 * Math.exp(-(((t - 0.45) / 0.35) ** 2)));
    const i = (y * W + x) * 3;
    sky[i] *= 1 - f;
    sky[i + 1] *= 1 - f;
    sky[i + 2] *= 1 - f;
  }
}

// ---------- aurora (transparent) ----------
const aw = W;
const ah = H;
const accR = new Float32Array(aw * ah);
const accG = new Float32Array(aw * ah);
const accB = new Float32Array(aw * ah);
const accA = new Float32Array(aw * ah);

const sampleArr = (arr, x) => {
  const x0 = Math.floor(x);
  const f = x - x0;
  const a = arr[x0] || 0;
  const b = arr[Math.min(aw - 1, x0 + 1)] || 0;
  return a * (1 - f) + b * f;
};

function makeCurtain(cfg) {
  const hem = new Float32Array(aw);
  const env = new Float32Array(aw);
  const ray = new Float32Array(aw);
  const falloff = new Float32Array(aw);
  const edgeMod = new Float32Array(aw);
  const edgeW = new Float32Array(aw);
  const sheet = new Float32Array(aw);
  const peaks = [];
  let rr = 7717 + cfg.seed * 101;
  const prand = () => {
    rr = (rr * 1664525 + 1013904223) >>> 0;
    return rr / 4294967296;
  };
  for (let k = 0; k < cfg.peaks; k++) {
    peaks.push({
      x: cfg.center + (prand() - 0.5) * cfg.width * 0.8,
      w: 0.0012 + prand() * 0.0055,
      p: 0.2 + prand() * 0.6,
    });
  }
  // 两个尺度分开：褶皱只轻轻挪，竖纹挪得多一点，才像光在动而不是整图平移。
  const foldPhase = cfg.phase + T * 0.04;
  const rayPhase = cfg.phase + T * 0.18;
  for (let x = 0; x < aw; x++) {
    const xn = x / aw;
    // long folds in the lower edge: several incommensurate waves
    const w1 = fbm1(xn * cfg.curveFreq + foldPhase, cfg.seed, 4) - 0.5;
    const w2 = fbm1(xn * cfg.curveFreq * 2.7 + foldPhase * 2, cfg.seed + 7, 3) - 0.5;
    const w3 = Math.sin((xn * cfg.curveFreq * 0.82 + foldPhase) * Math.PI * 2);
    const w4 = Math.sin((xn * cfg.curveFreq * 2.25 + foldPhase * 1.7) * Math.PI * 2);
    // 整条帘幕上下呼吸；T=0 时为 0，首帧与上一版一致。
    const breathe = Math.sin(T * Math.PI * 2) * Math.sin(xn * 5.2 + cfg.seed * 0.7) * cfg.amp * 0.7;
    hem[x] =
      (cfg.base + cfg.trend * (xn - 0.5) + w1 * cfg.amp * 2.4 + w2 * cfg.amp * 1.05 + w3 * cfg.amp * 0.7 + w4 * cfg.amp * 0.38 + breathe) *
      ah;
    // soft horizontal envelope, asymmetric
    const c = cfg.center;
    const leftW = cfg.width * 0.55;
    const rightW = cfg.width * 0.65;
    const s = xn < c ? (xn - c) / leftW : (xn - c) / rightW;
    env[x] = Math.exp(-s * s * 2.1);
    // vertical ray structure
    const r1 = fbm1(xn * cfg.rayFreq + rayPhase * 5, cfg.seed + 3, 4);
    const r2 = fbm1(xn * cfg.rayFreq * 2.7 + rayPhase, cfg.seed + 11, 3);
    let r = clamp((r1 * 0.68 + r2 * 0.32 - 0.36) * 2.35, 0, 1);
    r = 0.05 + 0.95 * Math.pow(r, 1.25);
    for (const pk of peaks) {
      const dd = (xn - pk.x) / pk.w;
      r += pk.p * Math.exp(-dd * dd) * 0.85;
    }
    ray[x] = r;
    falloff[x] = 0.055 + 0.17 * Math.pow(fbm1(xn * 4.8 + cfg.phase + T * 0.06, cfg.seed + 15, 3), 1.15);
    edgeMod[x] = 0.22 + 1.15 * fbm1(xn * 3.3 + cfg.phase + T * 0.06, cfg.seed + 5, 3);
    edgeW[x] = 0.0025 + 0.0032 * fbm1(xn * 6.1 + cfg.phase + T * 0.06, cfg.seed + 9, 2);
    sheet[x] = 0.5 + 0.5 * smooth(0.22, 0.62, fbm1(xn * 3.2 + cfg.phase + T * 0.06, cfg.seed + 61, 3));
  }
  return { hem, env, ray, falloff, edgeMod, edgeW, sheet, cfg };
}

const curtains = [
  makeCurtain({
    center: 0.28,
    width: 0.66,
    base: 0.178,
    trend: 0.012,
    amp: 0.042,
    curveFreq: 1.15,
    phase: 1.9,
    rayFreq: 27,
    seed: 5,
    peaks: 7,
    strength: 1,
    palette: 'green',
  }),
  makeCurtain({
    center: 0.8,
    width: 0.44,
    base: 0.30,
    trend: 0.03,
    amp: 0.052,
    curveFreq: 1.0,
    phase: 4.4,
    rayFreq: 35,
    seed: 13,
    peaks: 5,
    strength: 0.68,
    palette: 'violet',
  }),
  makeCurtain({
    center: 0.52,
    width: 0.58,
    base: 0.40,
    trend: 0.01,
    amp: 0.035,
    curveFreq: 1.7,
    phase: 0.6,
    rayFreq: 20,
    seed: 29,
    peaks: 4,
    strength: 0.24,
    palette: 'cyan',
  }),
];

const palettes = {
  green: {
    low: [0.18, 1.0, 0.62],
    mid: [0.3, 0.95, 0.84],
    high: [0.55, 0.44, 1.0],
    fringe: [1.0, 0.5, 0.8],
  },
  violet: {
    low: [0.5, 1.0, 0.82],
    mid: [0.52, 0.55, 1.0],
    high: [0.8, 0.35, 1.0],
    fringe: [1.0, 0.46, 0.78],
  },
  cyan: {
    low: [0.5, 1.0, 0.78],
    mid: [0.4, 0.82, 1.0],
    high: [0.52, 0.46, 1.0],
    fringe: [0.9, 0.46, 0.72],
  },
};

for (const cur of curtains) {
  const { hem, env, ray, cfg, falloff, edgeMod, edgeW, sheet } = cur;
  const pal = palettes[cfg.palette];
  // 三条帘幕各按自己的 seed 呼吸，避免整片天光一起亮暗。
  const pulse = 1 + 0.18 * Math.sin(T * Math.PI * 2) * Math.sin(cfg.seed * 1.3);
  for (let x = 0; x < aw; x++) {
    if (env[x] < 0.008) continue;
    const yStart = Math.max(0, Math.floor(hem[x] - ah * 0.6));
    const yEnd = Math.min(ah - 1, Math.ceil(hem[x] + ah * 0.1));
    for (let y = yStart; y <= yEnd; y++) {
      // bend the rays gently as they rise, so the curtain reads as fabric
      const warp =
        (fbm(x * 0.0012, y * 0.0019, 3, cfg.seed + 99) - 0.5) * 130 +
        Math.sin(y * 0.0022 + x * 0.0013 + cfg.phase + T * 1.2) * 20;
      const xw = clamp(x + warp, 0, aw - 1);
      const e = sampleArr(env, xw);
      if (e < 0.006) continue;
      const hx = sampleArr(hem, xw);
      const xr = sampleArr(ray, xw);
      const f = sampleArr(falloff, xw);
      const em = sampleArr(edgeMod, xw);
      const ew = sampleArr(edgeW, xw);
      const sh = sampleArr(sheet, xw);
      const d = (hx - y) / ah; // >0 above the hem
      let body;
      if (d >= 0) {
        body = 0.75 * Math.exp(-d / f) + 0.3 * Math.exp(-d / (f * 2.8)) + 0.1 * Math.exp(-d / 0.5);
      } else {
        body = 0.55 * Math.exp(d / 0.032);
      }
      const edge = Math.exp(-((d * d) / (2 * ew * ew))) * em;
      const fr = Math.exp(-(((d + 0.0055) ** 2) / (2 * 0.0042 * 0.0042))) * (0.3 + 0.7 * em);
      const shimmer = 0.8 + 0.2 * fbm(x * 0.02, y * 0.012, 3, cfg.seed + 41);
      const patch = 0.65 + 0.7 * fbm(x * 0.0016, y * 0.0026, 4, cfg.seed + 57);
      const intensity = e * xr * cfg.strength * shimmer * patch * sh * (body * 0.62 + edge * 1.75) * pulse;
      if (intensity < 0.002) continue;
      const t = clamp(d / 0.32);
      let r;
      let g;
      let b;
      if (t < 0.4) {
        const k = t / 0.4;
        r = mix(pal.low[0], pal.mid[0], k);
        g = mix(pal.low[1], pal.mid[1], k);
        b = mix(pal.low[2], pal.mid[2], k);
      } else {
        const k = (t - 0.4) / 0.6;
        r = mix(pal.mid[0], pal.high[0], k);
        g = mix(pal.mid[1], pal.high[1], k);
        b = mix(pal.mid[2], pal.high[2], k);
      }
      const whiten = clamp(edge * 0.5 + (1 - t) * 0.1, 0, 0.6);
      r = mix(r, 0.86, whiten);
      g = mix(g, 1.0, whiten);
      b = mix(b, 0.93, whiten);
      const i = y * aw + x;
      const a = clamp(intensity, 0, 0.94);
      accR[i] += r * a;
      accG[i] += g * a;
      accB[i] += b * a;
      accA[i] += a;
      if (fr > 0.01) {
        const fa = fr * e * xr * cfg.strength * 0.34;
        accR[i] += pal.fringe[0] * fa;
        accG[i] += pal.fringe[1] * fa;
        accB[i] += pal.fringe[2] * fa;
        accA[i] += fa;
      }
    }
  }
}

// assemble aurora RGBA
const aurora = Buffer.alloc(aw * ah * 4);
for (let i = 0; i < aw * ah; i++) {
  const a = clamp(accA[i], 0, 1);
  if (a < 0.001) continue;
  const r = clamp(accR[i] / accA[i]);
  const g = clamp(accG[i] / accA[i]);
  const b = clamp(accB[i] / accA[i]);
  // soft shoulder on alpha, keep the very faint veil
  const alpha = Math.pow(a, 0.92);
  aurora[i * 4] = Math.round(Math.pow(r, 0.92) * 255);
  aurora[i * 4 + 1] = Math.round(Math.pow(g, 0.92) * 255);
  aurora[i * 4 + 2] = Math.round(Math.pow(b, 0.92) * 255);
  aurora[i * 4 + 3] = Math.round(alpha * 255);
}

// sky buffer to RGBA
const skyBuf = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) {
  skyBuf[i * 4] = Math.round(clamp(sky[i * 3]) * 255);
  skyBuf[i * 4 + 1] = Math.round(clamp(sky[i * 3 + 1]) * 255);
  skyBuf[i * 4 + 2] = Math.round(clamp(sky[i * 3 + 2]) * 255);
  skyBuf[i * 4 + 3] = 255;
}

await sharp(skyBuf, { raw: { width: W, height: H, channels: 4 } })
  .webp({ quality: 82, effort: 5 })
  .toFile(path.join(OUT, 'sky.webp'));
await sharp(aurora, { raw: { width: aw, height: ah, channels: 4 } })
  .webp({ quality: 84, alphaQuality: 90, effort: 5 })
  .toFile(path.join(OUT, `aurora-${FRAME}.webp`));

console.log(
  'sizes',
  fs.statSync(path.join(OUT, 'sky.webp')).size,
  fs.statSync(path.join(OUT, `aurora-${FRAME}.webp`)).size,
  `frame=${FRAME} T=${T.toFixed(3)}`,
);

console.log('done');
