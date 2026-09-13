"""
采集层：调用系统 top 命令，拿回原始文本。

当前只支持 macOS 的 BSD top（-l / -stats 参数）；
将来要支持 Linux 时，在这个文件里加一个对应的采集函数即可。
"""

import logging
import subprocess


# ============================================================
# 常量
# ============================================================

# top 最长等待秒数：超时视为本轮采集失败，绝不让 agent 卡死
TOP_TIMEOUT_SECONDS = 5


# ============================================================
# 采集函数
# ============================================================

def catch_top(process_count, mode="cpu"):
    """跑一次 top，返回原始文本；失败或超时返回 None。"""

    # top 参数含义：-l 1 只采样一轮；-o mode 排序列；-n 限制进程行数；-stats 指定列
    cmd = ["top", "-l", "1", "-o", mode, "-n", str(process_count), "-stats", "pid,command,cpu,mem"]

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=TOP_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        logging.error("top 命令超过 %s 秒未返回，本轮放弃", TOP_TIMEOUT_SECONDS)
        return None

    # 返回码非 0 说明 top 本身出错，把 stderr 截一段写进日志方便排查
    if result.returncode != 0:
        stderr_text = result.stderr.decode("utf-8", errors="ignore").strip()[:200]
        logging.error("top 命令失败: %s", stderr_text)
        return None

    return result.stdout.decode("utf-8", errors="ignore")
