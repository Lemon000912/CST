#!/usr/bin/env python3
"""
系统健康检查脚本
"""

import asyncio
import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.database import check_db_connection, redis_cache
from core.config import settings


async def check_postgresql():
    """检查PostgreSQL连接"""
    try:
        result = await check_db_connection()
        if result:
            print("[OK] PostgreSQL: Connected")
            return True
        else:
            print("[FAIL] PostgreSQL: Connection failed")
            return False
    except Exception as e:
        print(f"[FAIL] PostgreSQL: {e}")
        return False


async def check_redis():
    """检查Redis连接"""
    try:
        await redis_cache.connect()
        if redis_cache._connected:
            print("[OK] Redis: Connected")
            await redis_cache.close()
            return True
        else:
            print("[WARN] Redis: Not connected (using memory cache)")
            return True  # 非致命错误
    except Exception as e:
        print(f"[WARN] Redis: {e} (using memory cache)")
        return True


def check_environment():
    """检查环境变量"""
    required_vars = ['DB_TYPE']
    missing = []
    
    for var in required_vars:
        if not getattr(settings, var, None):
            missing.append(var)
    
    if missing:
        print(f"[FAIL] Missing environment variables: {', '.join(missing)}")
        return False
    
    print("[OK] Environment variables: OK")
    return True


def check_directories():
    """检查必要目录"""
    dirs = ['data', 'logs']
    all_exist = True
    
    for d in dirs:
        if os.path.exists(d):
            print(f"[OK] Directory '{d}': Exists")
        else:
            print(f"[WARN] Directory '{d}': Missing (will be created)")
            os.makedirs(d, exist_ok=True)
    
    return all_exist


async def main():
    print("=" * 60)
    print("Material KB - Health Check")
    print("=" * 60)
    
    checks = []
    
    # 环境变量
    print("\n[1/4] Checking environment variables...")
    checks.append(check_environment())
    
    # 目录
    print("\n[2/4] Checking directories...")
    checks.append(check_directories())
    
    # PostgreSQL
    print("\n[3/4] Checking PostgreSQL...")
    checks.append(await check_postgresql())
    
    # Redis
    print("\n[4/4] Checking Redis...")
    checks.append(await check_redis())
    
    # 结果
    print("\n" + "=" * 60)
    if all(checks):
        print("[OK] All checks passed!")
    else:
        print("[FAIL] Some checks failed!")
    print("=" * 60)
    
    return 0 if all(checks) else 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
