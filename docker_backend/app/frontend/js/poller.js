/*
 * poller.js — 与后端的唯一联系：轮询 GET /api/metrics/today?offset=N。
 *
 * 协议与旧版完全一致：
 *   首屏不带 offset（=0）→ 今天已落盘的数据一次拿齐；
 *   之后带返回的 offset → 只拿新增行；
 *   rolled_over=true → 文件跨天滚动，前端整体重置。
 * 本文件是前端里唯一知道 URL 的地方。
 */

import { applyRecords } from "./store.js";

const POLL_INTERVAL_MS = 2000; // agent 每 10s 发一包，2s 轮询不会漏

let byteOffset = 0;
let timer = 0;
let inFlight = false;
const statusSubs = new Set();

/** 订阅连接状态：'live' | 'error' */
export function onPollStatus(fn) {
  statusSubs.add(fn);
  return () => statusSubs.delete(fn);
}

function emit(status) {
  for (const fn of statusSubs) fn(status);
}

export async function pollOnce() {
  if (inFlight) return; // 上一次还没回来就不叠加请求
  inFlight = true;
  try {
    const res = await fetch(`/api/metrics/today?offset=${byteOffset}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    byteOffset = payload.offset;
    applyRecords(payload.records, { reset: Boolean(payload.rolled_over) });
    emit("live");
  } catch {
    emit("error");
  } finally {
    inFlight = false;
  }
}

export function startPolling() {
  pollOnce();
  timer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

export function stopPolling() {
  clearInterval(timer);
}
