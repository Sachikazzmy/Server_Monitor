# Server Monitor — 采集 Agent 架构与实现原理（v0.1）

> 交付对象：后端（容器内）开发 Agent。本文档自包含，不依赖其他上下文。
> 代码位置：`agent_mac/`，运行方式：项目根目录执行 `python main.py`（venv：`.venv/`，Python 3.9.6，已装 fastapi/pydantic，**未装 uvicorn**）。
> 配置：`config.json`（首次运行自动生成，可手改）或 `AGENT_*` 环境变量；日志写入 `logs/agent.log`（1MB 轮转 ×3）+ stderr。
> 测试：`.venv/bin/python -m unittest discover -s tests -v`（标准库 unittest，8 例，无需额外安装）。
> 宿主机：macOS 26.6.2（Apple Silicon）。文中所有数据均为实机实测。
> **当前状态：阶段 1（健壮性加固）已完成**，阶段 2（FastAPI 控制面）未开工。

---

## 1. 项目目标与总原则

一套 **采集 Agent 与容器化后端分离** 的服务器信息采集系统：

- **Agent**（本项目，运行在宿主机）：采集本机指标 → 序列化 JSON → UDP 发给后端。后续嵌入 FastAPI 控制面，接受后端操控（暂停/恢复、开机自启、修改发送频率等）。
- **后端**（Docker 容器）：接收 UDP 指标并入库/展示，同时通过 HTTP 主动操控 Agent。

**核心分工原则（重要）**：

| 通道 | 协议 | 方向 | 特性要求 |
|---|---|---|---|
| 指标数据 | **UDP** | Agent → 后端 | 高频、允许丢失、fire-and-forget、低开销 |
| 控制指令 | **HTTP (FastAPI)** | 后端 → Agent | 低频、必须可靠到达、请求-响应式 |

即：**数据面走 UDP，控制面走 TCP/HTTP**。不要把控制指令放进 UDP——丢失一条"暂停"指令的后果不可接受，而 HTTP 天然给出成功/失败回执。

---

## 2. 当前架构（v0.1 已实现）

### 2.1 模块与数据流

```
┌──────────────────────── 宿主机 (macOS) ────────────────────────┐
│                                                                │
│  main.py（组装入口：配置 → 状态 → socket → 信号 → 进入循环）       │
│    │                                                           │
│    └─ src/loop.py::run_loop（固定节拍调度 + 单轮异常隔离）          │
│        │                                                       │
│        ├─① src/collector/top_data.py::catch_top(n)             │
│        │     subprocess.run: top -l 1 -o cpu -n 3              │
│        │                     -stats pid,command,cpu,mem        │
│        │     失败/超时(timeout=5s)返回 None，不中断循环           │
│        │                                                       │
│        ├─② src/parser/top_parse.py::parse_top_to_dict(text)    │
│        │     正则逐行匹配: Load Avg / CPU usage / PhysMem / 进程表│
│        │     返回 dict（内存统一 MB，进程字段为数字）               │
│        │                                                       │
│        └─③ src/transport/udp_sender.py::send_metrics(...)      │
│              v2 信封(agent_id/seq/ts) + 紧凑 JSON → sendto       │
│              │                                                 │
└──────────────┼─────────────────────────────────────────────────┘
               │ UDP :9999
┌──────────────▼──────────── Docker 容器（后端，待实现）────────────┐
│   UDP Listener :9999/udp  →  解析 → 存储/展示                    │
│   （后续）HTTP Client → host.docker.internal:8000 控制面         │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 模块职责

| 文件 | 职责 | 关键点 |
|---|---|---|
| `main.py` | 组装入口（不含业务逻辑） | 读配置→初始化日志→建 AgentState→建 socket→注册 SIGTERM/SIGINT→进入 run_loop |
| `src/config.py` | 配置 | 三级加载：默认值 → config.json → `AGENT_*` 环境变量；类型校验；首次运行自动生成 config.json |
| `src/state.py` | 运行时状态 | `AgentState`（dataclass + Lock）：interval/process_count/server/status/seq/packets_sent/send_errors/last_error；阶段 2 控制面的唯一读写入口 |
| `src/loop.py` | 调度 | `run_loop` 固定节拍（`time.monotonic`）、paused 判断、单轮 try/except；`setup_signal_handlers` 优雅退出 |
| `src/collector/top_data.py` | 采集层 | `top -l 1 ...`，timeout=5s、返回码/stderr 检查，失败返回 None |
| `src/parser/top_parse.py` | 解析层 | 返回 dict；`cpu.us` 已补齐；内存统一 MB（含 wired/compressor）；进程行校验 PID 为数字 + 表头重置 + 收满即止 |
| `src/transport/udp_sender.py` | 传输层 | v2 信封 + 紧凑 JSON + MTU(1400B) 防线 + seq 递增 + 发送统计 |

### 2.3 当前 UDP 负载格式（v2 信封，阶段 1 已落地）

每轮一包：v2 信封 + 紧凑 JSON（`separators=(",", ":")`），UTF-8 编码后直接作为 datagram 内容。以下为端到端实测收到的真实数据包（3 进程，515 字节）：

```json
{"v":1,"type":"metrics.top","agent_id":"MacdeMac-mini.local","seq":1,"ts":"2026-09-13T08:25:35.201979+00:00","interval_sec":1.0,"data":{"load_average":[2.99,2.93,2.55],"cpu":{"us":8.49,"sy":12.87,"id":78.63,"wa":0.0},"memory":{"total_mb":15427.0,"used_mb":15360.0,"free_mb":67.0,"wired_mb":2120.0,"compressor_mb":4328.0},"processes":[{"pid":26341,"command":"top","cpu_pct":0.0,"mem_mb":4.64}]}}
```

- 字段语义见第 4 节；实测包长 515–516 字节（3 进程），距 1400 字节 MTU 防线余量充足。
- v0 裸 JSON（`indent=4`、无信封、`_gb` 单位、字符串进程字段）已废弃。

### 2.4 端口与网络约定

| 端点 | 地址 | 说明 |
|---|---|---|
| Agent → 后端指标 | `127.0.0.1:9999/udp` | Docker Desktop 把发布端口绑在宿主机回环上，故 127.0.0.1 可达 |
| 后端接收 | `0.0.0.0:9999/udp`（容器内） | 需 `-p 9999:9999/udp` |
| 后端 → Agent 控制（规划） | `http://host.docker.internal:8000` | Docker Desktop (macOS) 自带该域名；Linux 需 `extra_hosts: host-gateway` |

---

## 3. Code Review 结论（2026-09，实测验证）

### 3.1 问题分级总表

> **修复状态（2026-09 阶段 1 已落地）**：#1–#6、#8–#11、#13 已修复；#7 已落地（`config.json` + `AGENT_*` 环境变量 + `AgentState`）；#14 大部分完成（logging 轮转、单元测试 8 例、requirements.txt、.gitignore 均已补，`main.py` 已无 import 副作用）；#12（真实内存总量）、#15（UDP 鉴权）、#16（Python 升级）留待阶段 2/3；#17 维持 `-l 1` 不变（解析器已兼容双采样，需要时可平滑切 `-l 2`）。

| # | 级别 | 位置 | 问题 | 实测证据 |
|---|---|---|---|---|
| 1 | **P0** | `main.py` | 主循环无异常隔离：`sendto`/`subprocess`/解析任一抛异常 → 整个 agent 退出（只捕获了 `KeyboardInterrupt`） | 代码审读 |
| 2 | **P0** | `top_data.py` | `subprocess.run` 无 `timeout`：top 一旦挂起，agent 永久卡死且无任何日志 | 代码审读 |
| 3 | **P0** | `main.py` | 无 SIGTERM 处理：被 launchd/`kill` 停止时默认处理器直接终止，`finally` 不执行 | 代码审读 |
| 4 | **P1** | `top_parse.py` | `user_match` 解析后**丢弃**——`cpu.user` 从未写入字典，后端拿不到 user CPU（骨架里根本没有 `us` 字段） | 实测输出确认缺失 |
| 5 | **P1** | `main.py` | 负载无 `agent_id`/`seq`/`ts`：多机部署无法区分来源；UDP 丢包/乱序/重复无法度量 | 设计审查 |
| 6 | **P1** | `main.py` | `indent=4` 序列化上网络：674B vs 320B，白白翻倍带宽 | 实测 |
| 7 | **P1** | 全部 | 配置硬编码（间隔 3s、目标地址、进程数 3）：与"修改传输效率"的控制面需求直接冲突 | 代码审读 |
| 8 | **P1** | `main.py` | `sleep(3)` 造成周期漂移：`top` 本身耗时 **0.372s**，实际周期 ≈3.37s，间隔越短漂移越显著 | 实测 |
| 9 | **P1** | `top_parse.py` | 进程字段全是字符串（`"864K"`、`"0.0"`、`"25592"`），后端必须二次解析 | 实测输出 |
| 10 | **P1** | `top_parse.py` | 表头识别后**所有**后续行都当进程行：若换 `-l 2`（双采样）或输出末尾追加内容，`Load Avg:`、`PhysMem:` 等表头行会被拼成垃圾"进程" | 实测：`{'PID': 'Load', 'COMMAND': 'Avg: 2.48,', ...}` |
| 11 | **P2** | `top_parse.py` | 解析层返回 JSON 字符串而非 dict：序列化是传输层职责，分层被打穿 | 设计审查 |
| 12 | **P2** | `top_parse.py` | `total_gb = used + unused` 是估算：wired/compressor 计入 used，真实总量应以 `sysctl -n hw.memsize` 为准 | 实测 15.14G ≠ 真实内存 |
| 13 | **P2** | `top_data.py` | 无返回码/stderr 检查：top 失败时返回空串，解析器返回 `"{}"`，**静默失败**与"真的没数据"无法区分 | 代码审读 |
| 14 | **P2** | 工程化 | 无日志（只有 print）、无测试、无 requirements.txt/pyproject、`.gitignore` 缺 `__pycache__/`；`main.py` 顶部全局建 socket（import 即有副作用） | 代码审读 |
| 15 | **P2** | 协议 | UDP 无鉴权：同网段任何人可向 9999 注入伪造指标 | 设计审查 |
| 16 | **P2** | 环境 | Python 3.9.6 已过 EOL（2025-10）；建议升级 3.11+；阶段 2 前需 `pip install uvicorn` 并固化依赖 | 环境检查 |
| 17 | **P2** | `top_data.py` | `top -l 1` 首采样精度是 macOS 经典坑（历史上首采样为开机以来均值）；本机实测值合理，但若后端要做曲线分析，建议 `-l 2 -s 1` 取第二段（成本：约 +1s） | 实测两采样差值正常 |

### 3.2 关键修复片段（按问题号对应）

**#1/#3/#8 — 主循环：异常隔离 + 单调时钟调度 + 优雅退出**

```python
import signal, threading, time

def run_loop(state, stop_event):
    next_tick = time.monotonic()
    while not stop_event.is_set():
        next_tick += state.interval_sec          # #8 固定节拍，消除漂移
        if state.status == "running":            # #7 控制面可改的共享状态
            try:                                 # #1 单轮失败不致命
                collect_and_send(state)
            except Exception:
                state.send_errors += 1
                logging.exception("collect/send failed")   # #14 计数+日志，不刷屏
        stop_event.wait(max(0.0, next_tick - time.monotonic()))

# main 里：
stop_event = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop_event.set())   # #3 launchd/kill 优雅退出
signal.signal(signal.SIGINT,  lambda *_: stop_event.set())
```

**#2/#13 — 采集层：超时 + 返回码检查**

```python
try:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
except subprocess.TimeoutExpired:
    logging.error("top timed out"); return None          # 与"正常无数据"区分
if r.returncode != 0:
    logging.error("top failed: %s", r.stderr.strip()[:200]); return None
return r.stdout
```

**#4/#9/#10 — 解析层三处修正**

```python
data_dict["cpu"]["us"] = float(user_match.group(1)) if user_match else 0.0  # #4 补 user

# #10 只取表头后 N 行，且 PID 必须为纯数字（天然免疫表头/尾部杂行）
if process_start and proc_values[0].isdigit() \
        and len(data_dict["processes"]) < expected_procs:
    ...

# #9 数值归一化："864K"→0.84，"4720K"→4.61，"2G"→2048（单位统一 MB）
def mem_to_mb(token):
    m = re.fullmatch(r"(\d+)([KMG])", token)
    mult = {"K": 1/1024, "M": 1, "G": 1024}
    return round(int(m.group(1)) * mult[m.group(2)], 2) if m else 0.0
```

**#5/#6/#11 — 传输层：v2 信封 + 紧凑序列化（详见第 4 节）**

```python
packet = {
    "v": 1, "type": "metrics.top",
    "agent_id": socket.gethostname(),          # 多机区分
    "seq": next_seq(state),                    # 后端据此算丢包率
    "ts": datetime.now(timezone.utc).isoformat(),
    "interval_sec": state.interval_sec,
    "data": metrics,                           # #11 解析层改为返回 dict
}
payload = json.dumps(packet, separators=(",", ":"), ensure_ascii=False).encode()
if len(payload) > 1400:                        # MTU 防线，避免 IP 分片
    logging.warning("payload %dB > MTU", len(payload))
sock.sendto(payload, state.server)
```

---

## 4. 数据协议 v2（建议后端按此实现）

信封与业务数据分离，`data` 内容即第 2.3 节骨架（修正后含 `cpu.us`、数值型进程字段）：

```json
{
  "v": 1,
  "type": "metrics.top",
  "agent_id": "mac-studio.local",
  "seq": 1042,
  "ts": "2026-09-13T15:57:45.123Z",
  "interval_sec": 3,
  "data": {
    "load_average": [2.5, 2.3, 2.11],
    "cpu": { "us": 9.6, "sy": 12.63, "id": 78.29, "wa": 0.0 },
    "memory": { "total_mb": 15872, "used_mb": 15360, "free_mb": 146, "wired_mb": 2046, "compressor_mb": 4286 },
    "processes": [
      { "pid": 25592, "command": "head", "cpu_pct": 0.0, "mem_mb": 0.84 }
    ]
  }
}
```

约定：

- `v` 协议版本，后端遇到不认识的 `v` 丢弃并计数，不做猜测解析。
- `type` 预留多采集器（未来 `metrics.disks`、`metrics.net` 等）。
- `seq` 单调递增（重启归零，可用 `ts` 区分），后端按 `agent_id` 维护窗口计算丢包率/乱序。
- 单包保持 **< 1400 字节**（一个 MTU，避免分片；UDP 理论上限 65507B 但分片丢包代价是整包）。当前 3 进程约 320B，余量充足；进程数调大或指标扩展时优先减小 `process_count`，仍超限再考虑分批发送。
- 鉴权（阶段 3，可选）：包内加 8 字节随机 `nonce` + 后端预共享 token 的 HMAC-SHA256 截断签名字段，防同网段伪造。

**兼容策略**：v0 裸 JSON 从未交付过任何后端，已随阶段 1 废弃；后端只需实现 v2，遇到 `v` 不为 1 的包丢弃并计数即可。

---

## 5. 演进路线

### 阶段 1：健壮性加固（✅ 2026-09 已完成）

落地情况：主循环异常隔离与固定节拍调度、采集超时与返回码检查、SIGTERM 优雅退出、v2 信封与紧凑序列化、`cpu.us` 补齐、MB 数值归一化、进程行校验、三级配置加载、`AgentState` 共享状态、logging 轮转日志、unittest 单元测试 8 例（标准库，零额外依赖）。端到端实测通过：agent → UDP 接收端收包正常 → SIGTERM 优雅退出并输出统计。

以下为当时的实施清单（均已落地）：

1. 落地 3.2 节全部修复（异常隔离、timeout、SIGTERM、单调调度、补 `cpu.us`、数值归一化、进程行校验、紧凑序列化、v2 信封）。
2. 引入 `logging`（`RotatingFileHandler` 落盘 + stderr），替换 print。
3. 抽出 `src/config.py`：`RuntimeConfig`（interval_sec / process_count / server / log_level），**加载顺序：默认值 → config.json → 环境变量覆盖**（`AGENT_INTERVAL_SEC` 等）；变更时写回 config.json 持久化。
4. 抽出 `AgentState`（共享可变状态 + `threading.Lock`）：status、interval、seq、packets_sent、send_errors、last_error——这就是阶段 2 控制面要读写的唯一入口。
5. 补测试：用标准库 unittest（零额外依赖）实现 `tests/test_top_parse.py`，fixtures 为真实 top 输出样本，覆盖：正常样本、空输出、双采样表头杂行、带空格命令名、收满即止、K/M/G 单位，共 8 例。

### 阶段 2：FastAPI 控制面（嵌入 agent 进程）

**线程模型**——采集与控制同进程、双线程：

```
main.py
 ├─ Thread A: run_loop()            采集循环（阶段1改造后）
 ├─ Thread B: uvicorn.run(app)      控制面 HTTP :8000
 └─ 共享 AgentState（Lock 保护）      ← 控制面写配置，采集循环节拍级感知
```

uvicorn 以非 reload 模式跑在 daemon 线程是官方支持用法。**不要**让 FastAPI 直接持有 socket/子进程，一切经 `AgentState` 中转。

**路由表（建议实现）**：

| Method | Path | 作用 | 校验/约束 |
|---|---|---|---|
| GET | `/healthz` | 存活探针（后端判 agent 死活） | 无鉴权，仅返回 200 |
| GET | `/status` | status、uptime、seq、packets_sent、send_errors、last_error、当前配置 | Token |
| POST | `/collect/pause` | 暂停采集（status→paused） | Token；幂等 |
| POST | `/collect/resume` | 恢复采集 | Token；幂等 |
| POST | `/collect/trigger` | 立即采集并发送一轮 | Token；并发调用合并 |
| PUT | `/config` | 修改 interval_sec / process_count / server | Token；pydantic 约束 `interval 1~3600s`、`process_count 1~20`；写回 config.json |
| POST | `/shutdown` | 优雅退出 agent | Token；需二次确认参数 `confirm=true` |
| POST | `/autostart` | 注册/注销 launchd 自启 | Token；见下 |

**鉴权**：固定 `X-Agent-Token` 头比对共享密钥（首次由人工部署时写入 config.json，不落入代码仓库）。默认监听 `127.0.0.1:8000`；因后端在容器里，需改绑 `0.0.0.0:8000` 并**强制要求 token**。后续可升级为 token + 时间戳 + HMAC 防重放。

**"开机自启"的实现要点**（macOS = launchd，不是 agent 自身能力）：

- `POST /autostart {"enabled": true}` 通过 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.servermonitor.agent.plist` 注册，`bootout` 注销；plist 使用 `RunAtLoad=true` + `KeepAlive=true`（崩溃自动拉起，与 P0#3 的优雅退出配合）。
- 安全提示：此接口让 agent 获得持久化能力，务必 token 保护；更稳妥的替代方案是部署时人工安装 plist，接口只做状态查询与启停（`launchctl kickstart/kickstart -k`）。
- Linux 服务器对应物是 systemd unit（`systemctl enable --now`），采集器抽象做好后同一套路由表可复用。

### 阶段 3：可选增强（按需）

- **psutil 采集器**：`top` 解析天生 macOS 专属（`-l/-stats` 是 BSD top 参数，Linux 是 `top -b -n1` 且格式不同）。若要泛化到 Linux 服务器，定义 `Collector` 协议（`collect() -> dict`），`TopCollector` 与 `PsutilCollector` 各实现一份，psutil 跨平台且免解析，精度更高。
- **扩展指标**：top 头部的 `Disks:` / `Networks:` 行可顺带解析为 `metrics.disks` / `metrics.net`；内存细分（wired/compressor）与真实总量（`sysctl -n hw.memsize`）建议补齐。
- **心跳/注册**：agent 启动时向后端 HTTP 注册（上报 agent_id、版本、能力列表），后端据此维护在线表，UDP 只走纯数据。
- **HMAC 防伪造**（见第 4 节）。

---

## 6. 后端（容器内）需要实现的内容

1. **UDP 接收器**（独立线程/asyncio task，与 FastAPI 主服务共存）：

```python
# asyncio 版最小骨架
class MetricsProtocol(asyncio.DatagramProtocol):
    def datagram_received(self, data, addr):
        try:
            packet = json.loads(data)
            store(packet)          # 校验 v/type → 按 agent_id+seq 入库、更新丢包统计
        except Exception:
            metrics_invalid_total.inc()

loop.create_datagram_endpoint(MetricsProtocol, local_addr=("0.0.0.0", 9999))
```

2. **docker-compose（示意）**：

```yaml
services:
  backend:
    build: ./backend
    ports:
      - "9999:9999/udp"    # 接收 agent 指标（注意 /udp）
    extra_hosts:
      - "host.docker.internal:host-gateway"   # Linux 需要；macOS Docker Desktop 自带
```

3. **控制面客户端**：调用 `http://host.docker.internal:8000`（路由表见 5.2），携带 `X-Agent-Token`；用 `/healthz` 做在线监测，`/status` 的 send_errors/丢包率做数据质量面板。
4. **v0/v2 双格式兼容**（第 4 节）与按 `agent_id` 的丢包率统计（`seq` 缺口）。

## 7. 已知限制（给后端的预期管理）

- 单机单 agent 假设；`agent_id` 用主机名，重名需人工区分。
- UDP 尽力而为：本地回环几乎不丢，跨网段需接受秒级曲线缺口；不要用指标做计费类精确账务。
- `-l 1` 首采样精度历史坑（3.1 #17）：本机实测正常，若后端发现 CPU 曲线异常平滑/失真，先切 `-l 2 -s 1`。
- `top` 进程快照只有瞬时值，`%CPU` 是采样区间均值，3s 粒度下足够看趋势。
- 依赖已固化到 `requirements.txt`（fastapi 0.128.8 + pydantic 2.13.5 等）；**uvicorn 仍未装**，阶段 2 开工前 `pip install "uvicorn[standard]"`。当前 venv 为 Python 3.9.6（已过 EOL，2025-10），建议择机升级 3.11+。

## 8. 当前目录结构（阶段 1 已落地）

```
agent_mac/
├── main.py                       # 组装入口：配置 → 日志 → 状态 → socket → 信号 → 循环
├── config.json                   # 运行配置（首次运行自动生成，可手改；环境变量优先级更高）
├── requirements.txt              # 依赖清单（pip freeze；uvicorn 留待阶段 2 安装）
├── src/
│   ├── config.py                 # 配置加载/保存（默认值 → config.json → 环境变量）
│   ├── state.py                  # AgentState：线程安全的共享运行状态（阶段 2 控制面读写入口）
│   ├── loop.py                   # 采集循环（固定节拍 + 异常隔离）+ 信号处理
│   ├── collector/top_data.py     # 采集层：top 命令封装（timeout/返回码检查）
│   ├── parser/top_parse.py       # 解析层：返回 dict，数值归一化（MB/浮点）
│   └── transport/udp_sender.py   # 传输层：v2 信封 + 紧凑 JSON + sendto
├── tests/
│   ├── fixtures/                 # 真实 top 输出样本（l1 / l2 双采样）
│   └── test_top_parse.py         # 解析层单元测试（unittest，8 例）
└── docs/ARCHITECTURE.md          # 本文档
```
