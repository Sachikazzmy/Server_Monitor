/*
 * format.js — 时间与数值格式化。全部本地时区显示。
 */

const pad2 = (n) => String(n).padStart(2, "0");

/** epoch ms → 本地 HH:MM:SS */
export function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** epoch ms → 本地 HH:MM（窄空间用） */
export function fmtHM(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 距 now 的时长 → "3s" / "1m24s" / "12m" */
export function fmtAgo(ageMs) {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? pad2(s % 60) + "s" : ""}`;
  return `${Math.floor(m / 60)}h${pad2(m % 60)}m`;
}

/** MB → "15.9 GB" / "512 MB" */
export function fmtMem(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** MB 轴刻度 → "16G" / "512" */
export function fmtMemAxis(mb) {
  return mb >= 1024 ? `${Math.round(mb / 1024)}G` : `${Math.round(mb)}`;
}

export function fmtNum(v, digits = 2) {
  return Number(v).toFixed(digits);
}

/** 带符号差值，如 "+1.24" / "-0.40" */
export function fmtSigned(v, digits = 2) {
  const n = Number(v);
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}
