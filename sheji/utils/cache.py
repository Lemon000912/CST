from typing import Optional, Any, Callable
from functools import wraps
import asyncio
import hashlib
import json

from core.database import cache
from core.logging import get_logger

logger = get_logger("cache")


def generate_cache_key(prefix: str, *args, **kwargs) -> str:
    """
    生成缓存键
    
    Args:
        prefix: 键前缀
        *args: 位置参数
        **kwargs: 关键字参数
        
    Returns:
        缓存键字符串
    """
    # 序列化参数
    key_data = {
        "args": args,
        "kwargs": kwargs
    }
    key_str = json.dumps(key_data, sort_keys=True, ensure_ascii=False)
    
    # 生成哈希
    key_hash = hashlib.md5(key_str.encode()).hexdigest()
    
    return f"{prefix}:{key_hash}"


def cache_result(ttl: int = 3600, key_prefix: Optional[str] = None):
    """
    缓存装饰器
    
    自动缓存函数返回结果
    
    Args:
        ttl: 缓存过期时间（秒）
        key_prefix: 缓存键前缀
        
    Returns:
        装饰器函数
    """
    def decorator(func: Callable) -> Callable:
        prefix = key_prefix or func.__name__
        
        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            # 生成缓存键
            cache_key = generate_cache_key(prefix, *args, **kwargs)
            
            # 尝试从缓存获取
            cached = await cache.get(cache_key)
            if cached is not None:
                logger.debug(f"缓存命中: {cache_key}")
                return cached
            
            # 执行函数
            result = await func(*args, **kwargs)
            
            # 写入缓存
            await cache.set(cache_key, result, ttl=ttl)
            logger.debug(f"缓存写入: {cache_key}")
            
            return result
        
        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            # 同步版本
            cache_key = generate_cache_key(prefix, *args, **kwargs)
            
            # 尝试从缓存获取
            try:
                loop = asyncio.get_event_loop()
                cached = loop.run_until_complete(cache.get(cache_key))
                if cached is not None:
                    logger.debug(f"缓存命中: {cache_key}")
                    return cached
            except:
                pass
            
            # 执行函数
            result = func(*args, **kwargs)
            
            # 写入缓存
            try:
                loop = asyncio.get_event_loop()
                loop.run_until_complete(cache.set(cache_key, result, ttl=ttl))
                logger.debug(f"缓存写入: {cache_key}")
            except:
                pass
            
            return result
        
        # 根据函数类型返回合适的包装器
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper
    
    return decorator


def cache_clear(key_prefix: str):
    """
    清除缓存装饰器
    
    在函数执行后清除指定前缀的缓存
    
    Args:
        key_prefix: 要清除的缓存键前缀
        
    Returns:
        装饰器函数
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            result = await func(*args, **kwargs)
            
            # 清除缓存
            await cache.clear()
            logger.debug(f"缓存清除: {key_prefix}")
            
            return result
        
        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            result = func(*args, **kwargs)
            
            # 清除缓存
            try:
                loop = asyncio.get_event_loop()
                loop.run_until_complete(cache.clear())
                logger.debug(f"缓存清除: {key_prefix}")
            except:
                pass
            
            return result
        
        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper
    
    return decorator


class CacheManager:
    """缓存管理器"""
    
    @staticmethod
    async def get(key: str) -> Optional[Any]:
        """获取缓存"""
        return await cache.get(key)
    
    @staticmethod
    async def set(key: str, value: Any, ttl: int = 3600):
        """设置缓存"""
        await cache.set(key, value, ttl=ttl)
    
    @staticmethod
    async def delete(key: str):
        """删除缓存"""
        await cache.delete(key)
    
    @staticmethod
    async def clear():
        """清空所有缓存"""
        await cache.clear()
        logger.info("缓存已清空")
    
    @staticmethod
    async def clear_prefix(prefix: str):
        """清空指定前缀的缓存"""
        # 内存缓存不支持前缀删除，直接清空所有
        await cache.clear()
        logger.info(f"缓存前缀 {prefix} 已清空")


# 全局缓存管理器实例
cache_manager = CacheManager()
