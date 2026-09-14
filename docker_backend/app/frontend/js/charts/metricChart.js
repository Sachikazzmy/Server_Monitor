/*
 * metricChart.js — 单指标图表：数据窗口、几何、渲染循环、Hover、脉冲。
 *
 * 「数据驱动动画」的实现要点：
 *   - breathe()：每个真实数据包到达时调用一次，曲线端点的光晕随之搏动
 *     后指数衰减——这是"心跳"，节奏来自 agent 的真实采集节奏；
 *   - energy：相邻采样变化超过 spikeDelta 时激发（CPU 飙升 → 线更亮、
 *     粒子加速、端点扩出一圈涟漪），随后指数衰减回到平静；
 *   - 粒子沿真实曲线流动，速度/亮度由局部数值驱动（见 particles.js）；
 *   - Hover：十字线 + 各系列取值点 + 指针微光 + 粒子轻微响应 + tooltip。
 *
 * 性能：单 rAF（loop.js）；几何与 Path2D 只在数据/尺寸变化时重建；
 * 每帧只做描边与贴图；面板不可见时 setActive(false) 完全停画。
 */

import { addFrameTask, removeFrameTask } from "../loop.js";
import { fmtClock } from "../format.js";
import { clamp, hexToRgba, niceCeil, yTicks, timeTicks, buildLinePath, buildAreaPath } from "./engine.js";
import { FlowField } from "./particles.js";

const TAU = Math.PI * 2;
const PAD = { left: 46, right: 16, top: 14, bottom: 24 };
const LABEL = "#5d6874";
const LABEL_FAINT = "#3f4954";
const FONT_AXIS = "10px ui-monospace, Menlo, monospace";

export class MetricChart {
  constructor({ canvas, wrap, tip, cfg, reduceMotion = false }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.wrap = wrap;
    this.tip = tip;
    this.cfg = cfg;
    this.reduceMotion = reduceMotion;

    this.times = [];
    this.data = {};
    this.hidden = new Set();
    this.emphasis = null;      // 图例悬停强调的系列 key（null=无）
    this.pointer = null;       // {x,y} css px（画布内）
    this.hover = null;         // {t: epoch ms, cy}
    this.energy = 0;           // 波动能量 0..1
    this.breatheT = 0;         // 数据包脉搏 0..1
    this.ripples = [];         // [{t0}] 波动涟漪
    this.active = true;
    this.dirty = true;
    this.geo = null;
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.prevLast = null;      // spike 检测用
    this.lastN = 0;
    this.touchTimer = 0;

    this.flows = cfg.particles.map((p) => {
      const s = cfg.series.find((x) => x.key === p.series);
      return {
        seriesKey: p.series,
        field: new FlowField({ color: s.color, count: p.count, baseSpeed: p.baseSpeed, speedGain: p.speedGain, alpha: p.alpha }),
      };
    });

    this.taskId = `chart-${cfg.key}-${Math.random().toString(36).slice(2, 7)}`;
    addFrameTask(this.taskId, (now, dt) => this.#frame(now, dt));

    this.ro = new ResizeObserver(() => this.#resize());
    this.ro.observe(wrap);
    this.#resize();

    canvas.addEventListener("pointermove", (e) => this.#onPointer(e));
    canvas.addEventListener("pointerdown", (e) => this.#onPointer(e, true));
    canvas.addEventListener("pointerleave", () => this.#onLeave());
    canvas.addEventListener("pointercancel", () => this.#onLeave());
    canvas.addEventListener("pointerup", (e) => {
      if (e.pointerType !== "mouse") this.#scheduleTouchClear();
    });
  }

  /* ---------- 公共接口 ---------- */

  /** 传入仓库全量数组（内部只拷贝自己的窗口） */
  setData(times, dataByKey, { reset = false } = {}) {
    const n = times.length;
    if (!n) {
      this.times = [];
      this.data = {};
      this.geo = null;
      this.prevLast = null;
      this.lastN = 0;
      this.dirty = true;
      this.#hideTip();
      return;
    }

    // 波动检测：只在有少量新点时比较端值（初次全量/重置不触发）
    const sk = this.cfg.spikeKey;
    const arr = sk ? dataByKey[sk] : null;
    if (arr && arr.length) {
      const last = arr[n - 1];
      const fresh = n - this.lastN;
      if (!reset && this.prevLast != null && fresh >= 1 && fresh <= 3 && last != null) {
        const delta = Math.abs(last - this.prevLast);
        if (delta >= this.cfg.spikeDelta && !this.reduceMotion) {
          this.energy = clamp(delta / (this.cfg.spikeDelta * 2.2), 0.4, 1);
          this.ripples.push({ t0: performance.now() });
        }
      }
      this.prevLast = last;
    }
    this.lastN = n;

    const from = Math.max(0, n - this.cfg.windowPoints);
    this.times = times.slice(from, n);
    this.data = {};
    for (const s of this.cfg.series) {
      this.data[s.key] = (dataByKey[s.key] || []).slice(from, n);
    }
    if (sk && !this.cfg.series.some((s) => s.key === sk)) {
      this.data[sk] = (dataByKey[sk] || []).slice(from, n);
    }
    this.dirty = true;
    this.#refreshTip();
  }

  /** 数据包脉搏：曲线端点光晕搏动一次 */
  breathe() {
    if (this.reduceMotion) return;
    this.breatheT = 1;
  }

  setVisible(key, visible) {
    if (visible) this.hidden.delete(key);
    else this.hidden.add(key);
    this.dirty = true;
    this.#refreshTip();
  }

  /** 图例悬停 → 强调该系列，其余系列降权（null 恢复） */
  setEmphasis(key) {
    this.emphasis = key || null;
    this.dirty = true;
  }

  /** Focus 打开时暂停 Overview 图表渲染 */
  setActive(a) {
    this.active = a;
    if (a) this.dirty = true;
  }

  /** 当前窗口各系列最新值（readout 用） */
  latestValues() {
    const out = {};
    for (const s of this.cfg.series) {
      const arr = this.data[s.key];
      if (!arr || !arr.length) continue;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] != null) { out[s.key] = arr[i]; break; }
      }
    }
    return out;
  }

  get sampleCount() { return this.times.length; }
  get windowStart() { return this.times.length ? this.times[0] : null; }
  get windowEnd() { return this.times.length ? this.times[this.times.length - 1] : null; }

  destroy() {
    removeFrameTask(this.taskId);
    this.ro.disconnect();
  }

  /* ---------- 尺寸 ---------- */

  #resize() {
    const r = this.wrap.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    const dpr = window.devicePixelRatio || 1;
    this.cssW = r.width;
    this.cssH = r.height;
    this.dpr = dpr;
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dirty = true;
  }

  /* ---------- 帧循环 ---------- */

  #frame(now, dt) {
    if (!this.active || this.cssW < 8) return;

    if (this.breatheT > 0) {
      this.breatheT *= Math.exp(-dt / 1500);
      if (this.breatheT < 0.01) this.breatheT = 0;
    }
    if (this.energy > 0) {
      this.energy *= Math.exp(-dt / 1100);
      if (this.energy < 0.01) this.energy = 0;
    }
    if (this.ripples.length) {
      this.ripples = this.ripples.filter((r) => now - r.t0 < 950);
    }

    const flowsOn = this.flows.length > 0 && !this.reduceMotion;
    const animating =
      this.dirty || this.hover || this.breatheT > 0 || this.energy > 0 ||
      this.ripples.length > 0 || flowsOn;
    if (!animating) return;

    if (this.dirty) {
      this.#rebuild();
      this.dirty = false;
    }
    if (flowsOn) {
      for (const { field } of this.flows) {
        field.setEnergy(this.energy);
        field.update(dt, this.pointer);
      }
    }
    this.#render(now);
  }

  /* ---------- 几何重建（仅数据/尺寸变化时） ---------- */

  #rebuild() {
    const n = this.times.length;
    if (n < 2) { this.geo = null; return; }

    const plot = {
      x: PAD.left,
      y: PAD.top,
      w: this.cssW - PAD.left - PAD.right,
      h: this.cssH - PAD.top - PAD.bottom,
    };
    if (plot.w < 20 || plot.h < 20) { this.geo = null; return; }

    let yMax = this.cfg.yMax;
    if (yMax == null) {
      let m = 0;
      for (const s of this.cfg.series) {
        if (this.hidden.has(s.key)) continue;
        const a = this.data[s.key];
        for (let i = 0; i < n; i++) {
          const v = a[i];
          if (v != null && v > m) m = v;
        }
      }
      yMax = niceCeil(m * 1.08);
    }

    const xToPx = (i) => plot.x + (i / (n - 1)) * plot.w;
    const yToPx = (v) => plot.y + plot.h * (1 - clamp(v / yMax, 0, 1));

    const pts = {};
    for (const s of this.cfg.series) {
      const a = this.data[s.key] || [];
      const list = new Array(n);
      for (let i = 0; i < n; i++) {
        const v = a[i];
        list[i] = v == null ? null : { x: xToPx(i), y: clamp(yToPx(v), plot.y, plot.y + plot.h), v };
      }
      pts[s.key] = list;
    }

    const linePaths = {};
    const areaPaths = {};
    for (const s of this.cfg.series) {
      linePaths[s.key] = buildLinePath(pts[s.key]);
      if (s.area) areaPaths[s.key] = buildAreaPath(pts[s.key], plot.y + plot.h);
    }

    for (const { field, seriesKey } of this.flows) {
      if (this.hidden.has(seriesKey)) { field.setPath([]); continue; }
      const geoPts = (pts[seriesKey] || [])
        .filter(Boolean)
        .map((p) => ({ x: p.x, y: p.y, ratio: clamp(p.v / yMax, 0, 1) }));
      field.setPath(geoPts);
    }

    const prim = this.cfg.series.find((s) => s.key === this.cfg.primary) || this.cfg.series[0];
    const primPts = pts[prim.key] || [];
    const head = primPts.length ? primPts[primPts.length - 1] : null;

    this.geo = {
      plot, yMax, pts, linePaths, areaPaths, head, prim, xToPx,
      yt: yTicks(yMax),
      xt: timeTicks(this.times, 0, n, n > 400 ? 7 : 5),
    };
  }

  /* ---------- 渲染 ---------- */

  #render(now) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    const g = this.geo;
    if (!g) return;
    const { plot, yMax, pts } = g;
    const n = this.times.length;

    /* 网格：横线略亮、纵线更淡 */
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.beginPath();
    for (const v of g.yt) {
      const y = Math.round(plot.y + plot.h * (1 - v / yMax)) + 0.5;
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.026)";
    ctx.beginPath();
    for (const t of g.xt) {
      const x = Math.round(g.xToPx(t.idx)) + 0.5;
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    }
    ctx.stroke();

    /* 轴标签 */
    ctx.fillStyle = LABEL;
    ctx.font = FONT_AXIS;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of g.yt) {
      const y = plot.y + plot.h * (1 - v / yMax);
      ctx.fillText(this.cfg.fmtAxis(v), plot.x - 8, y);
    }
    ctx.fillStyle = LABEL_FAINT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of g.xt) ctx.fillText(t.label, g.xToPx(t.idx), plot.y + plot.h + 6);

    /* 面积（数据体量感：CPU idle 底、Memory used 水位） */
    for (const s of this.cfg.series) {
      if (this.hidden.has(s.key) || !g.areaPaths[s.key]) continue;
      const dim = this.emphasis && s.key !== this.emphasis;
      const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + plot.h);
      grad.addColorStop(0, hexToRgba(s.color, (s.areaAlpha ?? 0.12) * (dim ? 0.35 : 1)));
      grad.addColorStop(1, hexToRgba(s.color, 0));
      ctx.fillStyle = grad;
      ctx.fill(g.areaPaths[s.key]);
    }

    /* 曲线：主系列 / 波动时先铺一层低透明度粗描边作局部辉光，再描实体线；
       图例悬停时非强调系列降为暗线，帮助视线聚焦 */
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const s of this.cfg.series) {
      if (this.hidden.has(s.key)) continue;
      const dim = this.emphasis && s.key !== this.emphasis;
      if (dim) {
        ctx.strokeStyle = hexToRgba(s.color, 0.22);
        ctx.lineWidth = s.width;
        ctx.stroke(g.linePaths[s.key]);
        continue;
      }
      const isPrimary = s.key === this.cfg.primary;
      const glow = (isPrimary ? 0.09 : 0) + this.energy * 0.22 + this.breatheT * 0.05;
      if (glow > 0.02) {
        ctx.strokeStyle = hexToRgba(s.color, Math.min(0.34, glow));
        ctx.lineWidth = s.width + 5;
        ctx.stroke(g.linePaths[s.key]);
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.stroke(g.linePaths[s.key]);
    }

    /* 端点"心跳"：每个数据包到达时轻轻搏动，亮度随当前值 */
    const head = g.head;
    if (head) {
      const pc = g.prim.color;
      const ratio = clamp(head.v / yMax, 0, 1);
      const inten = 0.16 + this.breatheT * 0.5 + this.energy * 0.35;
      const r = 7 + 10 * ratio + this.breatheT * 6;
      const grad = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, r);
      grad.addColorStop(0, hexToRgba(pc, Math.min(0.5, inten)));
      grad.addColorStop(1, hexToRgba(pc, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(head.x - r, head.y - r, r * 2, r * 2);

      ctx.fillStyle = pc;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 2.1, 0, TAU);
      ctx.fill();

      ctx.strokeStyle = hexToRgba(pc, Math.min(0.28, inten * 0.5));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 4.5 + this.breatheT * 2.5, 0, TAU);
      ctx.stroke();

      /* 波动涟漪：数据跳变时从端点扩散一圈 */
      for (const rp of this.ripples) {
        const p = (now - rp.t0) / 950;
        ctx.strokeStyle = hexToRgba(pc, (1 - p) * 0.32);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 6 + 46 * p, 0, TAU);
        ctx.stroke();
      }
    }

    /* 粒子流：强调某系列时，其余系列的粒子让位 */
    for (const { field, seriesKey } of this.flows) {
      if (this.hidden.has(seriesKey)) continue;
      if (this.emphasis && seriesKey !== this.emphasis) continue;
      field.draw(ctx);
    }

    /* Hover 层：指针微光 + 十字线 + 系列取值点 */
    if (this.hover && n > 1) {
      const idx = this.#idxForTime(this.hover.t);
      const hx = Math.round(g.xToPx(idx)) + 0.5;

      if (this.pointer) {
        const pr = 84;
        const grad = ctx.createRadialGradient(this.pointer.x, this.pointer.y, 0, this.pointer.x, this.pointer.y, pr);
        grad.addColorStop(0, "rgba(255,255,255,0.05)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(this.pointer.x - pr, this.pointer.y - pr, pr * 2, pr * 2);
      }

      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, plot.y);
      ctx.lineTo(hx, plot.y + plot.h);
      ctx.stroke();

      for (const s of this.cfg.series) {
        if (this.hidden.has(s.key)) continue;
        const p = pts[s.key][idx];
        if (!p) continue;
        const dim = this.emphasis && s.key !== this.emphasis;
        ctx.fillStyle = "#0d1116";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.4, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = dim ? hexToRgba(s.color, 0.3) : s.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.4, 0, TAU);
        ctx.stroke();
      }
    }
  }

  /* ---------- Hover / Tooltip ---------- */

  #onPointer(e, isDown = false) {
    if (!this.geo || this.times.length < 2) return;
    if (isDown) clearTimeout(this.touchTimer);
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const { plot } = this.geo;
    const n = this.times.length;
    const i = clamp(Math.round(((px - plot.x) / plot.w) * (n - 1)), 0, n - 1);
    this.pointer = { x: px, y: py };
    this.hover = { t: this.times[i], cy: py };
    this.#refreshTip();
  }

  #onLeave() {
    this.pointer = null;
    this.hover = null;
    this.#hideTip();
  }

  #scheduleTouchClear() {
    clearTimeout(this.touchTimer);
    this.touchTimer = setTimeout(() => this.#onLeave(), 2400);
  }

  #idxForTime(t) {
    const times = this.times;
    let lo = 0, hi = times.length - 1;
    if (t <= times[0]) return 0;
    if (t >= times[hi]) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  #refreshTip() {
    const tip = this.tip;
    if (!tip) return;
    if (!this.hover || !this.geo || this.times.length < 2) {
      tip.classList.remove("show");
      return;
    }
    const idx = this.#idxForTime(this.hover.t);
    const t = this.times[idx];
    let html = `<div class="tip-time mono">${fmtClock(t)}</div>`;
    for (const s of this.cfg.series) {
      if (this.hidden.has(s.key)) continue;
      const v = (this.data[s.key] || [])[idx];
      html += `<div class="tip-row" style="--c:${s.color}"><i></i><span>${s.label}</span><b>${v == null ? "—" : this.cfg.fmtTip(v)}</b></div>`;
    }
    tip.innerHTML = html;
    const tw = tip.offsetWidth;
    const px = this.geo.xToPx(idx);
    tip.style.left = `${clamp(px - tw / 2, 6, Math.max(6, this.cssW - tw - 6))}px`;
    tip.classList.add("show");
  }

  #hideTip() {
    if (this.tip) this.tip.classList.remove("show");
  }
}
