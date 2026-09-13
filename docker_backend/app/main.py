from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


# 定义请求体数据模型
class Item(BaseModel):
    name: str           # 必填：商品名称
    description: str  # 可选：商品描述
    price: float        # 必填：商品价格
    tax: float        # 可选：税费


@app.post("/items/")
async def create_item(item: Item):
    """创建新商品，接收 JSON 请求体"""
    return item


@app.put("/items/{item_id}")
async def update_item(item_id: int, item: Item):
    """更新指定商品，同时使用路径参数和请求体"""
    return {"item_id": item_id, "item_name": item.name}