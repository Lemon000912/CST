FROM python:3.12-slim

WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制项目代码
COPY . .

# 创建必要目录
RUN mkdir -p data logs documents

# 暴露端口
EXPOSE 9003

# 启动命令
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9003"]
