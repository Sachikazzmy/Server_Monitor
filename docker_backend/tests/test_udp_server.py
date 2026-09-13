"""
udp_server.py 纯逻辑函数的单元测试（不碰网络）。

运行方式（项目根目录执行）：
    .venv/bin/python -m unittest discover -s tests -v
"""

import json
import os
import sys
import tempfile
import unittest

# 把项目根目录加进 sys.path，保证无论从哪里跑都能 import 到 udp_server
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import udp_server


# ============================================================
# 测试数据：一个完全合法的 v2 包（与 agent 端真实格式一致）
# ============================================================

def make_valid_packet(seq=1):
    return {
        "v": 1,
        "type": "metrics.top",
        "agent_id": "MacdeMac-mini.local",
        "seq": seq,
        "ts": "2026-09-13T08:25:35.201979+00:00",
        "interval_sec": 1.0,
        "data": {
            "load_average": [2.99, 2.93, 2.55],
            "cpu": {"us": 8.49, "sy": 12.87, "id": 78.63, "wa": 0.0},
            "memory": {"total_mb": 15427.0, "used_mb": 15360.0, "free_mb": 67.0},
            "processes": [{"pid": 26341, "command": "top", "cpu_pct": 0.0, "mem_mb": 4.64}],
        },
    }


class ValidatePacketTest(unittest.TestCase):
    """信封校验：合法包放行，各类坏包给出原因。"""

    def test_valid_packet_passes(self):
        self.assertIsNone(udp_server.validate_packet(make_valid_packet()))

    def test_wrong_version_rejected(self):
        packet = make_valid_packet()
        packet["v"] = 2
        self.assertIn("v", udp_server.validate_packet(packet))

    def test_wrong_type_rejected(self):
        packet = make_valid_packet()
        packet["type"] = "metrics.unknown"
        self.assertIn("type", udp_server.validate_packet(packet))

    def test_missing_agent_id_rejected(self):
        packet = make_valid_packet()
        packet["agent_id"] = ""
        self.assertIn("agent_id", udp_server.validate_packet(packet))

    def test_boolean_seq_rejected(self):
        packet = make_valid_packet()
        packet["seq"] = True  # bool 是 int 的子类，必须单独挡住
        self.assertIn("seq", udp_server.validate_packet(packet))

    def test_non_dict_rejected(self):
        self.assertIn("JSON", udp_server.validate_packet([1, 2, 3]))


class SeqStatsTest(unittest.TestCase):
    """丢包统计：基线、连续、跳号、重启。"""

    def test_first_packet_establishes_baseline(self):
        stats = {}
        udp_server.update_seq_stats(stats, "agent-a", 7)
        self.assertEqual(stats["agent-a"]["lost"], 0)

    def test_consecutive_packets_no_loss(self):
        stats = {}
        udp_server.update_seq_stats(stats, "agent-a", 1)
        udp_server.update_seq_stats(stats, "agent-a", 2)
        udp_server.update_seq_stats(stats, "agent-a", 3)
        self.assertEqual(stats["agent-a"]["lost"], 0)

    def test_gap_counts_lost_packets(self):
        stats = {}
        udp_server.update_seq_stats(stats, "agent-a", 1)
        udp_server.update_seq_stats(stats, "agent-a", 2)
        udp_server.update_seq_stats(stats, "agent-a", 5)  # 缺 3、4
        self.assertEqual(stats["agent-a"]["lost"], 2)

    def test_smaller_seq_counts_restart(self):
        stats = {}
        udp_server.update_seq_stats(stats, "agent-a", 10)
        udp_server.update_seq_stats(stats, "agent-a", 1)  # agent 重启归零
        self.assertEqual(stats["agent-a"]["restarts"], 1)

    def test_agents_are_tracked_separately(self):
        stats = {}
        udp_server.update_seq_stats(stats, "agent-a", 1)
        udp_server.update_seq_stats(stats, "agent-b", 100)
        udp_server.update_seq_stats(stats, "agent-a", 3)  # 缺 2
        self.assertEqual(stats["agent-a"]["lost"], 1)
        self.assertEqual(stats["agent-b"]["lost"], 0)


class StorePacketTest(unittest.TestCase):
    """JSONL 落盘：每行合法 JSON，带接收时间戳，追加不覆盖。"""

    def test_writes_valid_jsonl(self):
        with tempfile.TemporaryDirectory() as data_dir:
            packet = make_valid_packet()
            udp_server.store_packet(data_dir, packet, ("127.0.0.1", 50000))

            file_names = os.listdir(data_dir)
            self.assertEqual(len(file_names), 1)
            self.assertTrue(file_names[0].startswith("metrics-"))
            self.assertTrue(file_names[0].endswith(".jsonl"))

            with open(os.path.join(data_dir, file_names[0]), encoding="utf-8") as f:
                record = json.loads(f.readline())
            self.assertEqual(record["agent_id"], "MacdeMac-mini.local")
            self.assertIn("received_at", record)
            self.assertEqual(record["sender"], "127.0.0.1:50000")

    def test_appends_without_overwriting(self):
        with tempfile.TemporaryDirectory() as data_dir:
            udp_server.store_packet(data_dir, make_valid_packet(seq=1), ("127.0.0.1", 1))
            udp_server.store_packet(data_dir, make_valid_packet(seq=2), ("127.0.0.1", 1))

            file_path = os.path.join(data_dir, os.listdir(data_dir)[0])
            with open(file_path, encoding="utf-8") as f:
                lines = f.readlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(json.loads(lines[0])["seq"], 1)
            self.assertEqual(json.loads(lines[1])["seq"], 2)


if __name__ == "__main__":
    unittest.main()
