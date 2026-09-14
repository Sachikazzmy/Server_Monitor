/*
 * tween.js — 数值补间：让显示值"流动"到新值，而不是每 10 秒生硬跳变。
 * 走 loop.js 的共享 rAF；同一元素重复调用会接管上一次补间。
 */

import { addFrameTask, removeFrameTask } from "./loop.js";

const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);

const live = new WeakMap(); // el → { val, taskId }

/**
 * 把 el.textContent 从当前值平滑补到 target。
 * @param {HTMLElement} el  目标元素
 * @param {number} target   目标数值
 * @param {(v:number)=>string} fmt 数值 → 文本
 * @param {{dur?:number}} [opts]
 */
export function tweenText(el, target, fmt, { dur = 550 } = {}) {
  const prev = live.get(el);
  if (prev) removeFrameTask(prev.taskId);

  const from = prev ? prev.val : 0; // 首次从 0 计起：页面加载时有一个"上电"的瞬间
  const taskId = `tween-${Math.random().toString(36).slice(2, 8)}`;
  const start = performance.now();
  const rec = { val: from, taskId };
  live.set(el, rec);

  if (Math.abs(target - from) < 1e-9) {
    rec.val = target;
    el.textContent = fmt(target);
    return;
  }

  addFrameTask(taskId, (now) => {
    const p = Math.min(1, (now - start) / dur);
    const v = from + (target - from) * easeOutCubic(p);
    rec.val = v;
    el.textContent = fmt(v);
    if (p >= 1) removeFrameTask(taskId);
  });
}
