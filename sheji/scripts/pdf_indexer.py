#!/usr/bin/env python3
"""
PDF文献批量索引脚本
用于扫描和索引15万本地PDF文献

使用方法:
    python pdf_indexer.py --scan /path/to/pdf/library
    python pdf_indexer.py --index-all
    python pdf_indexer.py --stats
"""

import asyncio
import os
import sys
import hashlib
import json
import argparse
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from core.database import AsyncSessionLocal
from models.database import PDFIndex, MaterialCategory
from core.config import settings
from core.logging import get_logger

logger = get_logger("pdf_indexer")

# 9大领域关键词映射（用于自动分类）
CATEGORY_KEYWORDS = {
    'alloy_metallic': ['合金', '金属', '钢铁', '铝合金', '钛合金', '镁合金', '铜合金', 'alloy', 'metallic'],
    'amorphous_glass': ['非晶', '玻璃', '金属玻璃', 'amorphous', 'glass', 'vitreous'],
    'ceramic_structural': ['陶瓷', '氧化物', '氮化物', '碳化物', 'ceramic', 'oxide', 'nitride'],
    'composite_multiphase': ['复合', '增强', '基体', '纤维', 'composite', 'reinforced', 'matrix'],
    'nanomaterials_lowdim': ['纳米', '石墨烯', '纳米线', '纳米管', 'nanomaterial', 'graphene', 'nanowire', 'nanotube'],
    'optical_optoelectronic': ['光电', '半导体', '光伏', '发光', 'optoelectronic', 'semiconductor', 'photovoltaic'],
    'polymer_soft_matter': ['高分子', '聚合物', '塑料', '橡胶', 'polymer', 'plastic', 'rubber'],
    'solid_state_ionic': ['固态电解质', '离子', '电池', '燃料电池', 'solid electrolyte', 'ionic', 'battery'],
    'surface_thin_film': ['薄膜', '涂层', '表面', '界面', 'thin film', 'coating', 'surface']
}


def generate_id():
    return str(uuid.uuid4())


def calculate_file_hash(filepath: str) -> str:
    """计算文件MD5哈希"""
    hash_md5 = hashlib.md5()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()


def detect_category_from_filename(filename: str) -> Optional[str]:
    """从文件名检测领域分类"""
    filename_lower = filename.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        for keyword in keywords:
            if keyword.lower() in filename_lower:
                return category
    return None


def extract_year_from_filename(filename: str) -> Optional[int]:
    """从文件名提取年份"""
    import re
    # 匹配4位数字年份 (1900-2099)
    match = re.search(r'(19|20)\d{2}', filename)
    if match:
        year = int(match.group())
        if 1900 <= year <= 2099:
            return year
    return None


class PDFIndexer:
    """PDF文献索引器"""
    
    def __init__(self, pdf_storage_path: str):
        self.pdf_storage_path = Path(pdf_storage_path)
        self.stats = {
            'total_scanned': 0,
            'total_indexed': 0,
            'total_skipped': 0,
            'total_errors': 0,
            'by_category': {},
            'by_year': {}
        }
    
    async def scan_and_index(self, dry_run: bool = False) -> Dict:
        """
        扫描PDF目录并建立索引
        
        Args:
            dry_run: 如果为True，只扫描不写入数据库
        """
        logger.info(f"开始扫描目录: {self.pdf_storage_path}")
        
        if not self.pdf_storage_path.exists():
            logger.error(f"目录不存在: {self.pdf_storage_path}")
            return self.stats
        
        pdf_files = list(self.pdf_storage_path.rglob("*.pdf"))
        logger.info(f"找到 {len(pdf_files)} 个PDF文件")
        
        if not pdf_files:
            return self.stats
        
        # 分批处理
        batch_size = 1000
        for i in range(0, len(pdf_files), batch_size):
            batch = pdf_files[i:i + batch_size]
            await self._process_batch(batch, dry_run)
            logger.info(f"已处理 {min(i + batch_size, len(pdf_files))}/{len(pdf_files)} 个文件")
        
        return self.stats
    
    async def _process_batch(self, pdf_files: List[Path], dry_run: bool):
        """处理一批PDF文件"""
        async with AsyncSessionLocal() as session:
            for pdf_path in pdf_files:
                try:
                    await self._index_single_pdf(session, pdf_path, dry_run)
                    self.stats['total_scanned'] += 1
                except Exception as e:
                    logger.error(f"处理文件失败 {pdf_path}: {e}")
                    self.stats['total_errors'] += 1
            
            if not dry_run:
                await session.commit()
    
    async def _index_single_pdf(self, session: AsyncSession, pdf_path: Path, dry_run: bool):
        """索引单个PDF文件"""
        relative_path = str(pdf_path.relative_to(self.pdf_storage_path))
        filename = pdf_path.name
        
        # 检查是否已索引
        result = await session.execute(
            select(PDFIndex).where(PDFIndex.file_hash == calculate_file_hash(str(pdf_path)))
        )
        if result.scalar_one_or_none():
            self.stats['total_skipped'] += 1
            return
        
        # 自动检测分类
        category = detect_category_from_filename(filename)
        year = extract_year_from_filename(filename)
        
        # 更新统计
        if category:
            self.stats['by_category'][category] = self.stats['by_category'].get(category, 0) + 1
        if year:
            self.stats['by_year'][year] = self.stats['by_year'].get(year, 0) + 1
        
        if dry_run:
            self.stats['total_indexed'] += 1
            return
        
        # 创建索引记录
        pdf_index = PDFIndex(
            id=generate_id(),
            filename=filename,
            relative_path=relative_path,
            file_size=pdf_path.stat().st_size,
            file_hash=calculate_file_hash(str(pdf_path)),
            title=filename.replace('.pdf', ''),
            publish_year=year,
            category=category,
            is_processed=False,
            is_indexed=True
        )
        session.add(pdf_index)
        self.stats['total_indexed'] += 1
    
    async def get_stats(self) -> Dict:
        """获取索引统计信息"""
        async with AsyncSessionLocal() as session:
            # 总索引数
            result = await session.execute(select(func.count()).select_from(PDFIndex))
            total_indexed = result.scalar()
            
            # 已处理数
            result = await session.execute(
                select(func.count()).select_from(PDFIndex).where(PDFIndex.is_processed == True)
            )
            total_processed = result.scalar()
            
            # 按领域统计
            result = await session.execute(
                select(PDFIndex.category, func.count())
                .group_by(PDFIndex.category)
            )
            category_stats = {cat: count for cat, count in result.all()}
            
            # 按年份统计
            result = await session.execute(
                select(PDFIndex.publish_year, func.count())
                .where(PDFIndex.publish_year.isnot(None))
                .group_by(PDFIndex.publish_year)
                .order_by(PDFIndex.publish_year)
            )
            year_stats = {str(year): count for year, count in result.all()}
            
            return {
                'total_indexed': total_indexed,
                'total_processed': total_processed,
                'total_unprocessed': total_indexed - total_processed,
                'by_category': category_stats,
                'by_year': year_stats,
                'storage_path': str(self.pdf_storage_path)
            }
    
    async def update_metadata(self, pdf_id: str, metadata: Dict):
        """更新PDF元数据（11个要素）"""
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(PDFIndex).where(PDFIndex.id == pdf_id)
            )
            pdf = result.scalar_one_or_none()
            
            if not pdf:
                return False
            
            # 更新11个要素
            pdf.material_name = metadata.get('material_name')
            pdf.symmetry_phase = metadata.get('symmetry_phase')
            pdf.structure_descriptor = metadata.get('structure_descriptor')
            pdf.properties = metadata.get('properties')
            pdf.applications = metadata.get('applications')
            pdf.synthesis_method = metadata.get('synthesis_method')
            pdf.characterization_method = metadata.get('characterization_method')
            pdf.quality_control = metadata.get('quality_control')
            pdf.first_author = metadata.get('first_author')
            pdf.doi = metadata.get('doi')
            pdf.corresponding_author = metadata.get('corresponding_author')
            pdf.is_processed = True
            pdf.process_time = datetime.utcnow()
            
            await session.commit()
            return True


def print_stats(stats: Dict):
    """打印统计信息"""
    print("\n" + "=" * 60)
    print("PDF文献索引统计")
    print("=" * 60)
    print(f"总索引数: {stats.get('total_indexed', 0)}")
    print(f"已处理: {stats.get('total_processed', 0)}")
    print(f"待处理: {stats.get('total_unprocessed', 0)}")
    print(f"存储路径: {stats.get('storage_path', 'N/A')}")
    
    if stats.get('by_category'):
        print("\n按领域分布:")
        for cat, count in sorted(stats['by_category'].items()):
            print(f"  {cat}: {count}")
    
    if stats.get('by_year'):
        print("\n按年份分布:")
        for year, count in sorted(stats['by_year'].items()):
            print(f"  {year}: {count}")
    
    print("=" * 60)


async def main():
    parser = argparse.ArgumentParser(description='PDF文献批量索引工具')
    parser.add_argument('--scan', type=str, help='扫描指定目录的PDF文件')
    parser.add_argument('--index-all', action='store_true', help='索引所有PDF文件')
    parser.add_argument('--stats', action='store_true', help='显示索引统计')
    parser.add_argument('--dry-run', action='store_true', help='模拟运行，不写入数据库')
    parser.add_argument('--path', type=str, default=settings.PDF_STORAGE_PATH, help='PDF存储路径')
    
    args = parser.parse_args()
    
    indexer = PDFIndexer(args.path)
    
    if args.scan or args.index_all:
        print(f"开始扫描: {args.path}")
        stats = await indexer.scan_and_index(dry_run=args.dry_run)
        print(f"\n扫描完成!")
        print(f"  扫描: {stats['total_scanned']}")
        print(f"  索引: {stats['total_indexed']}")
        print(f"  跳过: {stats['total_skipped']}")
        print(f"  错误: {stats['total_errors']}")
    
    elif args.stats:
        stats = await indexer.get_stats()
        print_stats(stats)
    
    else:
        parser.print_help()


if __name__ == "__main__":
    asyncio.run(main())
