#!/usr/bin/env python3
"""
PostgreSQL数据库初始化脚本
"""

import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

DB_HOST = 'localhost'
DB_PORT = 5432
DB_ADMIN_USER = 'postgres'
DB_ADMIN_PASS = '123456'

DB_NAME = 'material_kb'
DB_USER = 'material_user'
DB_PASS = 'material_pass_2024'


def create_database():
    """创建数据库和用户"""
    conn = psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_ADMIN_USER,
        password=DB_ADMIN_PASS
    )
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    cur = conn.cursor()
    
    # 检查数据库是否已存在
    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (DB_NAME,))
    if not cur.fetchone():
        cur.execute(f"CREATE DATABASE {DB_NAME} OWNER {DB_ADMIN_USER} ENCODING 'UTF8'")
        print(f"[OK] Database '{DB_NAME}' created")
    else:
        print(f"[OK] Database '{DB_NAME}' already exists")
    
    # 检查用户是否已存在
    cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (DB_USER,))
    if not cur.fetchone():
        cur.execute(f"CREATE USER {DB_USER} WITH PASSWORD '{DB_PASS}'")
        print(f"[OK] User '{DB_USER}' created")
    else:
        print(f"[OK] User '{DB_USER}' already exists")
    
    # 授权
    cur.execute(f"GRANT ALL PRIVILEGES ON DATABASE {DB_NAME} TO {DB_USER}")
    print(f"[OK] Privileges granted to '{DB_USER}'")
    
    cur.close()
    conn.close()
    print("[OK] PostgreSQL setup completed")


def test_connection():
    """测试连接"""
    conn = psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASS,
        database=DB_NAME
    )
    cur = conn.cursor()
    cur.execute("SELECT version()")
    version = cur.fetchone()[0]
    print(f"[OK] Connected to: {version}")
    cur.close()
    conn.close()


if __name__ == "__main__":
    print("=" * 60)
    print("PostgreSQL Setup for Material KB")
    print("=" * 60)
    create_database()
    test_connection()
    print("=" * 60)
