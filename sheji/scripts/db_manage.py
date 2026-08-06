"""
数据库管理脚本

提供数据库迁移、备份、恢复等功能
"""

import asyncio
import sys
import os
import argparse
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text
from core.database import engine, init_db, drop_db, check_db_connection
from core.config import settings
from core.logging import get_logger

logger = get_logger("db_manage")


async def create_backup():
    """创建数据库备份"""
    try:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = f"backup_{settings.MYSQL_DATABASE}_{timestamp}.sql"
        
        # 使用mysqldump创建备份
        import subprocess
        
        cmd = [
            "mysqldump",
            "-h", settings.MYSQL_HOST,
            "-P", str(settings.MYSQL_PORT),
            "-u", settings.MYSQL_USER,
            f"-p{settings.MYSQL_PASSWORD}",
            settings.MYSQL_DATABASE
        ]
        
        with open(backup_file, "w", encoding="utf-8") as f:
            subprocess.run(cmd, stdout=f, check=True)
        
        print(f"✅ 数据库备份完成: {backup_file}")
        return True
        
    except Exception as e:
        print(f"❌ 备份失败: {e}")
        return False


async def restore_backup(backup_file: str):
    """恢复数据库备份"""
    try:
        if not os.path.exists(backup_file):
            print(f"❌ 备份文件不存在: {backup_file}")
            return False
        
        import subprocess
        
        cmd = [
            "mysql",
            "-h", settings.MYSQL_HOST,
            "-P", str(settings.MYSQL_PORT),
            "-u", settings.MYSQL_USER,
            f"-p{settings.MYSQL_PASSWORD}",
            settings.MYSQL_DATABASE
        ]
        
        with open(backup_file, "r", encoding="utf-8") as f:
            subprocess.run(cmd, stdin=f, check=True)
        
        print(f"✅ 数据库恢复完成: {backup_file}")
        return True
        
    except Exception as e:
        print(f"❌ 恢复失败: {e}")
        return False


async def reset_database():
    """重置数据库（删除所有数据）"""
    try:
        print("⚠️ 警告: 这将删除所有数据！")
        confirm = input("确认重置数据库? (yes/no): ")
        
        if confirm.lower() != "yes":
            print("操作已取消")
            return False
        
        # 先备份
        print("正在备份...")
        await create_backup()
        
        # 删除并重新创建表
        await drop_db()
        await init_db()
        
        print("✅ 数据库重置完成")
        return True
        
    except Exception as e:
        print(f"❌ 重置失败: {e}")
        return False


async def show_statistics():
    """显示数据库统计信息"""
    try:
        from sqlalchemy import text
        from core.database import AsyncSessionLocal
        
        async with AsyncSessionLocal() as session:
            # 获取所有表
            result = await session.execute(text("""
                SELECT table_name, table_rows, data_length, index_length
                FROM information_schema.tables
                WHERE table_schema = :db_name
                ORDER BY table_name
            """), {"db_name": settings.MYSQL_DATABASE})
            
            rows = result.fetchall()
            
            print("\n📊 数据库统计信息")
            print("=" * 80)
            print(f"{'表名':<30} {'记录数':<10} {'数据大小':<15} {'索引大小':<15}")
            print("-" * 80)
            
            total_rows = 0
            total_data = 0
            total_index = 0
            
            for row in rows:
                table_name = row[0]
                table_rows = row[1] or 0
                data_length = row[2] or 0
                index_length = row[3] or 0
                
                total_rows += table_rows
                total_data += data_length
                total_index += index_length
                
                print(f"{table_name:<30} {table_rows:<10} {data_length/1024/1024:>10.2f} MB {index_length/1024/1024:>10.2f} MB")
            
            print("-" * 80)
            print(f"{'总计':<30} {total_rows:<10} {total_data/1024/1024:>10.2f} MB {total_index/1024/1024:>10.2f} MB")
            print("=" * 80)
            
    except Exception as e:
        print(f"❌ 获取统计信息失败: {e}")


async def check_tables():
    """检查数据库表结构"""
    try:
        from core.database import AsyncSessionLocal
        
        async with AsyncSessionLocal() as session:
            # 检查所有表是否存在
            result = await session.execute(text("""
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = :db_name
            """), {"db_name": settings.MYSQL_DATABASE})
            
            existing_tables = {row[0] for row in result.fetchall()}
            
            # 期望的表
            expected_tables = {
                'users', 'user_preferences', 'search_histories',
                'papers', 'authors', 'keywords',
                'paper_author', 'paper_keyword',
                'documents', 'recommendations', 'pdf_index'
            }
            
            print("\n🔍 数据库表检查")
            print("=" * 50)
            
            for table in expected_tables:
                status = "✅" if table in existing_tables else "❌"
                print(f"{status} {table}")
            
            missing = expected_tables - existing_tables
            if missing:
                print(f"\n⚠️ 缺失的表: {', '.join(missing)}")
                return False
            else:
                print("\n✅ 所有表都存在")
                return True
                
    except Exception as e:
        print(f"❌ 检查失败: {e}")
        return False


def main():
    """主函数"""
    parser = argparse.ArgumentParser(description="数据库管理工具")
    parser.add_argument(
        "command",
        choices=["backup", "restore", "reset", "stats", "check", "init"],
        help="要执行的命令"
    )
    parser.add_argument(
        "--file",
        help="备份文件路径（用于restore命令）"
    )
    
    args = parser.parse_args()
    
    if args.command == "backup":
        asyncio.run(create_backup())
    
    elif args.command == "restore":
        if not args.file:
            print("❌ 请指定备份文件: --file <path>")
            sys.exit(1)
        asyncio.run(restore_backup(args.file))
    
    elif args.command == "reset":
        asyncio.run(reset_database())
    
    elif args.command == "stats":
        asyncio.run(show_statistics())
    
    elif args.command == "check":
        asyncio.run(check_tables())
    
    elif args.command == "init":
        from scripts.init_db import main as init_main
        asyncio.run(init_main())


if __name__ == "__main__":
    main()
