"""
app.main — FastAPI 组装入口（阶段 2：展示面）。

职责只有两件事：
    1. 挂载 app/api/routes.py 里的数据接口；
    2. 把 app/frontend/ 的静态图表页暴露给浏览器。

运行（项目根目录）：
    .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
然后访问 http://127.0.0.1:8000/charts 进入图表页。
"""

import os

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api import routes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = FastAPI(title="Server Monitor")
app.include_router(routes.router)


@app.get("/healthz")
def healthz():
    """存活探针：返回 200 即存活。"""
    return {"status": "ok"}


@app.get("/")
def root():
    """根路径直接跳到图表页。"""
    return RedirectResponse(url="/charts")


@app.get("/charts")
def charts_page():
    """图表目录：监控图表页入口，页面本体与静态资源都在 app/frontend/。"""
    file_path = os.path.join(FRONTEND_DIR, "index.html")
    return FileResponse(file_path)


# 页面脚本与样式（app.js / style.css / vendor/echarts.min.js）统一挂在 /static 下
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
