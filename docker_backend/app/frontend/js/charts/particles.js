/*
 * particles.js — 沿曲线流动的粒子场。
 *
 * 设计约束（对应"粒子必须与数据产生联系"）：
 *   - 粒子沿当前窗口内真实数据曲线运动，不是随机漂浮；
 *   - 速度由局部数值驱动：值越高流得越快，CPU 飙升时（energy）整体加速；
 *   - 光晕亮度同样由数值驱动：忙的段亮、闲的段暗；
 *   - 指针靠近时轻微加速 + 提亮（≤80px 半径，克制）；
 *   - 数量少（每条曲线 10~60 颗）、体积小、加色混合但不遮挡数据线。
 *
 * 性能：位置用"总弧长的分数"存储（0..1），曲线重建时位置按比例保留；
 * 每帧一次二分定位 + 一次贴图 drawImage，几百颗粒子也在 1ms 量级内。
 */

import { dotSprite } from "./engine.js";

export class FlowField {
  /**
   * @param {object} o
   * @param {string} o.color      系列颜色（#rrggbb）
   * @param {number} o.count      粒子数
   * @param {number} [o.baseSpeed=16]   基础速度 px/s
   * @param {number} [o.speedGain=34]   数值→速度增益
   * @param {number} [o.alpha=0.5]      基础不透明度
   */
  constructor({ color, count, baseSpeed = 16, speedGain = 34, alpha = 0.5 }) {
    this.color = color;
    this.sprite = dotSprite(color);
    this.alpha = alpha;
    this.baseSpeed = baseSpeed;
    this.speedGain = speedGain;
    this.pts = [];
    this.cum = [];
    this.total = 0;
    this.parts = Array.from({ length: count }, () => ({
      f: Math.random(),                    // 弧长分数 0..1
      jitter: 0.65 + Math.random() * 0.7,  // 个体速度差异，避免"列车"感
    }));
    this.pointer = null;   // {x, y} | null
    this.energy = 0;       // 数据飙升能量 0..1
  }

  /** 图表重建几何时调用。pts: [{x,y,ratio}]（ratio=归一化数值 0..1） */
  setPath(pts) {
    this.pts = pts;
    this.cum = new Array(pts.length);
    let acc = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        acc += Math.sqrt(dx * dx + dy * dy);
      }
      this.cum[i] = acc;
    }
    this.total = acc;
  }

  setPointer(p) { this.pointer = p; }
  setEnergy(e) { this.energy = e; }

  /** 弧长分数 → {x, y, ratio} */
  #pointAt(f) {
    const { pts, cum, total } = this;
    if (!total || !pts.length) return null;
    const target = ((f % 1) + 1) % 1 * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    const i = Math.max(1, lo);
    const seg = cum[i] - cum[i - 1] || 1;
    const t = (target - cum[i - 1]) / seg;
    const a = pts[i - 1], b = pts[i];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      ratio: a.ratio + (b.ratio - a.ratio) * t,
    };
  }

  update(dtMs) {
    if (!this.total) return;
    const dtS = dtMs / 1000;
    const energyBoost = 1 + this.energy * 1.7;
    for (const p of this.parts) {
      const q = this.#pointAt(p.f);
      if (!q) continue;
      let speed = (this.baseSpeed + this.speedGain * q.ratio) * p.jitter * energyBoost;
      let lift = 0;
      if (this.pointer) {
        const dx = this.pointer.x - q.x;
        const dy = this.pointer.y - q.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 80) {
          const k = 1 - d / 80;
          speed *= 1 + k * 0.35;   // 指针附近轻微加速
          lift = k * 0.3;          // 与轻微提亮
        }
      }
      p.lift = lift;
      p.f = (p.f + (speed * dtS) / this.total) % 1;
    }
  }

  draw(ctx) {
    if (!this.total) return;
    const { img, size } = this.sprite;
    const half = size / 2;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.parts) {
      const q = this.#pointAt(p.f);
      if (!q) continue;
      const a = this.alpha * (0.25 + 0.75 * q.ratio) * (1 + (p.lift || 0));
      ctx.globalAlpha = Math.min(0.85, a);
      ctx.drawImage(img, q.x - half, q.y - half, size, size);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
