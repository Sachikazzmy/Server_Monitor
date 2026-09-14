/*
 * configs.js — 三块指标的图表配置。
 *
 * 颜色只声明 CSS 变量名（单一来源在 tokens.css），
 * main.js 启动时解析成 hex 注入到 series.color。
 */

import { fmtMem, fmtMemAxis, fmtNum } from "../format.js";

export const METRICS = {
  cpu: {
    key: "cpu",
    title: "CPU",
    unit: "%",
    windowPoints: 150,          // Overview 窗口（≈25 分钟 @10s）
    yMax: 100,                  // 固定 0-100，尖峰不压缩历史形态
    spikeKey: "busy",           // 派生系列：us+sy+wa
    spikeDelta: 8,              // 相邻采样变化 ≥8 个百分点 → 视为波动事件
    primary: "busy",
    series: [
      { key: "us", label: "USER", colorVar: "--c-cpu-us", width: 2 },
      { key: "sy", label: "SYSTEM", colorVar: "--c-cpu-sy", width: 2 },
      { key: "wa", label: "IO WAIT", colorVar: "--c-cpu-wa", width: 1.5 },
      { key: "id", label: "IDLE", colorVar: "--c-cpu-id", width: 1.25, area: true, areaAlpha: 0.1 },
    ],
    particles: [
      { series: "us", count: 24, baseSpeed: 18, speedGain: 42, alpha: 0.5 },
      { series: "sy", count: 12, baseSpeed: 14, speedGain: 30, alpha: 0.4 },
    ],
    fmtValue: (v) => v.toFixed(1),
    fmtTip: (v) => `${v.toFixed(2)} %`,
    fmtAxis: (v) => `${Math.round(v)}`,
  },

  memory: {
    key: "memory",
    title: "MEMORY",
    unit: "MB",
    windowPoints: 150,
    yMax: null,                 // 自适应 + nice 刻度
    spikeKey: "used",
    spikeDelta: 512,            // 相邻采样变化 ≥512MB → 波动事件
    primary: "used",
    series: [
      { key: "used", label: "USED", colorVar: "--c-mem-used", width: 2, area: true, areaAlpha: 0.13 },
      { key: "wired", label: "WIRED", colorVar: "--c-mem-wired", width: 1.5 },
      { key: "compressor", label: "COMPRESSED", colorVar: "--c-mem-comp", width: 1.5 },
      { key: "free", label: "FREE", colorVar: "--c-mem-free", width: 1.25 },
    ],
    particles: [
      { series: "used", count: 14, baseSpeed: 12, speedGain: 22, alpha: 0.4 },
    ],
    fmtValue: (v) => `${(v / 1024).toFixed(1)}G`,
    fmtTip: (v) => fmtMem(v),
    fmtAxis: (v) => fmtMemAxis(v),
  },

  load: {
    key: "load",
    title: "LOAD",
    unit: "",
    windowPoints: 150,
    yMax: null,
    spikeKey: "l1",
    spikeDelta: 0.4,
    primary: "l1",
    series: [
      { key: "l1", label: "1 MIN", colorVar: "--c-load-l1", width: 2 },
      { key: "l5", label: "5 MIN", colorVar: "--c-load-l5", width: 1.5 },
      { key: "l15", label: "15 MIN", colorVar: "--c-load-l15", width: 1.25 },
    ],
    particles: [
      { series: "l1", count: 12, baseSpeed: 12, speedGain: 26, alpha: 0.38 },
    ],
    fmtValue: (v) => fmtNum(v, 2),
    fmtTip: (v) => fmtNum(v, 2),
    fmtAxis: (v) => fmtNum(v, 1),
  },
};

/** Focus View 用整段历史 + 更密的粒子 */
export function focusCfg(cfg, maxSamples) {
  return {
    ...cfg,
    windowPoints: maxSamples,
    particles: cfg.particles.map((p) => ({ ...p, count: Math.round(p.count * 2.2), alpha: Math.min(0.6, p.alpha * 1.25) })),
  };
}
