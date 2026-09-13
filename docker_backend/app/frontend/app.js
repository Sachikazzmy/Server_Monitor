/*
 * app.js — Server Monitor 图表页逻辑。
 *
 * 数据流：
 *   1. 打开页面：不带 offset 请求一次 /api/metrics/today，今天已有的数据一次画齐；
 *   2. 之后每隔 POLL_INTERVAL_MS 带上后端返回的 offset 增量轮询；
 *   3. 新数据点直接 push 进已成型的曲线，由 ECharts 补间出滑入动画，不重建图表。
 */

// ===== 常量 =====

const POLL_INTERVAL_MS = 2000;  // 轮询周期（agent 每 3 秒发一包，2 秒轮询不会漏包）
const MAX_POINTS = 240;         // 每条曲线最多保留的点数（约 12 分钟），满了旧点滑出
const ANIM_MS = 700;            // 增量更新时新点滑入的动画时长

// 三张曲线图的定义：source 指向 extractPoints() 里对应的数值来源
const CHART_DEFS = {
  cpu: {
    dom: "chart-cpu", source: "cpu", yMax: 100,
    palette: ["#4dd0b1", "#f6c85f", "#6c8cff", "#f2708a"],
    series: [["us", "用户"], ["sy", "系统"], ["id", "空闲"], ["wa", "IO 等待"]],
  },
  memory: {
    dom: "chart-memory", source: "memory", yMax: null,
    palette: ["#6c8cff", "#4dd0b1", "#f6c85f", "#b07cff"],
    series: [["used_mb", "已用"], ["free_mb", "可用"], ["wired_mb", "联动"], ["compressor_mb", "压缩"]],
  },
  load: {
    dom: "chart-load", source: "load", yMax: null,
    palette: ["#4dd0b1", "#f6c85f", "#f2708a"],
    series: [["l1", "1 分钟"], ["l5", "5 分钟"], ["l15", "15 分钟"]],
  },
};

// ===== 全局状态 =====

let byteOffset = 0;             // 下次轮询的文件字节位置（由后端返回）
const entries = {};             // 图表键 → { chart, def, times, values }
let knownPids = new Set();      // 出现过的进程 PID，用于给表格新行加入场动画

// ===== 曲线图 =====

function makeOption(def) {
  const series = def.series.map((pair) => ({
    name: pair[1],
    type: "line",
    smooth: true,
    showSymbol: false,
    lineStyle: { width: 2 },
    emphasis: { focus: "series" },
  }));

  return {
    color: def.palette,
    animationDuration: 1200,
    animationDurationUpdate: ANIM_MS,
    animationEasingUpdate: "linear",
    tooltip: { trigger: "axis", backgroundColor: "#1d2433", borderColor: "#2a3347", textStyle: { color: "#dfe7f2" } },
    legend: { top: 0, right: 0, icon: "roundRect", itemWidth: 14, itemHeight: 4, textStyle: { color: "#8b98ab" } },
    grid: { left: 48, right: 14, top: 30, bottom: 24 },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: [],
      axisLine: { lineStyle: { color: "#2a3347" } },
      axisLabel: { color: "#8b98ab" },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: def.yMax,
      splitLine: { lineStyle: { color: "#202939", type: "dashed" } },
      axisLabel: { color: "#8b98ab" },
    },
    series: series,
  };
}

function initCharts() {
  for (const key of Object.keys(CHART_DEFS)) {
    const def = CHART_DEFS[key];
    const chart = echarts.init(document.getElementById(def.dom));
    chart.setOption(makeOption(def));

    const values = {};
    for (const pair of def.series) values[pair[0]] = [];

    entries[key] = { chart: chart, def: def, times: [], values: values };
  }

  window.addEventListener("resize", resizeAllCharts);
}

function resizeAllCharts() {
  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    entry.chart.resize();
  }
}

// 把一批记录抽出为曲线数据：公共横轴 + 各图自己的数值行
function extractPoints(records) {
  return {
    times: records.map((r) => formatTime(r.ts)),
    cpu: records.map((r) => r.data.cpu),
    memory: records.map((r) => r.data.memory),
    load: records.map((r) => ({
      l1: r.data.load_average[0],
      l5: r.data.load_average[1],
      l15: r.data.load_average[2],
    })),
  };
}

function appendAll(points) {
  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    const rows = points[entry.def.source];

    entry.times.push(...points.times);
    for (const pair of entry.def.series) {
      const field = pair[0];
      entry.values[field].push(...rows.map((row) => (row[field] == null ? null : row[field])));
    }

    // 窗口满了：最旧的点滑出，曲线整体左移，保持流动感
    const overflow = entry.times.length - MAX_POINTS;
    if (overflow > 0) {
      entry.times.splice(0, overflow);
      for (const pair of entry.def.series) entry.values[pair[0]].splice(0, overflow);
    }

    // 只更新数据，不重建图表：setOption 合并后由 ECharts 补间出滑入动画
    entry.chart.setOption({
      xAxis: { data: entry.times },
      series: entry.def.series.map((pair) => ({ data: entry.values[pair[0]] })),
    });
  }
}

// 文件跨天滚动后调用：清空所有曲线与表格，等本次全量数据重新成型
function resetCharts() {
  knownPids.clear();

  for (const key of Object.keys(entries)) {
    const entry = entries[key];
    entry.times.length = 0;
    for (const pair of entry.def.series) entry.values[pair[0]].length = 0;

    entry.chart.setOption({
      xAxis: { data: [] },
      series: entry.def.series.map((pair) => ({ data: [] })),
    });
  }

  document.getElementById("process-body").innerHTML = "";
}

// ===== 进程三线表 =====

function byCpuThenMem(a, b) {
  return (b.cpu_pct - a.cpu_pct) || (b.mem_mb - a.mem_mb);
}

function escapeHtml(text) {
  const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text).replace(/[&<>"']/g, (ch) => escapes[ch]);
}

function renderRow(proc) {
  const isNew = !knownPids.has(proc.pid);
  knownPids.add(proc.pid);

  const rowClass = isNew ? ' class="row-new"' : "";
  const barPct = Math.min(100, proc.cpu_pct).toFixed(1);
  // CPU 列用一条浅色渐变条做背景，宽度即占用率，数字保持可读
  const barTint = `linear-gradient(90deg, rgba(77,208,177,.22) ${barPct}%, transparent ${barPct}%)`;

  return `<tr${rowClass}>
    <td class="num">${proc.pid}</td>
    <td class="cmd">${escapeHtml(proc.command)}</td>
    <td class="num" style="background:${barTint}">${proc.cpu_pct.toFixed(2)}</td>
    <td class="num">${proc.mem_mb.toFixed(2)}</td>
  </tr>`;
}

function renderProcessTable(record) {
  const procs = record.data.processes.slice().sort(byCpuThenMem);
  document.getElementById("process-body").innerHTML = procs.map(renderRow).join("");
}

// ===== 页眉与轮询 =====

function formatTime(isoText) {
  return new Date(isoText).toLocaleTimeString("zh-CN", { hour12: false });
}

function updateHeader(record) {
  document.getElementById("agent-id").textContent = record.agent_id;
  document.getElementById("last-packet").textContent = "最新数据 " + formatTime(record.received_at);
}

function setLive(ok) {
  document.getElementById("live-dot").classList.toggle("off", !ok);
  document.getElementById("live-text").textContent = ok ? "实时" : "重连中";
}

function startClock() {
  const clock = document.getElementById("clock");
  const tick = () => { clock.textContent = formatTime(new Date().toISOString()); };
  tick();
  setInterval(tick, 1000);
}

async function fetchAndApply() {
  const response = await fetch("/api/metrics/today?offset=" + byteOffset);
  if (!response.ok) throw new Error("HTTP " + response.status);

  const payload = await response.json();
  byteOffset = payload.offset;

  if (payload.rolled_over) resetCharts();
  if (payload.records.length > 0) applyRecords(payload.records);
}

function applyRecords(records) {
  appendAll(extractPoints(records));
  const latest = records[records.length - 1];
  renderProcessTable(latest);
  updateHeader(latest);
}

async function pollOnce() {
  try {
    await fetchAndApply();
    setLive(true);
  } catch (err) {
    setLive(false);
  }
}

async function main() {
  initCharts();
  startClock();
  await pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

main();
