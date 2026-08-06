import sys
import os
from pathlib import Path
from loguru import logger
from core.config import settings

# 确保日志目录存在
log_dir = Path(settings.LOG_FILE).parent
log_dir.mkdir(parents=True, exist_ok=True)

# 移除默认的日志处理器
logger.remove()

# 添加控制台日志
logger.add(
    sys.stdout,
    level=settings.LOG_LEVEL,
    format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
           "<level>{level: <8}</level> | "
           "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
           "<level>{message}</level>",
    colorize=True,
)

# 添加文件日志（按天轮转）
logger.add(
    settings.LOG_FILE,
    level=settings.LOG_LEVEL,
    format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name}:{function}:{line} - {message}",
    rotation="00:00",  # 每天午夜轮转
    retention="30 days",  # 保留30天
    encoding="utf-8",
    backtrace=True,
    diagnose=True,
)

# 添加错误日志（单独文件）
error_log_file = log_dir / "error.log"
logger.add(
    str(error_log_file),
    level="ERROR",
    format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name}:{function}:{line} - {message}\n{exception}",
    rotation="1 week",
    retention="90 days",
    encoding="utf-8",
    backtrace=True,
    diagnose=True,
)


def get_logger(name: str):
    """
    获取带名称的日志记录器
    
    Args:
        name: 日志记录器名称（通常是模块名）
    
    Returns:
        logger: 配置好的日志记录器
    """
    return logger.bind(name=name)


# 请求日志中间件
async def log_requests(request, call_next):
    """
    FastAPI请求日志中间件
    
    记录每个请求的处理时间和状态
    """
    from fastapi import Request
    from time import time
    
    start_time = time()
    
    # 记录请求信息
    client_host = request.client.host if request.client else "unknown"
    logger.info(
        f"请求开始 | {request.method} {request.url.path} | "
        f"客户端: {client_host}"
    )
    
    # 处理请求
    response = await call_next(request)
    
    # 计算处理时间
    process_time = time() - start_time
    
    # 记录响应信息
    logger.info(
        f"请求完成 | {request.method} {request.url.path} | "
        f"状态: {response.status_code} | "
        f"耗时: {process_time:.3f}s"
    )
    
    # 记录慢请求
    if process_time > 1.0:
        logger.warning(
            f"慢请求 | {request.method} {request.url.path} | "
            f"耗时: {process_time:.3f}s"
        )
    
    return response
