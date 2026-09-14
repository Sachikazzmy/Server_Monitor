/*
 * main.js — 装配入口。
 *
 * 依赖顺序：
 *   1. 解析 tokens.css 里的语义色（单一颜色来源）注入图表配置；
 *   2. Focus（先建，DOM 就绪）→ Overview（点击回调指向 focus.open）；
 *   3. Header / Vitals / Processes 各自订阅仓库；
 *   4. startPolling() 启动与后端的轮询（协议见 poller.js）。
 */

import { METRICS } from "./charts/configs.js";
import { initFocus } from "./views/focus.js";
import { initOverview } from "./views/overview.js";
import { initHeader } from "./views/header.js";
import { initVitals } from "./views/vitals.js";
import { initProcesses } from "./views/processes.js";
import { startPolling } from "./poller.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 颜色单一来源：CSS 变量 → 图表配置
{
  const cs = getComputedStyle(document.documentElement);
  for (const metric of Object.values(METRICS)) {
    for (const s of metric.series) s.color = cs.getPropertyValue(s.colorVar).trim();
  }
}

const focus = initFocus({ reduceMotion });
const overview = initOverview({ reduceMotion, onOpenFocus: focus.open });
focus.setOnOpenChange((isOpen) => overview.setChartsActive(!isOpen));

initHeader();
initVitals({ onOpenFocus: focus.open });
initProcesses();

startPolling();
