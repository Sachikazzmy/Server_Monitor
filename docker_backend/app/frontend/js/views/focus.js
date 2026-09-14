/*
 * focus.js — Focus View：图表"从 Dashboard 原位展开"的全屏详情。
 *
 * 动画：FLIP —— 打开时面板从来源卡片的矩形变换到最终位置（transform 过渡），
 * 关闭时反向收缩回原位。图表数据来自同一仓库，展开瞬间即有完整历史，
 * 没有加载感；打开期间 Overview 图表暂停渲染（setChartsActive(false)）。
 *
 * 内容：当前值（补间）、Δ60s、窗口 MIN/AVG/MAX、系列开关、构成条、
 * 大图表（整段历史 + 更密的粒子流）。
 */

import { METRICS, focusCfg } from "../charts/configs.js";
import { MAX_SAMPLES, getStore, metricData, subscribe } from "../store.js";
import { MetricChart } from "../charts/metricChart.js";
import { fmtClock, fmtHM, fmtMem, fmtSigned } from "../format.js";
import { tweenText } from "../tween.js";

const SUBS = {
  cpu: "USER · SYSTEM · IO WAIT · IDLE",
  memory: "USED · WIRED · COMPRESSED · FREE",
  load: "1 / 5 / 15 MIN",
};

const NOW_FMT = {
  cpu: (v) => v.toFixed(1),
  memory: (v) => (v / 1024).toFixed(1),
  load: (v) => v.toFixed(2),
};

const NOW_UNIT = { cpu: "%", memory: "GB", load: "" };

const STAT_FMT = {
  cpu: (v) => v.toFixed(1),
  memory: (v) => fmtMem(v),
  load: (v) => v.toFixed(2),
};

const DELTA_FMT = {
  cpu: (v) => `${fmtSigned(v, 1)} pp / 60s`,
  memory: (v) => `${fmtSigned(v / 1024, 2)} GB / 60s`,
  load: (v) => `${fmtSigned(v, 2)} / 60s`,
};

export function initFocus({ reduceMotion }) {
  const root = document.getElementById("focus-root");
  root.innerHTML = `
    <div class="focus-scrim"></div>
    <section class="focus-panel" role="dialog" aria-modal="true" aria-label="Chart focus view">
      <header class="focus-hd">
        <i class="tick" id="fc-tick"></i>
        <div class="focus-title"><h2 id="fc-title"></h2><span id="fc-sub"></span></div>
        <div class="focus-current"><b id="fc-now" class="mono">--</b><small id="fc-unit"></small><em id="fc-delta" class="mono"></em></div>
        <button class="focus-close" id="fc-close" type="button" aria-label="Close focus view">✕<span>ESC</span></button>
      </header>
      <div class="focus-stats">
        <div class="fs-block"><span>Min</span><b id="fc-min">—</b></div>
        <div class="fs-block"><span>Avg</span><b id="fc-avg">—</b></div>
        <div class="fs-block"><span>Max</span><b id="fc-max">—</b></div>
        <div class="fs-chips" id="fc-chips"></div>
      </div>
      <div class="focus-comp" id="fc-comp">
        <div class="comp-bar" id="fc-compbar"></div>
        <div class="comp-cap"><span id="fc-capl"></span><span id="fc-capr"></span></div>
      </div>
      <div class="focus-chart-wrap" id="fc-wrap">
        <canvas id="fc-canvas"></canvas>
        <div class="chart-tip mono" id="fc-tip"></div>
      </div>
      <footer class="focus-ft"><span id="fc-range"></span><span id="fc-count"></span></footer>
    </section>`;

  root.hidden = true; // 双保险：构建完成即隐藏，等 open() 再显示

  const els = {
    panel: root.querySelector(".focus-panel"),
    scrim: root.querySelector(".focus-scrim"),
    tick: root.querySelector("#fc-tick"),
    title: root.querySelector("#fc-title"),
    sub: root.querySelector("#fc-sub"),
    now: root.querySelector("#fc-now"),
    unit: root.querySelector("#fc-unit"),
    delta: root.querySelector("#fc-delta"),
    min: root.querySelector("#fc-min"),
    avg: root.querySelector("#fc-avg"),
    max: root.querySelector("#fc-max"),
    chips: root.querySelector("#fc-chips"),
    comp: root.querySelector("#fc-comp"),
    compbar: root.querySelector("#fc-compbar"),
    capl: root.querySelector("#fc-capl"),
    capr: root.querySelector("#fc-capr"),
    canvas: root.querySelector("#fc-canvas"),
    wrap: root.querySelector("#fc-wrap"),
    tip: root.querySelector("#fc-tip"),
    range: root.querySelector("#fc-range"),
    count: root.querySelector("#fc-count"),
    close: root.querySelector("#fc-close"),
  };

  let isOpen = false;
  let current = null;
  let cfg = null;
  let chart = null;
  let chipRefs = [];
  let animTimer = 0;

  function buildFor(key) {
    cfg = focusCfg(METRICS[key], MAX_SAMPLES);
    if (chart) chart.destroy();
    chart = new MetricChart({ canvas: els.canvas, wrap: els.wrap, tip: els.tip, cfg, reduceMotion });

    els.tick.style.setProperty("--tick", METRICS[key].series[0].color);
    els.title.textContent = cfg.title;
    els.sub.textContent = SUBS[key];
    els.unit.textContent = NOW_UNIT[key];

    // 系列开关（含实时值）
    els.chips.innerHTML = "";
    chipRefs = cfg.series.map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.style.setProperty("--c", s.color);
      b.setAttribute("aria-pressed", "true");
      b.innerHTML = `<i></i><span>${s.label}</span><b>—</b>`;
      b.addEventListener("mouseenter", () => chart.setEmphasis(s.key));
      b.addEventListener("mouseleave", () => chart.setEmphasis(null));
      b.addEventListener("click", () => {
        const turningOff = !b.hasAttribute("data-off");
        b.toggleAttribute("data-off", turningOff);
        b.setAttribute("aria-pressed", String(!turningOff));
        chart.setVisible(s.key, !turningOff);
      });
      els.chips.appendChild(b);
      return { key: s.key, valEl: b.querySelector("b") };
    });

    // 构成条：CPU / Memory 有天然的"份额"语义；Load 用三线即可
    if (key === "cpu" || key === "memory") {
      els.comp.style.display = "";
      els.compbar.innerHTML = cfg.series.map((s) => `<i style="background:${s.color}"></i>`).join("");
    } else {
      els.comp.style.display = "none";
    }
  }

  function syncStats() {
    const st = getStore();
    const d = metricData(current);
    const arr = d[cfg.primary] || [];
    const n = arr.length;
    if (!n) return;

    const cur = arr[n - 1];
    if (cur != null) tweenText(els.now, current === "memory" ? cur / 1024 : cur, NOW_FMT[current]);

    let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
    for (const v of arr) {
      if (v == null) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v;
      cnt++;
    }
    if (cnt) {
      const f = STAT_FMT[current];
      els.min.textContent = f(mn);
      els.avg.textContent = f(sum / cnt);
      els.max.textContent = f(mx);
    }

    const cadence = st.cadenceSec || 10;
    const back = Math.max(0, n - 1 - Math.round(60 / cadence));
    els.delta.textContent = back === n - 1 || arr[back] == null || cur == null ? "" : DELTA_FMT[current](cur - arr[back]);

    for (const c of chipRefs) {
      const v = (d[c.key] || [])[n - 1];
      c.valEl.textContent = v == null ? "—" : METRICS[current].fmtValue(v);
    }

    if (current === "cpu") {
      const g = (k) => d[k][n - 1] ?? 0;
      const parts = ["us", "sy", "wa", "id"].map(g);
      const total = parts.reduce((a, b) => a + b, 0) || 1;
      for (const seg of els.compbar.children) seg.style.width = "0%";
      [...els.compbar.children].forEach((seg, i) => {
        seg.style.width = `${((parts[i] / total) * 100).toFixed(2)}%`;
      });
      els.capl.textContent = `BUSY ${(parts[0] + parts[1] + parts[2]).toFixed(1)} %`;
      els.capr.textContent = `IDLE ${parts[3].toFixed(1)} %`;
    } else if (current === "memory") {
      const total = st.totalMem || ["used", "wired", "compressor", "free"].reduce((a, k) => a + (d[k][n - 1] ?? 0), 0);
      [...els.compbar.children].forEach((seg, i) => {
        const v = d[["used", "wired", "compressor", "free"][i]][n - 1] ?? 0;
        seg.style.width = `${((v / total) * 100).toFixed(2)}%`;
      });
      els.capl.textContent = `USED ${fmtMem(d.used[n - 1] ?? 0)}`;
      els.capr.textContent = `TOTAL ${fmtMem(total)}`;
    }

    if (st.times.length) {
      els.range.textContent = `${fmtHM(st.times[0])} — ${fmtClock(st.times[st.times.length - 1])}`;
      els.count.textContent = `${st.times.length} SAMPLES · ~${cadence.toFixed(0)}S CADENCE`;
    }
  }

  function syncChart() {
    if (!chart || !current) return;
    chart.setData(getStore().times, metricData(current));
  }

  subscribe(({ appended }) => {
    if (!isOpen) return;
    syncChart();
    if (appended > 0) chart.breathe();
    syncStats();
  });

  function open(key) {
    if (isOpen) return;
    const card = document.querySelector(`.chart-panel[data-metric="${key}"]`);
    if (!card) return;

    isOpen = true;
    current = key;
    buildFor(key);
    syncChart();
    syncStats();

    document.body.style.overflow = "hidden";
    root.hidden = false;

    // FLIP：从卡片矩形展开到最终位置
    const from = card.getBoundingClientRect();
    const to = els.panel.getBoundingClientRect();
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    // 先无过渡地摆到起始矩形，强制回流后再开过渡，滑向最终位置
    els.panel.style.transform =
      `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`;
    void els.panel.offsetWidth;
    els.panel.classList.add("anim");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        root.classList.add("open");
        els.panel.style.transform = "translate(0, 0) scale(1, 1)";
      }),
    );
    clearTimeout(animTimer);
    animTimer = setTimeout(() => els.panel.classList.remove("anim"), 540);

    els.close.focus({ preventScroll: true });
    onOpenChange(true);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    const card = document.querySelector(`.chart-panel[data-metric="${current}"]`);

    root.classList.remove("open"); // 遮罩先淡出
    if (card && !reduceMotion) {
      const from = card.getBoundingClientRect();
      const to = els.panel.getBoundingClientRect();
      els.panel.classList.add("anim");
      els.panel.style.transform =
        `translate(${from.left - to.left}px, ${from.top - to.top}px) ` +
        `scale(${from.width / to.width}, ${from.height / to.height})`;
    }

    clearTimeout(animTimer);
    animTimer = setTimeout(() => {
      root.hidden = true;
      els.panel.classList.remove("anim");
      els.panel.style.transform = "";
      document.body.style.overflow = "";
      if (chart) { chart.destroy(); chart = null; }
      current = null;
    }, card && !reduceMotion ? 470 : 0);

    onOpenChange(false);
  }

  els.close.addEventListener("click", close);
  els.scrim.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) close();
  });

  let onOpenChange = () => {};

  return {
    open,
    close,
    isOpen: () => isOpen,
    /** main.js 注入：打开/关闭时暂停/恢复 Overview 图表渲染 */
    setOnOpenChange(fn) { onOpenChange = fn; },
  };
}
