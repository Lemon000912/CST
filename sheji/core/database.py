from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import declarative_base
from sqlalchemy import text
from typing import AsyncGenerator, Optional
import asyncio
import redis
import os

from core.config import settings
from core.logging import get_logger

logger = get_logger("database")

# 创建异步引擎 - 优化连接池配置
engine = create_async_engine(
    settings.DATABASE_URL,
    pool_size=10,                    # 减小连接池大小
    max_overflow=5,                  # 减小溢出连接数
    pool_pre_ping=True,              # 连接前ping检测
    pool_recycle=3600,               # 1小时回收连接
    pool_timeout=30,                 # 连接超时30秒
    connect_args={
        "timeout": 10,               # 连接超时10秒
        "command_timeout": 30,       # 命令超时30秒
    } if settings.DB_TYPE == "postgresql" else {},
    echo=False,                      # 关闭SQL日志输出，提高性能
)

# 创建会话工厂
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)

# 声明基类
Base = declarative_base()


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    获取数据库会话
    
    用于FastAPI依赖注入
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    """
    初始化数据库
    
    创建所有表结构
    """
    # 确保数据目录存在
    if settings.DB_TYPE == "sqlite":
        os.makedirs(os.path.dirname(settings.SQLITE_PATH), exist_ok=True)
    
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("✅ 数据库表创建完成")


async def drop_db():
    """
    删除所有表
    
    谨慎使用！
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    print("⚠️ 数据库表已删除")


async def check_db_connection() -> bool:
    """
    检查数据库连接是否正常
    
    Returns:
        bool: 连接是否正常
    """
    try:
        async with AsyncSessionLocal() as session:
            if settings.DB_TYPE == "sqlite":
                result = await session.execute(text("SELECT 1"))
            else:
                result = await session.execute(text("SELECT 1"))
            row = result.fetchone()
            if row and row[0] == 1:
                return True
        return False
    except Exception as e:
        print(f"❌ 数据库连接失败: {e}")
        return False


async def close_db():
    """关闭数据库连接"""
    await engine.dispose()
    print("👋 数据库连接已关闭")


# ==================== Redis缓存 ====================
class RedisCache:
    """Redis缓存实现（同步版本）"""
    
    def __init__(self):
        self._redis: Optional[redis.Redis] = None
        self._connected = False
    
    async def connect(self):
        """连接Redis"""
        try:
            self._redis = redis.Redis(
                host=settings.REDIS_HOST,
                port=settings.REDIS_PORT,
                db=settings.REDIS_DB,
                password=settings.REDIS_PASSWORD,
                decode_responses=True,
                socket_connect_timeout=5,
                socket_timeout=5
            )
            self._redis.ping()
            self._connected = True
            logger.info("✅ Redis连接成功")
        except Exception as e:
            logger.warning(f"⚠️ Redis连接失败: {e}，将使用内存缓存")
            self._connected = False
    
    async def get(self, key: str):
        """获取缓存值"""
        if not self._connected or not self._redis:
            return None
        try:
            value = self._redis.get(key)
            if value:
                import json
                return json.loads(value)
            return None
        except Exception as e:
            logger.error(f"Redis get错误: {e}")
            return None
    
    async def set(self, key: str, value, ttl: int = 3600):
        """设置缓存值"""
        if not self._connected or not self._redis:
            return
        try:
            import json
            self._redis.setex(key, ttl, json.dumps(value))
        except Exception as e:
            logger.error(f"Redis set错误: {e}")
    
    async def delete(self, key: str):
        """删除缓存"""
        if not self._connected or not self._redis:
            return
        try:
            self._redis.delete(key)
        except Exception as e:
            logger.error(f"Redis delete错误: {e}")
    
    async def clear(self):
        """清空缓存"""
        if not self._connected or not self._redis:
            return
        try:
            self._redis.flushdb()
        except Exception as e:
            logger.error(f"Redis clear错误: {e}")
    
    async def close(self):
        """关闭Redis连接"""
        if self._redis:
            self._redis.close()
            self._connected = False


# 简单的内存缓存（备用）
class MemoryCache:
    """简单的内存缓存实现"""
    
    def __init__(self):
        self._cache = {}
        self._ttl = {}
    
    async def get(self, key: str):
        """获取缓存值"""
        import time
        if key in self._cache:
            if self._ttl.get(key, 0) > time.time():
                return self._cache[key]
            else:
                del self._cache[key]
                del self._ttl[key]
        return None
    
    async def set(self, key: str, value, ttl: int = 3600):
        """设置缓存值"""
        import time
        self._cache[key] = value
        self._ttl[key] = time.time() + ttl
    
    async def delete(self, key: str):
        """删除缓存"""
        if key in self._cache:
            del self._cache[key]
            if key in self._ttl:
                del self._ttl[key]
    
    async def clear(self):
        """清空缓存"""
        self._cache.clear()
        self._ttl.clear()


# 全局缓存实例
redis_cache = RedisCache()
memory_cache = MemoryCache()


async def init_cache():
    """初始化缓存"""
    if settings.REDIS_ENABLED:
        await redis_cache.connect()
        return redis_cache
    return memory_cache


async def get_cache():
    """获取缓存实例"""
    if settings.REDIS_ENABLED and redis_cache._connected:
        return redis_cache
    return memory_cache


async def close_cache():
    """关闭缓存连接"""
    await redis_cache.close()

# 导出 cache 实例（兼容旧代码）
cache = redis_cache
