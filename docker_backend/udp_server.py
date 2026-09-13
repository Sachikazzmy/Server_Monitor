"""
udp_server.py — 服务器信息采集系统 · 后端 UDP 接收器（阶段 1）

职责（对应总目标「接收 ➡️ 存储 ➡️ 展示」的前两步）：
    1. 接收  agent_mac 发来的 v2 指标包（UDP，默认 0.0.0.0:9999）
    2. 校验  检查 v2 信封（v / type / agent_id / seq / data），不合法丢弃并计数
    3. 存储  以 JSONL 追加写入 data/metrics-YYYYMMDD.jsonl（每天一个文件）
             同时按 agent_id / seq 估算丢包数，运行日志写 logs/backend.log

运行方式：
    python udp_server.py
    退出：Ctrl+C 或 kill <pid>（两者都走优雅退出，退出时打印统计摘要）

环境变量（均可不设，使用默认值）：
    BACKEND_UDP_HOST   监听地址。容器内必须用 0.0.0.0，本机调试可用 127.0.0.1
    BACKEND_UDP_PORT   监听端口（默认 9999）
    BACKEND_DATA_DIR   指标数据目录（默认 ./data）

存储说明（当前阶段不使用数据库）：
    每行一个独立的 JSON 对象（JSONL 格式），行内带接收时间戳。
    用文本编辑器 / grep / jq 都能直接看；以后迁移数据库时，一行就是一条记录。
"""

import json
import logging
import os
import signal
import socket
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler


# ============================================================
# 常量
# ============================================================

# 接收缓冲区给到 UDP 数据报的理论上限（65507），一次到位。
# 旧版用 1024：协议允许单包到 1400 字节，agent 进程数调大后包一超过 1024，
# 数据报会被操作系统「静默截断」，JSON 必然解析失败且没有任何报错。
RECV_BUFFER_BYTES = 65536

# v2 信封的固定字段（与 agent_mac/src/transport/udp_sender.py 约定一致）
PROTOCOL_VERSION = 1
PROTOCOL_TYPE = "metrics.top"

# 运行日志：1MB 轮转、保留 3 份（与 agent 端的日志约定保持一致）
LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 3

# 运行开关：信号处理函数改它，主循环每一秒检查一次。
# 用 dict 而不是普通变量，这样信号处理函数里不需要 global / nonlocal。
STOP = {"flag": False}


# ============================================================
# 配置与日志
# ============================================================

def load_config_from_env():
    """从环境变量读配置，没设置就用默认值。

    容器场景下环境变量比配置文件更常用（docker-compose 里一行就能改），
    所以这里不再做 config.json 那套三级加载，保持简单。
    """

    host = os.getenv("BACKEND_UDP_HOST", "0.0.0.0")
    port = int(os.getenv("BACKEND_UDP_PORT", "9999"))
    data_dir = os.getenv("BACKEND_DATA_DIR", "data")
    return host, port, data_dir


def setup_logging():
    """运行日志：logs/backend.log 轮转落盘 + stderr 各一份。

    落盘的原因：容器重启后 docker logs 就没了，排障需要留在文件里。
    """

    os.makedirs("logs", exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            RotatingFileHandler(
                "logs/backend.log",
                maxBytes=LOG_MAX_BYTES,
                backupCount=LOG_BACKUP_COUNT,
                encoding="utf-8",
            ),
            logging.StreamHandler(),
        ],
    )


def request_stop(signum, frame):
    """SIGTERM（docker stop / kill）和 SIGINT（Ctrl+C）都只把开关打开。

    signum / frame 是 signal 模块要求的函数签名，这里用不上。
    刻意不在信号处理函数里做收尾工作：信号函数里只改一个开关，最安全。
    """

    STOP["flag"] = True


# ============================================================
# 包校验与统计
# ============================================================

def validate_packet(packet):
    """校验 v2 信封。通过返回 None；不通过返回一行原因字符串。

    协议约定：后端遇到不认识的版本直接丢弃并计数，不做猜测解析。
    """

    if not isinstance(packet, dict):
        return "不是 JSON 对象"
    if packet.get("v") != PROTOCOL_VERSION:
        return "协议版本 v 不是 %d" % PROTOCOL_VERSION
    if packet.get("type") != PROTOCOL_TYPE:
        return "type 不是 %s" % PROTOCOL_TYPE
    if not isinstance(packet.get("agent_id"), str) or not packet["agent_id"]:
        return "agent_id 缺失或不是非空字符串"
    # bool 是 int 的子类，True/False 混进来也算非法，所以多查一层
    if not isinstance(packet.get("seq"), int) or isinstance(packet.get("seq"), bool):
        return "seq 缺失或不是整数"
    if not isinstance(packet.get("data"), dict):
        return "data 缺失或不是对象"
    return None


def update_seq_stats(seq_stats, agent_id, seq):
    """按 agent 跟踪 seq，估算 UDP 丢包数（简化版，看趋势够用）。

    规则：
      - 第一次见到该 agent：建立基线，不算丢包
      - seq 往前跳：中间缺几个就记丢了几个
      - seq 变小：视为 agent 重启归零（agent 重启后 seq 从 1 重新数）
      - seq 相同：重复包，忽略
    """

    stat = seq_stats.get(agent_id)
    if stat is None:
        seq_stats[agent_id] = {"last_seq": seq, "lost": 0, "restarts": 0}
        return

    if seq > stat["last_seq"]:
        stat["lost"] += seq - stat["last_seq"] - 1
        stat["last_seq"] = seq
    elif seq < stat["last_seq"]:
        stat["restarts"] += 1
        stat["last_seq"] = seq
    # seq 相同：重复包，什么都不做


# ============================================================
# 存储
# ============================================================

def store_packet(data_dir, packet, addr):
    """把一包指标追加写入当天的 JSONL 文件。

    文件名按「本地日期」滚动（方便人直接翻今天的文件）；
    行内 received_at 用 UTC 时间戳，与 agent 发来的 ts 时区保持一致。
    """

    file_name = datetime.now().strftime("metrics-%Y%m%d.jsonl")
    file_path = os.path.join(data_dir, file_name)

    # 存储记录 = 信封字段平铺到顶层（以后查询方便）+ 后端自己的接收信息
    record = dict(packet)
    record["received_at"] = datetime.now(timezone.utc).isoformat()
    record["sender"] = "%s:%s" % (addr[0], addr[1])

    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False)

    # 每包开关一次文件：写入量很小（每秒几包），换来的是简单可靠、不怕丢缓冲
    with open(file_path, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def handle_datagram(data, addr, data_dir, seq_stats, counters):
    """处理单个数据包：解析 → 校验 → 丢包统计 → 存盘。

    任何一步失败都只影响这一包，由主循环的 try/except 兜底，服务不退出。
    """

    # 第 1 步：字节 → dict。解不开说明根本不是我们协议的包
    try:
        packet = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        counters["invalid"] += 1
        logging.warning("来自 %s 的包不是合法 JSON，丢弃（累计 %d）",
                        addr[0], counters["invalid"])
        return

    # 第 2 步：信封校验，不合法的丢弃并计数
    reason = validate_packet(packet)
    if reason is not None:
        counters["invalid"] += 1
        logging.warning("来自 %s 的包校验失败（%s），丢弃（累计 %d）",
                        addr[0], reason, counters["invalid"])
        return

    # 第 3 步：按 agent 记 seq，估算丢包
    update_seq_stats(seq_stats, packet["agent_id"], packet["seq"])

    # 第 4 步：落盘
    store_packet(data_dir, packet, addr)
    counters["stored"] += 1


# ============================================================
# 主流程
# ============================================================

def log_summary(counters, seq_stats):
    """退出时打印本次运行的统计摘要。"""

    logging.info("===== 本次运行统计 =====")
    logging.info("收到 %d 包，存盘 %d 行，丢弃非法 %d 包，处理出错 %d 次",
                 counters["received"], counters["stored"],
                 counters["invalid"], counters["errors"])
    for agent_id, stat in seq_stats.items():
        logging.info("agent[%s] last_seq=%d 丢包(估算)=%d 重启=%d 次",
                     agent_id, stat["last_seq"], stat["lost"], stat["restarts"])


def main():
    # 组装顺序：配置 → 日志 → 目录 → socket → 信号 → 进入循环
    host, port, data_dir = load_config_from_env()
    setup_logging()
    os.makedirs(data_dir, exist_ok=True)

    server_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server_socket.bind((host, port))

    # recvfrom 默认会一直卡住等包；设 1 秒超时让循环每秒醒一次，
    # 这样收到退出信号后最多 1 秒内就能正常退出。
    server_socket.settimeout(1.0)

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    counters = {"received": 0, "stored": 0, "invalid": 0, "errors": 0}
    seq_stats = {}  # agent_id → {"last_seq": int, "lost": int, "restarts": int}

    logging.info("UDP 接收器已启动，监听 %s:%s（UDP），数据目录 %s", host, port, data_dir)

    while not STOP["flag"]:
        try:
            data, addr = server_socket.recvfrom(RECV_BUFFER_BYTES)
        except socket.timeout:
            # 超时不是错误，只是回到循环头看看该不该退出
            continue

        counters["received"] += 1

        # 单包失败不致命：记日志、计数，服务继续跑（agent 端 P0#1 的同款教训）
        try:
            handle_datagram(data, addr, data_dir, seq_stats, counters)
        except Exception:
            counters["errors"] += 1
            logging.exception("处理来自 %s 的数据包失败，服务继续运行", addr)

    log_summary(counters, seq_stats)
    server_socket.close()
    logging.info("UDP 接收器已退出")


if __name__ == "__main__":
    main()
