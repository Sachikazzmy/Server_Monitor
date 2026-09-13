"""
服务器信息采集 Agent —— 入口与组装。

只负责把各模块接起来：
    加载配置 → 初始化日志 → 创建运行状态 → 创建 UDP socket → 注册信号 → 进入采集循环

运行方式（项目根目录）：
    python main.py

配置（优先级从低到高）：
    内置默认值 → config.json（首次运行自动生成）→ AGENT_* 环境变量
"""

import logging
import logging.handlers
import sys
from pathlib import Path

from src.config import load_config
from src.loop import run_loop, setup_signal_handlers
from src.state import AgentState
from src.transport.udp_sender import create_socket


# ============================================================
# 常量
# ============================================================

PROJECT_ROOT = Path(__file__).resolve().parent
LOG_DIR = PROJECT_ROOT / "logs"
LOG_FILE = LOG_DIR / "agent.log"
LOG_MAX_BYTES = 1024 * 1024    # 单个日志文件上限 1MB，超过自动轮转
LOG_BACKUP_COUNT = 3           # 最多保留 3 个历史日志文件


# ============================================================
# 日志初始化
# ============================================================

def setup_logging(log_level):
    """日志同时写文件（轮转）和 stderr，级别来自配置。"""

    LOG_DIR.mkdir(exist_ok=True)

    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    file_handler = logging.handlers.RotatingFileHandler(
        LOG_FILE, maxBytes=LOG_MAX_BYTES, backupCount=LOG_BACKUP_COUNT, encoding="utf-8"
    )
    console_handler = logging.StreamHandler(sys.stderr)

    file_handler.setFormatter(formatter)
    console_handler.setFormatter(formatter)

    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        handlers=[file_handler, console_handler],
    )


# ============================================================
# 组装入口
# ============================================================

def main():
    # 1. 先读配置（日志级别来自配置，所以日志初始化要放在读配置之后）
    config = load_config()
    setup_logging(config["log_level"])
    logging.info("配置加载完成: %s", config)

    # 2. 创建运行时状态（阶段 2 的控制面将直接读写这个对象）
    state = AgentState(
        interval_sec=config["interval_sec"],
        process_count=config["process_count"],
        server_host=config["server_host"],
        server_port=config["server_port"],
    )

    # 3. UDP socket + 优雅退出信号
    sock = create_socket()
    stop_event = setup_signal_handlers()

    logging.info(
        "Agent 启动: 目标 %s:%s, 间隔 %ss, 进程数 %s",
        state.server_host, state.server_port, state.interval_sec, state.process_count,
    )

    try:
        run_loop(state, sock, stop_event)
    except Exception:
        # 循环本身的意外错误：记日志后向上抛，交给退出码
        logging.exception("采集循环意外终止")
        raise
    finally:
        # 无论正常停止还是异常退出，都收尾
        sock.close()
        logging.info("Agent 已停止: %s", state.snapshot())


if __name__ == "__main__":
    main()
