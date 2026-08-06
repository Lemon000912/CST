from typing import Optional, List, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text, desc, func

from dal.base import BaseDAL
from models.database import PDFIndex
from core.logging import get_logger

logger = get_logger("pdf_index_dal")


class PDFIndexDAL(BaseDAL[PDFIndex]):
    """PDF文献索引数据访问层"""
    
    def __init__(self):
        super().__init__(PDFIndex)
    
    async def get_by_filename(
        self,
        session: AsyncSession,
        filename: str
    ) -> Optional[PDFIndex]:
        """
        根据文件名获取索引
        
        Args:
            session: 数据库会话
            filename: 文件名
            
        Returns:
            索引对象或None
        """
        result = await session.execute(
            select(PDFIndex).where(PDFIndex.filename == filename)
        )
        return result.scalar_one_or_none()
    
    async def get_by_file_hash(
        self,
        session: AsyncSession,
        file_hash: str
    ) -> Optional[PDFIndex]:
        """
        根据文件哈希获取索引
        
        Args:
            session: 数据库会话
            file_hash: 文件哈希
            
        Returns:
            索引对象或None
        """
        result = await session.execute(
            select(PDFIndex).where(PDFIndex.file_hash == file_hash)
        )
        return result.scalar_one_or_none()
    
    async def search_by_title(
        self,
        session: AsyncSession,
        title: str,
        limit: int = 50
    ) -> List[PDFIndex]:
        """
        根据标题搜索
        
        Args:
            session: 数据库会话
            title: 标题关键词
            limit: 最大数量
            
        Returns:
            索引列表
        """
        result = await session.execute(
            select(PDFIndex)
            .where(PDFIndex.title.like(f"%{title}%"))
            .order_by(desc(PDFIndex.publish_year))
            .limit(limit)
        )
        return result.scalars().all()
    
    async def get_unprocessed(
        self,
        session: AsyncSession,
        limit: int = 100
    ) -> List[PDFIndex]:
        """
        获取未处理的PDF
        
        Args:
            session: 数据库会话
            limit: 最大数量
            
        Returns:
            索引列表
        """
        result = await session.execute(
            select(PDFIndex)
            .where(PDFIndex.is_processed == False)
            .limit(limit)
        )
        return result.scalars().all()
    
    async def get_unindexed(
        self,
        session: AsyncSession,
        limit: int = 100
    ) -> List[PDFIndex]:
        """
        获取未建立索引的PDF
        
        Args:
            session: 数据库会话
            limit: 最大数量
            
        Returns:
            索引列表
        """
        result = await session.execute(
            select(PDFIndex)
            .where(PDFIndex.is_indexed == False)
            .limit(limit)
        )
        return result.scalars().all()
    
    async def mark_as_processed(
        self,
        session: AsyncSession,
        pdf_id: str
    ) -> bool:
        """
        标记为已处理
        
        Args:
            session: 数据库会话
            pdf_id: PDF索引ID
            
        Returns:
            是否成功
        """
        from datetime import datetime
        
        result = await session.execute(
            text("""
                UPDATE pdf_index
                SET is_processed = TRUE,
                    process_time = :now
                WHERE id = :pdf_id
            """),
            {"pdf_id": pdf_id, "now": datetime.utcnow()}
        )
        
        return result.rowcount > 0
    
    async def mark_as_indexed(
        self,
        session: AsyncSession,
        pdf_id: str
    ) -> bool:
        """
        标记为已索引
        
        Args:
            session: 数据库会话
            pdf_id: PDF索引ID
            
        Returns:
            是否成功
        """
        result = await session.execute(
            text("""
                UPDATE pdf_index
                SET is_indexed = TRUE
                WHERE id = :pdf_id
            """),
            {"pdf_id": pdf_id}
        )
        
        return result.rowcount > 0
    
    async def update_metadata(
        self,
        session: AsyncSession,
        pdf_id: str,
        metadata: Dict[str, Any]
    ) -> bool:
        """
        更新PDF元数据
        
        Args:
            session: 数据库会话
            pdf_id: PDF索引ID
            metadata: 元数据字典
            
        Returns:
            是否成功
        """
        import json
        
        # 构建更新字段
        update_fields = []
        params = {"pdf_id": pdf_id}
        
        if "title" in metadata:
            update_fields.append("title = :title")
            params["title"] = metadata["title"]
        
        if "authors" in metadata:
            update_fields.append("authors = :authors")
            params["authors"] = json.dumps(metadata["authors"], ensure_ascii=False)
        
        if "doi" in metadata:
            update_fields.append("doi = :doi")
            params["doi"] = metadata["doi"]
        
        if "abstract" in metadata:
            update_fields.append("abstract = :abstract")
            params["abstract"] = metadata["abstract"]
        
        if "keywords" in metadata:
            update_fields.append("keywords = :keywords")
            params["keywords"] = json.dumps(metadata["keywords"], ensure_ascii=False)
        
        if "publish_year" in metadata:
            update_fields.append("publish_year = :publish_year")
            params["publish_year"] = metadata["publish_year"]
        
        if not update_fields:
            return True
        
        sql = f"""
            UPDATE pdf_index
            SET {', '.join(update_fields)}
            WHERE id = :pdf_id
        """
        
        result = await session.execute(text(sql), params)
        return result.rowcount > 0
    
    async def get_statistics(
        self,
        session: AsyncSession
    ) -> Dict[str, Any]:
        """
        获取PDF索引统计信息
        
        Args:
            session: 数据库会话
            
        Returns:
            统计信息字典
        """
        # 总数量
        total_result = await session.execute(
            select(func.count()).select_from(PDFIndex)
        )
        total = total_result.scalar()
        
        # 已处理数量
        processed_result = await session.execute(
            select(func.count()).select_from(PDFIndex).where(PDFIndex.is_processed == True)
        )
        processed = processed_result.scalar()
        
        # 已索引数量
        indexed_result = await session.execute(
            select(func.count()).select_from(PDFIndex).where(PDFIndex.is_indexed == True)
        )
        indexed = indexed_result.scalar()
        
        # 有DOI的数量
        doi_result = await session.execute(
            select(func.count()).select_from(PDFIndex).where(PDFIndex.doi.isnot(None))
        )
        with_doi = doi_result.scalar()
        
        # 总文件大小
        size_result = await session.execute(
            select(func.sum(PDFIndex.file_size)).select_from(PDFIndex)
        )
        total_size = size_result.scalar() or 0
        
        # 年份分布
        year_result = await session.execute(
            select(PDFIndex.publish_year, func.count().label("count"))
            .where(PDFIndex.publish_year.isnot(None))
            .group_by(PDFIndex.publish_year)
            .order_by(desc("count"))
            .limit(10)
        )
        years = [{"year": row[0], "count": row[1]} for row in year_result.fetchall()]
        
        return {
            "total": total,
            "processed": processed,
            "unprocessed": total - processed,
            "indexed": indexed,
            "unindexed": total - indexed,
            "with_doi": with_doi,
            "without_doi": total - with_doi,
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "top_years": years
        }
    
    async def batch_insert(
        self,
        session: AsyncSession,
        records: List[Dict[str, Any]]
    ) -> int:
        """
        批量插入PDF索引
        
        Args:
            session: 数据库会话
            records: 记录列表
            
        Returns:
            插入数量
        """
        import json
        from utils.helpers import generate_id
        
        inserted = 0
        for record in records:
            try:
                # 检查是否已存在
                existing = await self.get_by_file_hash(session, record.get("file_hash", ""))
                if existing:
                    continue
                
                # 创建新记录
                record["id"] = generate_id()
                
                # 序列化JSON字段
                if "authors" in record and isinstance(record["authors"], list):
                    record["authors"] = json.dumps(record["authors"], ensure_ascii=False)
                if "keywords" in record and isinstance(record["keywords"], list):
                    record["keywords"] = json.dumps(record["keywords"], ensure_ascii=False)
                
                instance = PDFIndex(**record)
                session.add(instance)
                inserted += 1
                
            except Exception as e:
                logger.warning(f"插入PDF索引失败: {e}")
                continue
        
        await session.flush()
        logger.info(f"批量插入PDF索引: {inserted} 条")
        return inserted


# 全局实例
pdf_index_dal = PDFIndexDAL()
