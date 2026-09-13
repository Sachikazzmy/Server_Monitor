"""
运行时状态模块：AgentState 是整个 agent 唯一的共享状态对象。

采集循环读它、（阶段 2 的）控制面写它，所有会变化的字段由同一把锁保护。
"""

import threading
import time
from dataclasses import dataclass, field
from typing import Optional


# ============================================================
# 状态对象
# ============================================================

@dataclass
class AgentState:

    # —— 运行配置（从 config 初始化；阶段 2 的控制面接口可直接修改） ——

    interval_sec: float = 3.0
    process_count: int = 3
    server_host: str = "127.0.0.1"
    server_port: int = 9999

    # —— 运行状态 ——

    status: str = "running"           # running=采集中 / paused=已暂停
    seq: int = 0                      # 发包序号，后端用来算丢包率
    packets_sent: int = 0             # 成功发送的包数
    send_errors: int = 0              # 采集或发送失败的次数
    last_error: Optional[str] = None  # 最近一次失败的描述
    started_at: float = field(default_factory=time.time)

    # 保护上面所有会变化字段的锁（repr=False 免得打印状态时刷屏）
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # —— 状态更新方法（都很短，采集循环 / 传输层直接调用） ——


    def next_seq(self):
        """取下一个发包序号。"""

        with self.lock:
            self.seq += 1
            return self.seq

    def mark_sent(self):
        """记一次成功发送。"""

        with self.lock:
            self.packets_sent += 1

    def mark_error(self, message):
        """记一次失败，覆盖 last_error。"""

        with self.lock:
            self.send_errors += 1
            self.last_error = message

    def snapshot(self):
        """导出一份状态快照（日志 / 阶段 2 的 /status 接口用）。"""

        with self.lock:
            return {
                "status": self.status,
                "interval_sec": self.interval_sec,
                "process_count": self.process_count,
                "server": f"{self.server_host}:{self.server_port}",
                "uptime_sec": round(time.time() - self.started_at, 1),
                "seq": self.seq,
                "packets_sent": self.packets_sent,
                "send_errors": self.send_errors,
                "last_error": self.last_error,
            }
