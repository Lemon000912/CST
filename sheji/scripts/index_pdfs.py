"""
PDF文献索引工具

用于扫描和索引15万PDF文献
"""

import asyncio
import sys
import os
import hashlib
from pathlib import Path
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.config import settings
from core.database import AsyncSessionLocal, init_db
from core.logging import get_logger
from dal.pdf_index_dal import pdf_index_dal
from utils.helpers import generate_id

logger = get_logger("index_pdfs")


def calculate_file_hash(file_path: str) -> str:
    """
    计算文件MD5哈希
    
    Args:
        file_path: 文件路径
        
    Returns:
        MD5哈希值
    """
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()


def get_file_size(file_path: str) -> int:
    """
    获取文件大小
    
    Args:
        file_path: 文件路径
        
    Returns:
        文件大小（字节）
    """
    return os.path.getsize(file_path)


def scan_pdf_files(storage_path: str) -> list:
    """
    扫描PDF文件
    
    Args:
        storage_path: 存储路径
        
    Returns:
        PDF文件列表
    """
    pdf_files = []
    storage = Path(storage_path)
    
    if not storage.exists():
        logger.error(f"PDF存储路径不存在: {storage_path}")
        return pdf_files
    
    logger.info(f"开始扫描PDF文件: {storage_path}")
    
    # 递归扫描所有PDF文件
    for pdf_file in storage.rglob("*.pdf"):
        try:
            relative_path = str(pdf_file.relative_to(storage))
            pdf_files.append({
                "filename": pdf_file.name,
                "relative_path": relative_path,
                "full_path": str(pdf_file),
                "file_size": get_file_size(str(pdf_file))
            })
        except Exception as e:
            logger.warning(f"扫描文件失败 {pdf_file}: {e}")
    
    logger.info(f"扫描完成: 找到 {len(pdf_files)} 个PDF文件")
    return pdf_files


async def index_pdf_files(
    pdf_files: list,
    batch_size: int = 100
) -> dict:
    """
    索引PDF文件
    
    Args:
        pdf_files: PDF文件列表
        batch_size: 批量大小
        
    Returns:
        索引统计信息
    """
    stats = {
        "total": len(pdf_files),
        "indexed": 0,
        "skipped": 0,
        "failed": 0
    }
    
    async with AsyncSessionLocal() as session:
        for i in range(0, len(pdf_files), batch_size):
            batch = pdf_files[i:i + batch_size]
            
            # 准备批量插入数据
            records = []
            for pdf_info in batch:
                try:
                    # 计算文件哈希
                    file_hash = calculate_file_hash(pdf_info["full_path"])
                    
                    # 检查是否已存在
                    existing = await pdf_index_dal.get_by_file_hash(session, file_hash)
                    if existing:
                        stats["skipped"] += 1
                        continue
                    
                    # 创建记录
                    record = {
                        "filename": pdf_info["filename"],
                        "relative_path": pdf_info["relative_path"],
                        "file_size": pdf_info["file_size"],
                        "file_hash": file_hash,
                        "is_processed": False,
                        "is_indexed": False
                    }
                    records.append(record)
                    
                except Exception as e:
                    logger.warning(f"处理文件失败 {pdf_info['filename']}: {e}")
                    stats["failed"] += 1
            
            # 批量插入
            if records:
                try:
                    inserted = await pdf_index_dal.batch_insert(session, records)
                    await session.commit()
                    stats["indexed"] += inserted
                    
                    logger.info(
                        f"索引进度: {stats['indexed']}/{stats['total']} "
                        f"({stats['indexed'] / stats['total'] * 100:.1f}%)"
                    )
                    
                except Exception as e:
                    logger.error(f"批量插入失败: {e}")
                    await session.rollback()
                    stats["failed"] += len(records)
    
    return stats


async def update_pdf_metadata(
    pdf_id: str,
    metadata: dict
) -> bool:
    """
    更新PDF元数据
    
    Args:
        pdf_id: PDF索引ID
        metadata: 元数据字典
        
    Returns:
        是否成功
    """
    async with AsyncSessionLocal() as session:
        try:
            success = await pdf_index_dal.update_metadata(session, pdf_id, metadata)
            await session.commit()
            return success
        except Exception as e:
            logger.error(f"更新元数据失败: {e}")
            await session.rollback()
            return False


async def show_index_stats():
    """显示索引统计信息"""
    async with AsyncSessionLocal() as session:
        stats = await pdf_index_dal.get_statistics(session)
        
        print("\n📊 PDF索引统计")
        print("=" * 50)
        print(f"总文件数: {stats['total']}")
        print(f"已处理: {stats['processed']}")
        print(f"未处理: {stats['unprocessed']}")
        print(f"已索引: {stats['indexed']}")
        print(f"未索引: {stats['unindexed']}")
        print(f"有DOI: {stats['with_doi']}")
        print(f"总大小: {stats['total_size_mb']} MB")
        
        if stats['top_years']:
            print("\n年份分布:")
            for year_info in stats['top_years']:
                print(f"  {year_info['year']}: {year_info['count']} 篇")


async def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(description="PDF文献索引工具")
    parser.add_argument(
        "command",
        choices=["scan", "index", "stats", "reset"],
        help="要执行的命令"
    )
    parser.add_argument(
        "--path",
        default=settings.PDF_STORAGE_PATH,
        help="PDF存储路径"
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=100,
        help="批量大小"
    )
    
    args = parser.parse_args()
    
    if args.command == "scan":
        # 仅扫描，不索引
        pdf_files = scan_pdf_files(args.path)
        print(f"\n扫描结果:")
        print(f"  总文件数: {len(pdf_files)}")
        if pdf_files:
            total_size = sum(f["file_size"] for f in pdf_files)
            print(f"  总大小: {total_size / 1024 / 1024 / 1024:.2f} GB")
            print(f"  平均大小: {total_size / len(pdf_files) / 1024:.2f} KB")
    
    elif args.command == "index":
        # 扫描并索引
        print("🔍 开始扫描PDF文件...")
        pdf_files = scan_pdf_files(args.path)
        
        if not pdf_files:
            print("⚠️ 未找到PDF文件")
            return
        
        print(f"\n📑 开始索引 {len(pdf_files)} 个PDF文件...")
        stats = await index_pdf_files(pdf_files, args.batch_size)
        
        print("\n✅ 索引完成!")
        print(f"  总计: {stats['total']}")
        print(f"  已索引: {stats['indexed']}")
        print(f"  已跳过: {stats['skipped']}")
        print(f"  失败: {stats['failed']}")
    
    elif args.command == "stats":
        # 显示统计信息
        await show_index_stats()
    
    elif args.command == "reset":
        # 重置索引
        print("⚠️ 警告: 这将清空所有PDF索引！")
        confirm = input("确认重置? (yes/no): ")
        
        if confirm.lower() == "yes":
            async with AsyncSessionLocal() as session:
                from sqlalchemy import text
                await session.execute(text("TRUNCATE TABLE pdf_index"))
                await session.commit()
            print("✅ PDF索引已重置")
        else:
            print("操作已取消")


if __name__ == "__main__":
    asyncio.run(main())
