"""
routes.py — 图表页的数据接口。

接口只有一个：GET /api/metrics/today
    首屏不带 offset → 把今天已落盘的数据一次返回；
    之后带上返回的 offset → 只返回新增的行，供前端轮询。
两种场景共用一个接口，前端只需要一条请求路径。
"""

import os

from fastapi import APIRouter

from app.api import reader

router = APIRouter()

DATA_DIR = os.getenv("BACKEND_DATA_DIR", "data")


@router.get("/api/metrics/today")
def get_today_metrics(offset: int = 0):
    """今日指标。返回 offset（下次轮询位置）、rolled_over（文件是否滚动过）与 records。"""
    records, next_offset, rolled_over = reader.read_records(DATA_DIR, offset)
    return {"offset": next_offset, "rolled_over": rolled_over, "records": records}
