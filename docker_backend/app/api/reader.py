"""
reader.py — 今日指标 JSONL 文件的读取器。

只负责「读」这一件事，与 udp_server.py 通过文件解耦：接收端只写，这里只读。
    - offset=0  全量读取：图表页首屏把今天已有的数据一次拿齐；
    - offset>0  增量读取：轮询时只读上次位置之后新增的行，不重读整份文件。
"""

import json
import os
from datetime import datetime


def today_file_path(data_dir):
    """今天的 JSONL 文件路径（文件名规则与 udp_server.store_packet 保持一致）。"""
    file_name = datetime.now().strftime("metrics-%Y%m%d.jsonl")
    return os.path.join(data_dir, file_name)


def parse_lines(raw_lines):
    """把完整行的字节列表解析成记录列表；空行与解不开的行直接跳过（不致命）。"""
    records = []
    for line in raw_lines:
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def read_records(data_dir, offset=0):
    """从字节 offset 起读取今天的记录，返回 (records, next_offset, rolled_over)。

    next_offset  下次轮询应携带的字节位置（只统计完整行，半行留给下一轮）
    rolled_over  文件比 offset 还短时为 True（跨天新建 / 文件被清理），
                 此时自动改从文件头全量重读，前端收到 True 会整体重置图表。
    """
    if offset < 0:
        offset = 0

    file_path = today_file_path(data_dir)
    if not os.path.exists(file_path):
        return [], 0, offset > 0

    rolled_over = False
    if offset > os.path.getsize(file_path):
        offset = 0
        rolled_over = True

    with open(file_path, "rb") as f:
        f.seek(offset)
        chunk = f.read()

    # 接收端可能正在写最后一行：末尾没有 \n 的是半行，只保留完整行
    raw_lines = chunk.split(b"\n")[:-1]
    records = parse_lines(raw_lines)

    consumed = sum(len(line) + 1 for line in raw_lines)
    return records, offset + consumed, rolled_over
