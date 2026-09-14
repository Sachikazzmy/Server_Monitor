/*
 * loop.js — 全站唯一的 requestAnimationFrame 循环。
 *
 * 所有高频动画（图表重绘、粒子、数值补间）都注册到这里，
 * 而不是各自开 rAF：便于统一暂停（页面隐藏时）与统一节拍。
 */

const tasks = new Map();
let rafId = 0;
let last = 0;
let running = false;

function tick(now) {
  const dt = Math.min(50, now - last); // 钳制单帧步长，切后台回来不会跳变
  last = now;
  for (const fn of tasks.values()) fn(now, dt);
  rafId = requestAnimationFrame(tick);
}

function start() {
  if (running) return;
  running = true;
  last = performance.now();
  rafId = requestAnimationFrame(tick);
}

function stop() {
  running = false;
  cancelAnimationFrame(rafId);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
  else start();
});

/** 注册帧任务；id 相同会覆盖。fn(now, dtMs) */
export function addFrameTask(id, fn) {
  tasks.set(id, fn);
  start();
}

export function removeFrameTask(id) {
  tasks.delete(id);
}
