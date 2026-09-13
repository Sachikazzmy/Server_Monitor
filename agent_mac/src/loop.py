"""
采集循环：固定节拍调度 + 单轮异常隔离 + 优雅退出。

每轮流程：采集(top) → 解析(dict) → 组包发送(UDP)。
任何一轮失败只计数、打日志，绝不中断循环。
"""

import logging
import signal
import threading
import time

from src.collector.top_data import catch_top
from src.parser.top_parse import parse_top_to_dict
from src.transport.udp_sender import send_metrics


# ============================================================
# 单轮采集
# ============================================================

def collect_once(state, sock):
    """执行一轮完整的 采集→解析→发送，失败抛异常交给 run_loop 处理。"""

    # 1. 采集：top 原始文本（失败/超时返回 None）
    raw_text = catch_top(state.process_count)

    if raw_text is None:
        raise RuntimeError("top 采集失败")

    # 2. 解析：dict（空输出返回 None）
    data = parse_top_to_dict(raw_text, expected_process_count=state.process_count)

    if data is None:
        raise RuntimeError("top 输出为空，无法解析")

    # 3. 组包发送：v2 信封 + 紧凑 JSON
    send_metrics(sock, state, data)


# ============================================================
# 主循环
# ============================================================

def run_loop(state, sock, stop_event):
    """固定节拍的主循环，直到 stop_event 被触发。"""

    next_tick = time.monotonic()

    while not stop_event.is_set():

        # 固定节拍：先算好下一轮时间点，top 的执行耗时不影响周期
        next_tick += state.interval_sec

        # paused 状态下只等待、不采集（阶段 2 的控制面修改 state.status）
        if state.status == "running":
            try:
                collect_once(state, sock)
            except Exception as exc:
                # 单轮失败不退出：计数 + 记录原因 + 继续下一轮
                state.mark_error(f"{type(exc).__name__}: {exc}")
                logging.exception("本轮采集/发送失败")

        # 精确睡到下一节拍；stop_event 被触发时 wait 会立刻返回
        remaining = next_tick - time.monotonic()
        stop_event.wait(remaining if remaining > 0 else 0.0)


# ============================================================
# 信号处理
# ============================================================

def setup_signal_handlers():
    """注册 SIGINT/SIGTERM，返回 stop_event；触发后主循环优雅退出。"""

    stop_event = threading.Event()

    def _request_stop(signum, _frame):
        # SIGINT = Ctrl+C；SIGTERM = kill / launchd 停止服务
        logging.info("收到信号 %s，准备优雅退出", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)

    return stop_event
