/*
 * header.js — 顶栏：时钟（本地/UTC）、agent 身份、连接状态胶囊。
 *
 * 状态机（前端可观测事实，不虚构数据）：
 *   轮询失败        → RECONNECTING
 *   无数据          → CONNECTING
 *   最后数据 <15s   → LIVE
 *   15~45s 没有新包 → DELAYED
 *   >45s 没有新包   → NO SIGNAL
 * LIVE 状态下每个真实数据包到达时，状态点搏动一次（遥测心跳）。
 */

import { fmtClock } from "../format.js";
import { getStore, subscribe } from "../store.js";
import { onPollStatus } from "../poller.js";

export function initHeader() {
  const agentEl = document.getElementById("hd-agent");
  const clockEl = document.getElementById("hd-clock");
  const utcEl = document.getElementById("hd-utc");
  const pill = document.getElementById("hd-live");
  const pillText = document.getElementById("hd-live-text");
  const dot = pill.querySelector(".dot");

  // 时钟：本地 + UTC 双显（服务器视角常看 UTC）
  const tickClock = () => {
    const now = new Date();
    clockEl.textContent = fmtClock(now.getTime());
    utcEl.textContent = fmtClock(now.getTime() + now.getTimezoneOffset() * 60000);
  };
  tickClock();
  setInterval(tickClock, 1000);

  const setPill = (cls, text) => {
    pill.className = `live-pill ${cls}`.trim();
    pillText.textContent = text;
  };

  let pollOk = null;
  const refresh = () => {
    if (pollOk === false) return setPill("warn", "RECONNECTING");
    const st = getStore();
    if (st.empty || !st.lastPacketAt) return setPill("", "CONNECTING");
    const age = Date.now() - st.lastPacketAt;
    if (age < 15000) setPill("live", "LIVE");
    else if (age < 45000) setPill("warn", "DELAYED");
    else setPill("crit", "NO SIGNAL");
  };
  setInterval(refresh, 1000);
  onPollStatus((s) => {
    pollOk = s === "live";
    refresh();
  });

  subscribe(() => {
    const st = getStore();
    agentEl.textContent = st.agentId || "—";
    // 遥测心跳：仅 LIVE 时搏动，节奏 = 真实数据包节奏
    if (st.lastPacketAt && pill.classList.contains("live")) {
      dot.animate(
        [
          { boxShadow: "0 0 0 0 rgba(75, 201, 124, 0.55)" },
          { boxShadow: "0 0 0 10px rgba(75, 201, 124, 0)" },
        ],
        { duration: 900, easing: "ease-out" },
      );
    }
  });
}
