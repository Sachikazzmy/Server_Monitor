"""
传输层：把解析好的 dict 组装成 v2 信封，用 UDP 发给后端。

协议要点：
    - 外层是元数据信封（v/type/agent_id/seq/ts），指标数据在 data 字段
    - 紧凑序列化（separators 去空格），比 indent=4 省 2 倍以上带宽
    - 单包控制在 1400 字节内，避免 IP 分片
"""

import json
import logging
import socket
from datetime import datetime, timezone


# ============================================================
# 常量
# ============================================================

# 标准以太网 MTU 1500 - IP 头 20 - UDP 头 8 = 1472，再留些余量取 1400
MAX_PAYLOAD_BYTES = 1400


# ============================================================
# socket 管理
# ============================================================

def create_socket():
    """创建 UDP socket：AF_INET + SOCK_DGRAM，无连接、发完即忘。"""

    return socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


# ============================================================
# 组包与发送
# ============================================================

def send_metrics(sock, state, data):
    """组一个 v2 包并发送；seq 递增、成功后更新统计。"""

    # v2 信封：元数据在外层，后端按 agent_id + seq 做丢包统计
    packet = {
        "v": 1,
        "type": "metrics.top",
        "agent_id": socket.gethostname(),
        "seq": state.next_seq(),
        "ts": datetime.now(timezone.utc).isoformat(),
        "interval_sec": state.interval_sec,
        "data": data,
    }

    # 紧凑序列化：separators 去掉默认空格，带宽减半以上
    payload = json.dumps(packet, separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    # MTU 防线：超限只告警不阻断（当前 3 进程约 400 字节，余量很大）
    if len(payload) > MAX_PAYLOAD_BYTES:
        logging.warning("负载 %d 字节超过 %d，可能触发 IP 分片", len(payload), MAX_PAYLOAD_BYTES)

    sock.sendto(payload, (state.server_host, state.server_port))
    state.mark_sent()
