# 在容器上进行实现

FROM python:3.9.6-slim

WORKDIR /

COPY requirements.txt .

RUN pip install --upgrade pip

RUN pip3 install --no-cache-dir -r requirements.txt 

COPY . .

EXPOSE 8000

CMD ["python", "udp_server.py"]