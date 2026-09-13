# Server Monitor — 容器后端架构与交接文档（v0.1）

> 交付对象：后续接手后端开发的人 / Agent。本文档自包含，不依赖其他上下文。
> 代码位置：`docker_backend/`。
> 运行方式（两个独立进程，均在本目录执行；venv：`.venv/`，Python 3.9.6，已装 fastapi/pydantic/uvicorn）：
> ① 接收器 `python udp_server.py`；② 展示面 `.venv/bin/uvicorn app.main:app --port 8000`，浏览器访问 `/charts`。
> 测试：`.venv/bin/python -m unittest discover -s tests -v`（标准库 unittest，13 例，无需额外安装）。
> 上游数据源：`../agent_mac/docs/ARCHITECTURE.md`（协议 v2 的权威定义在该文档第 4 节）。
> **当前状态：阶段 1（UDP 接收 ➡️ 校验 ➡️ JSONL 存储）与阶段 2 图表展示页均已完成并实测联调通过**；阶段 3（控制面等增强）未开工。
> Dockerfile / GitHub Actions 由项目负责人自行维护，本文不覆盖。

---

## 1. 项目目标与后端定位

整套系统是 **采集 Agent 与容器化后端分离** 的服务器信息采集系统，后端负责总目标的三步：

```
接收（UDP） ➡️ 存储（无数据库，JSONL 文件） ➡️ 展示（阶段 2：FastAPI + 前端）
```

通道分工（与 agent 端文档第 1 节一致，这里是后端视角）：

| 通道 | 协议 | 方向 | 后端要做的事 |
|---|---|---|---|
| 指标数据 | **UDP :9999** | Agent → 后端 | 监听、校验、落盘、丢包统计（阶段 1 ✅） |
| 控制指令 | **HTTP** | 后端 → Agent | FastAPI 发起对 agent 的操控（远期，agent 端阶段 2 之后） |

## 2. 当前实现（阶段 1）：`udp_server.py`

### 2.1 数据流

```
agent_mac（宿主机，每 interval 秒一包）
   │  UDP :9999  v2 信封 + 紧凑 JSON（单包 < 1400B）
   ▼
udp_server.py（容器内 / 本机均可跑）
   │  recvfrom（缓冲区 65536，杜绝截断）
   ├─ json.loads → validate_packet（v/type/agent_id/seq/data 五项校验）
   │       └─ 不合法 → 计数 + WARNING 日志，丢弃，服务不受影响
   ├─ update_seq_stats（按 agent_id 跟踪 seq → 估算丢包 / 重启）
   └─ store_packet → data/metrics-YYYYMMDD.jsonl（每天一个文件，追加写）
   │
   └─ 退出（Ctrl+C / SIGTERM）→ 打印统计摘要 → 关闭 socket
```

### 2.2 运行方式与配置

```bash
# 本机调试（agent 发往 127.0.0.1:9999）
BACKEND_UDP_HOST=127.0.0.1 python udp_server.py

# 容器内（默认值即容器场景）
python udp_server.py
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `BACKEND_UDP_HOST` | `0.0.0.0` | 监听地址。**容器内必须 0.0.0.0**，绑 127.0.0.1 收不到端口映射进来的包 |
| `BACKEND_UDP_PORT` | `9999` | 监听端口，与 agent 的 `server_port` 对应 |
| `BACKEND_DATA_DIR` | `./data` | 指标数据目录（JSONL），容器里务必挂 volume |

运行日志固定写 `logs/backend.log`（相对当前目录，1MB 轮转 ×3 + stderr），与 agent 端日志约定一致。

### 2.3 模块内部分区（单文件，五段式）

代码按注释分隔线分成五段，每段只有平铺的模块级函数，无嵌套 def、无闭包：

| 分区 | 内容 | 关键函数 |
|---|---|---|
| 常量 | 缓冲区 / 协议字段 / 日志参数 / `STOP` 开关 | — |
| 配置与日志 | 环境变量加载、logging 初始化、信号处理 | `load_config_from_env` `setup_logging` `request_stop` |
| 包校验与统计 | v2 信封校验、丢包估算 | `validate_packet` `update_seq_stats` |
| 存储 | JSONL 追加写、单包处理总入口 | `store_packet` `handle_datagram` |
| 主流程 | 统计摘要、组装与主循环 | `log_summary` `main` |

设计上刻意保证：**`import udp_server` 没有任何副作用**（不建 socket、不占端口、不建目录），所以它能被单元测试和将来的 FastAPI 直接 import 复用。

## 3. 存储设计（当前不使用数据库）

### 3.1 为什么是 JSONL

- 每行一个独立 JSON 对象、带时间戳，文本编辑器 / `grep` / `jq` 直接可查，初学者友好；
- 追加写（`"a"` 模式）性能好、不怕崩溃丢数据，不需要任何额外依赖；
- **迁移数据库时一行就是一条记录**，字段已经拍平到顶层，导入成本极低；
- 接收器只写、将来的 API 只读，**通过文件解耦**，单线程写无需加锁——这是文件存储在当前阶段的最大好处。

### 3.2 文件与行格式

文件：`data/metrics-YYYYMMDD.jsonl`，按**接收当天（本地时区）**滚动，方便直接翻到某天。
行内 `received_at` 用 **UTC ISO 时间戳**，与 agent 发来的 `ts` 时区一致。

真实联调落盘的行（原样示例，3 进程包）：

```json
{"v":1,"type":"metrics.top","agent_id":"MacdeMac-mini.local","seq":1,"ts":"2026-09-13T08:59:50.355512+00:00","interval_sec":3.0,"data":{"load_average":[3.79,3.29,2.74],"cpu":{"us":16.32,"sy":18.11,"id":65.56,"wa":0.0},"memory":{"total_mb":15575.0,"used_mb":14336.0,"free_mb":1239.0,"wired_mb":2628.0,"compressor_mb":5650.0},"processes":[{"pid":28056,"command":"top","cpu_pct":0.0,"mem_mb":4.66}]},"received_at":"2026-09-13T08:59:50.356276+00:00","sender":"127.0.0.1:51264"}
```

| 字段 | 来源 | 含义 |
|---|---|---|
| `v` / `type` / `agent_id` / `seq` / `ts` / `interval_sec` | agent 信封 | 协议 v2 元数据，语义见 agent 文档第 4 节 |
| `data` | agent 采集 | `load_average` / `cpu`(us,sy,id,wa) / `memory`(MB) / `processes` |
| `received_at` | 后端补 | 后端收到的时间（UTC）；与 `ts` 相减 ≈ 传输延迟 |
| `sender` | 后端补 | 发送方 `IP:端口`（UDP 无连接，每次可能变，仅参考） |

> **内存字段语义（2026-09 修正）**：`total_mb` 是真实物理内存（agent 经 `sysctl hw.memsize` 查询），`used_mb = total_mb − unused`，M 粒度。早期版本照抄 top 的 used，但 top 的 PhysMem 行里 used 只有 G 粒度（如 "15G used"），会让图表里「已用」变成一条恒定平线。上行示例是修正前的真实记录，仅作行格式参考；详见 agent 文档第 4 节约定。

### 3.3 常用查询

```bash
# 看某 agent 今天的全部记录
grep '"agent_id":"MacdeMac-mini.local"' data/metrics-$(date +%Y%m%d).jsonl

# 用 jq 只取 CPU 占用率序列（画曲线就是它）
jq -c '[.received_at, .data.cpu.us, .data.cpu.sy]' data/metrics-20260913.jsonl

# 数一数今天存了多少行
wc -l data/metrics-20260913.jsonl
```

### 3.4 ⚠️ Docker 部署必须注意

数据写在容器文件系统里，**容器一删除数据就没了**。compose 里必须挂 volume（示意，Dockerfile 由项目负责人维护）：

```yaml
services:
  backend:
    ports:
      - "9999:9999/udp"        # 注意 /udp，漏写会静默不通
    volumes:
      - ./data:/app/data       # JSONL 数据持久化到宿主机
      - ./logs:/app/logs       # 运行日志持久化（可选）
    environment:
      BACKEND_UDP_HOST: 0.0.0.0
      BACKEND_DATA_DIR: /app/data
```

`data/`、`logs/` 已加入 `.gitignore`，运行产物不入库。

## 4. Code Review 结论（2026-09，针对旧版 udp_server.py）

旧版共 38 行：顶层 bind + `while True` + `recvfrom(1024)` + print。问题按级别列出，**全部已在重写中修复**：

| # | 级别 | 问题 | 后果 | 修复方式 |
|---|---|---|---|---|
| 1 | **P0** | `recvfrom(1024)` 缓冲区小于协议包上限 | 协议允许单包 1400B（agent 进程数可调大）；包一超 1024B 数据报被操作系统**静默截断**，JSON 必然解析失败且无任何报错 | 缓冲区 65536（UDP 数据报理论上限），一次到位 |
| 2 | **P0** | 只 print 不存储 | 总目标「接收➡️存储➡️展示」的存储环节缺失，进程一退数据全没 | JSONL 按天落盘 `data/`（第 3 节） |
| 3 | **P0** | 无 SIGTERM 处理 | `docker stop` / `kill` 直接杀进程；agent 端 P0#3 同款问题 | 信号只置 `STOP` 开关 + socket 1 秒超时轮询，退出前打印摘要 |
| 4 | **P1** | 绑定 `127.0.0.1` 且写死 | 容器内收不到端口映射进来的包（只能收容器自己的流量）；本地/容器两场景无法切换 | 默认 `0.0.0.0`，环境变量可覆盖 |
| 5 | **P1** | 不校验 v2 信封 | 任何 JSON 都照单全收，坏数据/陌生版本混进存储；违背协议「不认识的 v 丢弃并计数」约定 | `validate_packet` 五项校验，非法丢弃 + 计数 + 带原因的 WARNING |
| 6 | **P1** | 忽略 `agent_id`/`seq` | 多机无法区分来源，丢包无法度量（协议专门设计这两个字段给后端） | `update_seq_stats` 按 agent 统计丢包/重启，退出时汇总 |
| 7 | **P1** | 主循环无异常隔离 | 单包处理抛异常（如磁盘写满）整个服务退出；agent 端 P0#1 同款教训 | 单包 try/except，计数 + 日志，服务继续 |
| 8 | **P1** | 顶层代码直接 bind（import 即副作用） | 模块无法被测试 import，也无法被将来的 FastAPI 复用（一 import 就抢端口） | 全部逻辑收进 `main()`，`import udp_server` 零副作用 |
| 9 | **P2** | 无文件日志 | 容器重启后 docker logs 丢失，无法排障 | `RotatingFileHandler` 1MB×3 落盘 + stderr |
| 10 | **P2** | `import json` 散在文件中间 | 可读性差 | import 集中顶部 |
| 11 | **P2** | 退出无统计摘要 | 收了多少 / 丢了多少 / 谁在发，无从知晓 | `log_summary`：收包/存盘/丢弃/出错 + 每 agent 的 seq 状态 |

## 5. 验证记录（2026-09 实测）

1. **单元测试 13 例全过**（`.venv/bin/python -m unittest discover -s tests -v`）：校验 6 例（含 bool 冒充 seq）、丢包统计 5 例（基线/连续/跳号/重启/多 agent 隔离）、落盘 2 例（行格式合法、追加不覆盖）。全部零网络、零额外依赖。
2. **模拟包端到端**：发 seq 1/2/5 三个合法包 + 一个 `v=99` 坏包 + 一段非 UTF-8 垃圾。结果：3 行落盘（带 `received_at`/`sender`），坏包按原因分别拒绝（累计 2），seq 缺口记「丢包 2」，SIGTERM 后 1 秒内优雅退出并打印摘要。
3. **真机联调**：启动接收器后在 `agent_mac/` 真跑 `python main.py`（interval 3s）。8 秒收到真实 agent `MacdeMac-mini.local` 的 3 包（seq 1→3 连续、丢包 0、非法 0、出错 0），数据与 agent 端实测格式逐字段一致，落盘内容见第 3.2 节示例。

## 6. 路线图

### 阶段 2：FastAPI 展示面（✅ 2026-09 图表页已完成）

**进程模型**——接收与展示是两个独立进程，仍只通过 `data/*.jsonl` 文件交换数据（无需锁）。早期设想的「同进程双线程」暂未采用：两个进程各自独立启停、互不影响，更简单也够用；`signal.signal` 的主线程限制随之消失。

```
终端 A：python udp_server.py                接收 → 校验 → 落盘（阶段 1，未改动）
终端 B：.venv/bin/uvicorn app.main:app      HTTP API + 图表静态页（阶段 2）
```

**图表页**（浏览器访问 `http://127.0.0.1:8000/charts`，`/` 自动跳转过去）：

- 三张平滑曲线卡：CPU 占用率（us/sy/id/wa）、内存（已用/可用/联动/压缩）、系统负载（1/5/15 分钟）；
- 进程三线表：最新一包的进程按 CPU 排序，CPU 列带占比底纹，新出现的进程行有淡入动画；
- 数据流：首屏不带 offset 一次拉齐今日已落盘数据成型图表 → 每 2 秒携带 offset 增量轮询 → 新点直接 push 进已成型的曲线，由 ECharts 补间滑入（不重建图表）；每条曲线保留 240 点滑动窗口，满了旧点滑出；跨天文件滚动时接口返回 `rolled_over=true` 并附全量数据，前端整体重置重新成型。

**实际接口**（比早期设想精简：一个数据接口同时覆盖全量与增量）：

| Method | Path | 作用 | 实现要点 |
|---|---|---|---|
| GET | `/api/metrics/today?offset=N` | 今日指标：不带 offset 全量返回；带 offset 只返回新增行 | 按字节偏移读 JSONL，只统计完整行（半行留给下一轮）；`rolled_over` 标记文件滚动 |
| GET | `/charts`（`/` 跳转、`/static/*` 资源） | 图表页与静态资源 | 页面本体在 `app/frontend/`；ECharts 已本地化到 `app/frontend/vendor/`，离线可用 |
| GET | `/healthz` | 存活探针 | 无鉴权，200 即可 |

**文件变大的应对**（每 3 秒一包 ≈ 每天 2.9 万行，单文件几 MB，短期无压力）：增量轮询本身就只读新增字节，天然是「只读尾部」方案；单 agent 场景暂不需要内存缓存与 `/api/metrics/latest`，将来多 agent 时再加。

### 阶段 3：可选增强（按需）

- **迁移数据库**：JSONL 一行一条记录，字段已拍平，写个导入脚本即可进 SQLite/PostgreSQL；`agent_id + seq` 可做主键去重。
- **丢包率面板**：`update_seq_stats` 已算出每 agent 的 lost/restarts，接到 API 和前端即可。
- **UDP 鉴权**（协议阶段 3）：包内 nonce + HMAC 签名，防同网段伪造（agent 文档第 4 节）。
- **按 agent 子目录 / 按小时切文件**：多机规模化后再考虑，现在按天按平铺足够。

## 7. 已知限制（预期管理）

- Python 3.9.6（已过 EOL）：与 agent 端环境一致，升级 3.11+ 前不要用 3.10+ 语法。
- 单线程同步模型：每秒几十包以内毫无压力；若将来 agent 数量多、频率高，再改 asyncio `create_datagram_endpoint`（agent 文档第 6 节有骨架）。
- 丢包统计是**估算**：基于 seq 缺口的简化模型，agent 重启判据是「seq 变小」，理论上可能把极端乱序误判为重启，看趋势够用，不做账务。
- `sender` 字段是 UDP 源地址端口，NAT/容器网络下只作参考，身份以 `agent_id` 为准。
- `data/` 与 `logs/` 目录名相对当前工作目录：在容器里要保证 `WORKDIR` 与 volume 挂载点一致（见 3.4 节 compose 示意）。
- `tests/test.py` 是空文件（占位），真正用例在 `tests/test_udp_server.py`。

## 8. 当前目录结构

```
docker_backend/
├── udp_server.py              # 阶段 1 全部逻辑：接收 → 校验 → 统计 → JSONL（五段式分区）
├── .gitignore                 # .venv / __pycache__ / data / logs
├── Dockerfile                 # 由项目负责人维护（当前为空）
├── app/
│   ├── __init__.py
│   ├── main.py                # FastAPI 组装入口：挂载 API 路由 + /charts 图表页 + /static
│   ├── api/
│   │   ├── __init__.py
│   │   ├── reader.py          # 今日 JSONL 读取器：offset=0 全量 / offset>0 增量（按字节偏移）
│   │   └── routes.py          # GET /api/metrics/today（首屏全量与轮询增量共用）
│   └── frontend/
│       ├── index.html         # 图表页骨架：三张曲线卡 + 进程三线表
│       ├── style.css          # 深色面板样式 + 三线表（顶线 / 栏目线 / 底线）
│       ├── app.js             # 首屏全量成型 + 2 秒增量轮询 + 新点滑入动画
│       └── vendor/echarts.min.js  # ECharts 5.5.1 本地化（离线可用）
├── tests/
│   ├── __init__.py
│   ├── test.py                # 空占位文件
│   └── test_udp_server.py     # 单元测试 13 例（unittest，零依赖）
├── data/                      # 运行时生成：metrics-YYYYMMDD.jsonl（git 忽略）
├── logs/                      # 运行时生成：backend.log（git 忽略）
└── docs/ARCHITECTURE.md       # 本文档
```
