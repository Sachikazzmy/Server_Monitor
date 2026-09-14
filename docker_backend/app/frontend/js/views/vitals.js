/*
 * vitals.js — 生命体征条：CPU / Memory / Load / Telemetry 四格。
 *
 * 数值用补间流动到新值；状态词由阈值划分（前端解释，不改数据）；
 * 前三格点击进入对应 Focus View。
 */

import { getStore, subscribe } from "../store.js";
import { fmtAgo, fmtMem, fmtSigned } from "../format.js";
import { tweenText } from "../tween.js";

const el = (id) => document.getElementById(id);

/** CPU busy 状态词（busy = us+sy+wa，百分点） */
function cpuState(v) {
  if (v < 40) return ["NOMINAL", "st-ok"];
  if (v < 75) return ["ELEVATED", "st-warn"];
  return ["SATURATED", "st-crit"];
}

function memState(pct) {
  if (pct < 70) return ["NOMINAL", "st-ok"];
  if (pct < 88) return ["ELEVATED", "st-warn"];
  return ["PRESSURED", "st-crit"];
}

export function initVitals({ onOpenFocus }) {
  const $ = {
    cpu: el("vt-cpu"), cpuState: el("vt-cpu-state"), cpuDelta: el("vt-cpu-delta"),
    mem: el("vt-mem"), memTotal: el("vt-mem-total"), memBar: el("vt-mem-bar"), memState: el("vt-mem-state"),
    load: el("vt-load"), loadRest: el("vt-load-rest"), loadTrend: el("vt-load-trend"),
    seq: el("vt-seq"), cadence: el("vt-cadence"), age: el("vt-age"),
  };

  subscribe(() => {
    const st = getStore();
    if (st.empty) return;
    const n = st.times.length;
    const last = n - 1;
    const cadence = st.cadenceSec || 10;

    /* CPU：busy = us+sy+wa */
    const busy = st.cpu.busy[last];
    if (busy != null) {
      tweenText($.cpu, busy, (v) => v.toFixed(1));
      const [word, cls] = cpuState(busy);
      $.cpuState.textContent = word;
      $.cpuState.className = cls;
      const back = Math.max(0, last - Math.round(60 / cadence));
      const b0 = st.cpu.busy[back];
      if (b0 != null && back !== last) {
        $.cpuDelta.textContent = `${fmtSigned(busy - b0, 1)} / 60s`;
      } else {
        $.cpuDelta.textContent = "";
      }
    }

    /* Memory */
    const used = st.mem.used[last];
    if (used != null && st.totalMem) {
      tweenText($.mem, used / 1024, (v) => v.toFixed(1));
      $.memTotal.textContent = `/ ${(st.totalMem / 1024).toFixed(0)} GB`;
      const pct = (used / st.totalMem) * 100;
      $.memBar.style.width = `${Math.min(100, pct).toFixed(1)}%`;
      const [word, cls] = memState(pct);
      $.memState.textContent = word;
      $.memState.className = cls;
    }

    /* Load */
    const l1 = st.load.l1[last];
    if (l1 != null) {
      tweenText($.load, l1, (v) => v.toFixed(2));
      const l5 = st.load.l5[last], l15 = st.load.l15[last];
      $.loadRest.textContent = `5m ${l5?.toFixed(2) ?? "--"} · 15m ${l15?.toFixed(2) ?? "--"}`;
      const diff = l1 - (l5 ?? l1);
      if (Math.abs(diff) < 0.05) {
        $.loadTrend.textContent = "STEADY";
        $.loadTrend.className = "st-idle";
      } else if (diff > 0) {
        $.loadTrend.textContent = "▲ RISING";
        $.loadTrend.className = "st-warn";
      } else {
        $.loadTrend.textContent = "▼ EASING";
        $.loadTrend.className = "st-ok";
      }
    }

    /* Telemetry */
    tweenText($.seq, st.packets, (v) => String(Math.round(v)));
    $.cadence.textContent = `${cadence.toFixed(0)}s cadence`;
  });

  // 数据包年龄：每秒刷新 + 按新鲜度着色
  const ageTick = () => {
    const st = getStore();
    if (!st.lastPacketAt) { $.age.textContent = ""; return; }
    const age = Date.now() - st.lastPacketAt;
    $.age.textContent = `T-${fmtAgo(age)}`;
    $.age.className = age < 15000 ? "st-ok" : age < 45000 ? "st-warn" : "st-crit";
  };
  ageTick();
  setInterval(ageTick, 1000);

  // 前三格点击 → Focus
  for (const btn of document.querySelectorAll(".vital[data-metric]")) {
    btn.addEventListener("click", () => onOpenFocus(btn.dataset.metric));
  }
}
