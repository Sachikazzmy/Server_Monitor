/*
 * store.js — 前端数据仓库。完全适配现有 API（GET /api/metrics/today）。
 *
 * 数据流：poller 拿到 records → applyRecords 追加到这里 → 订阅者（图表/视图）刷新。
 * 保留最近 MAX_SAMPLES 个采样（默认约 3.3 小时 @10s 节奏）：
 *   - Overview 图表只取最近一小段窗口；
 *   - Focus View 用整段历史，时间轴更长。
 */

export const MAX_SAMPLES = 1200;

const state = {
  times: [],              // epoch ms，升序
  cpu: { us: [], sy: [], id: [], wa: [], busy: [] },       // busy = us+sy+wa（派生）
  mem: { used: [], free: [], wired: [], compressor: [] },
  load: { l1: [], l5: [], l15: [] },
  totalMem: null,         // latest memory.total_mb
  latest: null,           // 最新一条原始 record
  agentId: "",
  seq: null,
  packets: 0,             // 本次会话累计收到的包数
  cadenceSec: null,       // agent 上报的采集间隔
  lastPacketAt: 0,        // Date.now()，收到最后一批数据的本地时刻
  empty: true,
};

const subs = new Set();

export function getStore() {
  return state;
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function push(arr, v) {
  arr.push(v == null ? null : v);
}

/**
 * 追加一批记录；rolledOver 为 true 时先清空（跨天文件滚动）。
 * 通知订阅者 { appended, reset }。
 */
export function applyRecords(records, { reset = false } = {}) {
  if (reset) resetStore();
  if (!records.length) {
    // 跨天滚动但还没有新数据：也要通知一次，让图表立刻清空
    if (reset) for (const fn of subs) fn({ appended: 0, reset: true });
    return;
  }

  for (const r of records) {
    const d = r.data || {};
    const c = d.cpu || {};
    const m = d.memory || {};
    const la = d.load_average || [];

    state.times.push(Date.parse(r.ts));
    push(state.cpu.us, c.us); push(state.cpu.sy, c.sy);
    push(state.cpu.id, c.id); push(state.cpu.wa, c.wa);
    push(state.cpu.busy, (c.us ?? 0) + (c.sy ?? 0) + (c.wa ?? 0));
    push(state.mem.used, m.used_mb); push(state.mem.free, m.free_mb);
    push(state.mem.wired, m.wired_mb); push(state.mem.compressor, m.compressor_mb);
    push(state.load.l1, la[0]); push(state.load.l5, la[1]); push(state.load.l15, la[2]);

    state.latest = r;
    if (m.total_mb != null) state.totalMem = m.total_mb;
    if (r.interval_sec) state.cadenceSec = r.interval_sec;
  }

  state.agentId = state.latest.agent_id || "";
  state.seq = state.latest.seq;
  state.packets += records.length;
  state.lastPacketAt = Date.now();
  state.empty = false;

  // 只保留最近 MAX_SAMPLES 个点，多余的老点从头部裁掉
  const over = state.times.length - MAX_SAMPLES;
  if (over > 0) {
    state.times.splice(0, over);
    for (const key of ["us", "sy", "id", "wa", "busy"]) state.cpu[key].splice(0, over);
    for (const key of ["used", "free", "wired", "compressor"]) state.mem[key].splice(0, over);
    for (const key of ["l1", "l5", "l15"]) state.load[key].splice(0, over);
  }

  for (const fn of subs) fn({ appended: records.length, reset });
}

/** 跨天滚动：清空全部曲线，等全量数据重新灌入 */
export function resetStore() {
  state.times.length = 0;
  for (const key of ["us", "sy", "id", "wa", "busy"]) state.cpu[key].length = 0;
  for (const key of ["used", "free", "wired", "compressor"]) state.mem[key].length = 0;
  for (const key of ["l1", "l5", "l15"]) state.load[key].length = 0;
  state.latest = null;
  state.seq = null;
  state.packets = 0;
  state.empty = true;
}

/** 便捷读取：metricKey('cpu'|'memory'|'load') → 该指标的数据对象 */
export function metricData(key) {
  return key === "cpu" ? state.cpu : key === "memory" ? state.mem : state.load;
}
