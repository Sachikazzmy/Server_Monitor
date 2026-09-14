/*
 * overview.js — Dashboard 组装：三块图表 + 读出条（图例即实时数值）+ 卡片交互。
 *
 * - 订阅仓库：新数据 → 图表 setData + breathe（数据包脉搏）+ 读出条刷新；
 * - 读出条点击：显示/隐藏系列（其他系列保持原样，不做过度强调）；
 * - 面板点击：进入 Focus View（回调注入，避免与 focus.js 循环依赖）。
 */

import { METRICS } from "../charts/configs.js";
import { MetricChart } from "../charts/metricChart.js";
import { getStore, metricData, subscribe } from "../store.js";

export function initOverview({ reduceMotion, onOpenFocus }) {
  const charts = {};
  const roItems = {};

  for (const key of Object.keys(METRICS)) {
    const cfg = METRICS[key];
    const chart = new MetricChart({
      canvas: document.getElementById(`canvas-${key}`),
      wrap: document.getElementById(`wrap-${key}`),
      tip: document.getElementById(`tip-${key}`),
      cfg,
      reduceMotion,
    });
    charts[key] = chart;

    // 读出条：每系列一枚「色点 + 名称 + 实时值」，点击切换可见性
    const ro = document.getElementById(`readout-${key}`);
    roItems[key] = cfg.series.map((s) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ro";
      btn.style.setProperty("--c", s.color);
      btn.setAttribute("aria-pressed", "true");
      btn.innerHTML = `<i></i><span>${s.label}</span><b>—</b>`;
      const valEl = btn.querySelector("b");
      // 悬停读出项 → 强调该系列，其余降权；移开恢复
      btn.addEventListener("mouseenter", () => chart.setEmphasis(s.key));
      btn.addEventListener("mouseleave", () => chart.setEmphasis(null));
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // 不触发面板的 Focus
        const turningOff = !btn.hasAttribute("data-off");
        btn.toggleAttribute("data-off", turningOff);
        btn.setAttribute("aria-pressed", String(!turningOff));
        chart.setVisible(s.key, !turningOff);
      });
      ro.appendChild(btn);
      return { key: s.key, valEl };
    });

    document.getElementById(`panel-${key}`).addEventListener("click", () => onOpenFocus(key));
  }

  subscribe(({ appended, reset }) => {
    const st = getStore();
    const cadence = st.cadenceSec || 10;

    for (const key of Object.keys(charts)) {
      const chart = charts[key];
      chart.setData(st.times, metricData(key), { reset });
      if (appended > 0) chart.breathe();

      const vals = chart.latestValues();
      for (const item of roItems[key]) {
        item.valEl.textContent = vals[item.key] == null ? "—" : METRICS[key].fmtValue(vals[item.key]);
      }

      const meta = document.getElementById(`meta-${key}`);
      const mins = Math.max(1, Math.round((METRICS[key].windowPoints * cadence) / 60));
      meta.textContent = `${mins} MIN · ${chart.sampleCount} PTS`;
    }
  });

  return {
    /** Focus 打开时暂停 Overview 渲染，关闭时恢复 */
    setChartsActive(active) {
      for (const c of Object.values(charts)) c.setActive(active);
    },
  };
}
