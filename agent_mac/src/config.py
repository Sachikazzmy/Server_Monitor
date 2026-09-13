"""
配置模块：负责配置的加载与保存。

优先级（从低到高）：内置默认值 → config.json → 环境变量。
"""

import json
import logging
import os
from pathlib import Path


# ============================================================
# 常量定义
# ============================================================

# config.json 放在项目根目录（src 的上一级）
CONFIG_FILE = Path(__file__).resolve().parent.parent / "config.json"

# 内置默认值：config.json 缺失或字段缺失时的兜底
DEFAULT_CONFIG = {
    "interval_sec": 3.0,          # 采集发送间隔（秒）
    "process_count": 3,           # 采集的热门进程数量
    "server_host": "127.0.0.1",   # 后端 UDP 接收地址
    "server_port": 9999,          # 后端 UDP 接收端口
    "log_level": "INFO",          # 日志级别：DEBUG / INFO / WARNING / ERROR
}

# 各字段的类型：读取 json / 环境变量后做类型转换，防止拿到字符串
FIELD_TYPES = {
    "interval_sec": float,
    "process_count": int,
    "server_host": str,
    "server_port": int,
    "log_level": str,
}

# 环境变量名与配置字段的对应关系（优先级最高，方便不改文件临时调整）
ENV_NAMES = {
    "interval_sec": "AGENT_INTERVAL_SEC",
    "process_count": "AGENT_PROCESS_COUNT",
    "server_host": "AGENT_SERVER_HOST",
    "server_port": "AGENT_SERVER_PORT",
    "log_level": "AGENT_LOG_LEVEL",
}


# ============================================================
# 配置读写
# ============================================================

def load_config():
    """按优先级加载配置，返回一个纯字典。"""

    # 第 1 层：内置默认值
    config = dict(DEFAULT_CONFIG)

    # 第 2 层：config.json（首次运行会自动生成一份默认文件，方便直接改）
    if CONFIG_FILE.exists():
        config = _merge_json_file(config)
    else:
        save_config(config)

    # 第 3 层：环境变量覆盖
    config = _merge_env(config)

    return config


def save_config(config):
    """把配置写回 config.json，只保留已知字段。"""

    payload = {key: config[key] for key in DEFAULT_CONFIG}

    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
    except OSError as exc:
        logging.warning("写入配置文件 %s 失败: %s", CONFIG_FILE, exc)


# ============================================================
# 内部辅助
# ============================================================

def _merge_json_file(config):
    """把 config.json 里的合法字段合并进 config，文件坏了就降级用默认值。"""

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            file_data = json.load(f)

        for key in DEFAULT_CONFIG:
            if key in file_data:
                config[key] = FIELD_TYPES[key](file_data[key])

    except (OSError, json.JSONDecodeError, ValueError, TypeError) as exc:
        logging.warning("读取配置文件 %s 失败，相关字段使用默认值: %s", CONFIG_FILE, exc)

    return config


def _merge_env(config):
    """把设置过的环境变量合并进 config，格式不合法就跳过并告警。"""

    for key, env_name in ENV_NAMES.items():
        raw_value = os.environ.get(env_name)

        if raw_value is None or raw_value == "":
            continue

        try:
            config[key] = FIELD_TYPES[key](raw_value)
        except ValueError:
            logging.warning("环境变量 %s=%r 不是合法的 %s，已忽略", env_name, raw_value, FIELD_TYPES[key])

    return config
