"""
解析层：把 top 的原始文本解析成 dict（不做序列化，JSON 打包在传输层）。

归一化约定：
    - CPU / 负载 → 浮点数
    - 内存（含进程 MEM 列）→ 统一换算成 MB
    - 进程 PID → int，%CPU → float
"""

import re


# ============================================================
# 换算与辅助
# ============================================================

# 内存单位 → MB 的倍率
UNIT_TO_MB = {"K": 1 / 1024, "M": 1.0, "G": 1024.0}


def unit_to_mb(value, unit):
    """把数字字符串 + 单位（K/M/G）换算成 MB，保留两位小数。"""

    return round(float(value) * UNIT_TO_MB.get(unit, 1.0), 2)


def _match_percent(line, keyword):
    """抓 "12.63% sys" 这类 "数字% 关键词" 组合，抓不到返回 0.0。"""

    match = re.search(r"(\d+\.?\d*)%\s+" + keyword, line)

    return float(match.group(1)) if match else 0.0


def _build_process(fields):
    """一行进程字段 → dict：第 0 列 PID，最后两列 %CPU/MEM，中间全是命令名。"""

    # MEM 列偶尔带 "+" 后缀（表示内存正在增长），先去掉再解析
    mem_token = fields[-1].rstrip("+")
    mem_match = re.fullmatch(r"(\d+)([KMG])", mem_token)

    return {
        "pid": int(fields[0]),
        "command": " ".join(fields[1:-2]),
        "cpu_pct": float(fields[-2]),
        "mem_mb": unit_to_mb(mem_match.group(1), mem_match.group(2)) if mem_match else 0.0,
    }


# ============================================================
# 主解析函数
# ============================================================

def parse_top_to_dict(raw_text, expected_process_count=10):
    """把 top 原始文本解析成 dict；输入为空返回 None。"""

    if not raw_text:
        return None

    # 空数据骨架：保证每个包字段结构一致，后端处理简单
    data = {
        "load_average": [0.0, 0.0, 0.0],
        "cpu": {"us": 0.0, "sy": 0.0, "id": 0.0, "wa": 0.0},
        "memory": {"total_mb": 0.0, "used_mb": 0.0, "free_mb": 0.0, "wired_mb": 0.0, "compressor_mb": 0.0},
        "processes": [],
    }

    process_start = False

    for line in raw_text.split("\n"):
        line = line.strip()

        if not line:
            continue

        # 1. 系统负载：抓行内前三个数字（若出现两段采样，后一段自然覆盖前一段）
        if "Load Avg:" in line:
            numbers = re.findall(r"[-+]?\d*\.\d+|\d+", line)
            if len(numbers) >= 3:
                data["load_average"] = [float(x) for x in numbers[:3]]

        # 2. CPU 占比：user / sys / idle（macOS 的 top 没有 wa 指标，固定 0.0）
        elif "CPU usage:" in line:
            data["cpu"]["us"] = _match_percent(line, "user")
            data["cpu"]["sy"] = _match_percent(line, "sys")
            data["cpu"]["id"] = _match_percent(line, "idle")

        # 3. 物理内存：统一换算 MB；total 用 used+unused 估算（已知限制见 docs/ARCHITECTURE.md）
        elif "PhysMem:" in line:
            used_match = re.search(r"(\d+)([KMG])\s+used", line)
            free_match = re.search(r"(\d+)([KMG])\s+unused", line)
            wired_match = re.search(r"(\d+)([KMG])\s+wired", line)
            compressor_match = re.search(r"(\d+)([KMG])\s+compressor", line)

            data["memory"]["used_mb"] = unit_to_mb(used_match.group(1), used_match.group(2)) if used_match else 0.0
            data["memory"]["free_mb"] = unit_to_mb(free_match.group(1), free_match.group(2)) if free_match else 0.0
            data["memory"]["wired_mb"] = unit_to_mb(wired_match.group(1), wired_match.group(2)) if wired_match else 0.0
            data["memory"]["compressor_mb"] = unit_to_mb(compressor_match.group(1), compressor_match.group(2)) if compressor_match else 0.0
            data["memory"]["total_mb"] = round(data["memory"]["used_mb"] + data["memory"]["free_mb"], 2)

        # 4. 进程表头：开始收进程行；再次遇到表头说明是下一段采样（top -l 2），清空旧段只留最新
        elif "PID" in line and "COMMAND" in line and "CPU" in line:
            process_start = True
            data["processes"] = []
            continue

        # 5. 进程行：PID 必须是纯数字（自动过滤表头/日期/Networks 等杂行），收满即止
        elif process_start:
            fields = line.split()
            is_process_row = len(fields) >= 4 and fields[0].isdigit()
            has_room = len(data["processes"]) < expected_process_count

            if is_process_row and has_room:
                data["processes"].append(_build_process(fields))

    return data
