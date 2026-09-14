/*
 * processes.js — TOP 进程三线表（按 CPU 排序，CPU 列内联占用条）。
 * 每包全量重绘 tbody；新出现的 PID 保留入场动画。
 */

import { getStore, subscribe } from "../store.js";
import { fmtClock } from "../format.js";

const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => escapes[ch]);
}

const byCpuThenMem = (a, b) => (b.cpu_pct - a.cpu_pct) || (b.mem_mb - a.mem_mb);

export function initProcesses() {
  const body = document.getElementById("proc-body");
  const meta = document.getElementById("proc-meta");
  const knownPids = new Set();

  function renderRow(p) {
    const isNew = !knownPids.has(p.pid);
    knownPids.add(p.pid);
    const cpuW = Math.min(100, p.cpu_pct).toFixed(1);
    // 占用越高条越实：低调地表达强度
    const barA = (0.35 + 0.65 * Math.min(1, p.cpu_pct / 50)).toFixed(2);
    return `<tr${isNew ? ' class="row-new"' : ""}>
      <td class="num">${p.pid}</td>
      <td class="cmd">${escapeHtml(p.command)}</td>
      <td class="num cell-cpu"><span class="wrap"><span class="cbar"><i style="width:${cpuW}%;opacity:${barA}"></i></span>${p.cpu_pct.toFixed(2)}</span></td>
      <td class="num">${p.mem_mb.toFixed(2)}</td>
    </tr>`;
  }

  subscribe(() => {
    const st = getStore();
    const rec = st.latest;
    if (!rec || !rec.data || !Array.isArray(rec.data.processes)) return;

    const procs = rec.data.processes.slice().sort(byCpuThenMem);
    knownPids.clear();
    body.innerHTML = procs.map(renderRow).join("");
    meta.textContent = `${procs.length} PROCS · AS OF ${fmtClock(Date.parse(rec.received_at || rec.ts))}`;
  });
}
