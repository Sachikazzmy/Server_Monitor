/*
 * engine.js — Canvas 图表底层工具：刻度、平滑曲线路径、发光粒子贴图。
 *
 * 全部是纯函数 / 缓存，不持有图表状态；状态归 MetricChart 管。
 */

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** "#rrggbb" → "rgba(r,g,b,a)" */
export function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 把轴最大值向上取到"好看"的整数（1/2/2.5/5 ×10^n） */
export function niceCeil(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * base;
}

/** 从 0 到 max 的纵轴刻度（4~5 根） */
export function yTicks(max, count = 4) {
  const step = niceCeil(max / count);
  const out = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) out.push(v);
  return out;
}

/* ---- 时间轴刻度 ---- */

const TIME_STEPS_S = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 5400, 10800, 21600];

/**
 * 在 [from, to) 索引范围内取时间刻度。
 * 返回 [{idx, label}]，label 为本地 HH:MM。
 */
export function timeTicks(times, from, to, target = 5) {
  const n = to - from;
  if (n < 3) return [];
  const spanS = (times[to - 1] - times[from]) / 1000;
  const raw = spanS / target;
  let stepS = TIME_STEPS_S[TIME_STEPS_S.length - 1];
  for (const s of TIME_STEPS_S) {
    if (s >= raw) { stepS = s; break; }
  }
  const stepMs = stepS * 1000;

  const out = [];
  const t0 = times[from];
  const t1 = times[to - 1];
  for (let b = Math.ceil(t0 / stepMs) * stepMs; b <= t1; b += stepMs) {
    // 二分找第一个 >= b 的采样点
    let lo = from, hi = to - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < b) lo = mid + 1; else hi = mid;
    }
    const d = new Date(b);
    const label = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (!out.length || out[out.length - 1].idx !== lo) out.push({ idx: lo, label });
  }
  return out;
}

/* ---- 平滑曲线路径（Catmull-Rom → 三次贝塞尔） ---- */

function addRun(path, pts, a, b) {
  path.moveTo(pts[a].x, pts[a].y);
  for (let k = a; k < b; k++) {
    const p0 = pts[Math.max(a, k - 1)];
    const p1 = pts[k];
    const p2 = pts[k + 1];
    const p3 = pts[Math.min(b, k + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
}

/** pts: [{x,y}|null]（null 表示断点）。返回 Path2D。 */
export function buildLinePath(pts) {
  const path = new Path2D();
  let i = 0;
  while (i < pts.length) {
    if (!pts[i]) { i++; continue; }
    let j = i;
    while (j < pts.length && pts[j]) j++;
    addRun(path, pts, i, j - 1);
    i = j;
  }
  return path;
}

/** 线下方面积路径（闭合到 baseY）。null 段会被拆开。 */
export function buildAreaPath(pts, baseY) {
  const path = new Path2D();
  let i = 0;
  while (i < pts.length) {
    if (!pts[i]) { i++; continue; }
    let j = i;
    while (j < pts.length && pts[j]) j++;
    addRun(path, pts, i, j - 1);
    path.lineTo(pts[j - 1].x, baseY);
    path.lineTo(pts[i].x, baseY);
    path.closePath();
    i = j;
  }
  return path;
}

/* ---- 发光粒子贴图：预渲染径向光斑，drawImage 比 shadowBlur 快一个量级 ---- */

const spriteCache = new Map();

/** 返回 {img, size}：size 为 CSS 像素边长（贴图本身 2x 分辨率） */
export function dotSprite(color) {
  let sp = spriteCache.get(color);
  if (sp) return sp;
  const size = 18; // CSS px（含光晕）
  const c = document.createElement("canvas");
  c.width = c.height = size * 2;
  const g = c.getContext("2d");
  const r = c.width / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, color);
  grad.addColorStop(0.18, hexToRgba(color, 0.85));
  grad.addColorStop(0.42, hexToRgba(color, 0.22));
  grad.addColorStop(1, hexToRgba(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  sp = { img: c, size };
  spriteCache.set(color, sp);
  return sp;
}
