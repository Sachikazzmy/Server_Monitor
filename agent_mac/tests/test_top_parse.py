"""
解析层单元测试：全部基于真实 top 输出样本，不依赖网络与 top 命令。

运行方式（项目根目录）：
    .venv/bin/python -m unittest discover -s tests -v
"""

import unittest
from pathlib import Path

from src.parser.top_parse import parse_top_to_dict, unit_to_mb


# 样本文件目录
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"


def load_fixture(name):
    """读取一个 top 输出样本文件。"""

    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


# ============================================================
# 正常单段采样（top -l 1）
# ============================================================

class TestParseNormalSample(unittest.TestCase):

    def test_load_average_and_cpu(self):
        data = parse_top_to_dict(load_fixture("top_l1.txt"))

        self.assertEqual(data["load_average"], [2.5, 2.3, 2.11])
        self.assertEqual(data["cpu"], {"us": 9.6, "sy": 12.63, "id": 78.29, "wa": 0.0})

    def test_memory_in_mb(self):
        data = parse_top_to_dict(load_fixture("top_l1.txt"))
        memory = data["memory"]

        self.assertEqual(memory["used_mb"], 15360.0)
        self.assertEqual(memory["free_mb"], 146.0)
        self.assertEqual(memory["total_mb"], 15506.0)
        self.assertEqual(memory["wired_mb"], 2046.0)
        self.assertEqual(memory["compressor_mb"], 4286.0)

    def test_process_fields_normalized(self):
        data = parse_top_to_dict(load_fixture("top_l1.txt"))
        first = data["processes"][0]

        self.assertEqual(first, {"pid": 25592, "command": "head", "cpu_pct": 0.0, "mem_mb": 0.84})
        self.assertEqual(len(data["processes"]), 3)


# ============================================================
# 边界情况
# ============================================================

class TestParseEdgeCases(unittest.TestCase):

    def test_empty_input_returns_none(self):
        self.assertIsNone(parse_top_to_dict(""))
        self.assertIsNone(parse_top_to_dict(None))

    def test_second_sample_headers_not_parsed_as_process(self):
        # top -l 2 会输出两段采样：第二段的表头行绝不能被当成进程行
        data = parse_top_to_dict(load_fixture("top_l2_two_samples.txt"))

        self.assertEqual(len(data["processes"]), 1)
        self.assertEqual(data["processes"][0]["pid"], 25592)
        self.assertEqual(data["processes"][0]["cpu_pct"], 0.1)

        # 指标应取最新一段采样
        self.assertEqual(data["load_average"], [2.48, 2.29, 2.10])
        self.assertEqual(data["cpu"]["us"], 13.54)

    def test_command_with_spaces(self):
        raw = "PID    COMMAND %CPU MEM\n12345 Google Chrome Helper 12.5 300M\n"
        data = parse_top_to_dict(raw)
        first = data["processes"][0]

        self.assertEqual(first["command"], "Google Chrome Helper")
        self.assertEqual(first["cpu_pct"], 12.5)
        self.assertEqual(first["mem_mb"], 300.0)

    def test_expected_count_limit(self):
        data = parse_top_to_dict(load_fixture("top_l1.txt"), expected_process_count=2)

        self.assertEqual(len(data["processes"]), 2)


# ============================================================
# 单位换算
# ============================================================

class TestUnitConversion(unittest.TestCase):

    def test_kmg_units(self):
        self.assertEqual(unit_to_mb("864", "K"), 0.84)
        self.assertEqual(unit_to_mb("146", "M"), 146.0)
        self.assertEqual(unit_to_mb("15", "G"), 15360.0)


if __name__ == "__main__":
    unittest.main()
