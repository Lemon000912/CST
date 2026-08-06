from typing import Optional, List, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text, desc, func

from dal.base import BaseDAL
from models.database import Paper, Author, Keyword
from core.logging import get_logger

logger = get_logger("paper_dal")


class PaperDAL(BaseDAL[Paper]):
    """论文数据访问层"""
    
    def __init__(self):
        super().__init__(Paper)
    
    async def get_by_doi(
        self,
        session: AsyncSession,
        doi: str
    ) -> Optional[Paper]:
        """
        根据DOI获取论文
        
        Args:
            session: 数据库会话
            doi: DOI编号
            
        Returns:
            论文对象或None
        """
        result = await session.execute(
            select(Paper).where(Paper.doi == doi)
        )
        return result.scalar_one_or_none()
    
    async def search_by_title(
        self,
        session: AsyncSession,
        title: str,
        limit: int = 20
    ) -> List[Paper]:
        """
        根据标题搜索论文
        
        Args:
            session: 数据库会话
            title: 标题关键词
            limit: 最大数量
            
        Returns:
            论文列表
        """
        result = await session.execute(
            select(Paper)
            .where(Paper.title.like(f"%{title}%"))
            .order_by(desc(Paper.relevance_score))
            .limit(limit)
        )
        return result.scalars().all()
    
    async def search_fulltext(
        self,
        session: AsyncSession,
        query: str,
        limit: int = 50
    ) -> List[Paper]:
        """
        全文搜索论文
        
        使用MySQL全文索引
        
        Args:
            session: 数据库会话
            query: 搜索查询
            limit: 最大数量
            
        Returns:
            论文列表
        """
        try:
            # 使用MySQL全文搜索
            result = await session.execute(
                text("""
                    SELECT id, title, abstract, doi, url, pdf_path,
                           publish_date, journal, citation_count,
                           relevance_score, credibility_score
                    FROM papers
                    WHERE MATCH(title, abstract) AGAINST(:query IN NATURAL LANGUAGE MODE)
                    ORDER BY relevance_score DESC
                    LIMIT :limit
                """),
                {"query": query, "limit": limit}
            )
            
            rows = result.fetchall()
            papers = []
            for row in rows:
                paper = Paper(
                    id=row[0],
                    title=row[1],
                    abstract=row[2],
                    doi=row[3],
                    url=row[4],
                    pdf_path=row[5],
                    publish_date=row[6],
                    journal=row[7],
                    citation_count=row[8],
                    relevance_score=row[9],
                    credibility_score=row[10]
                )
                papers.append(paper)
            
            return papers
            
        except Exception as e:
            logger.warning(f"全文搜索失败，回退到普通搜索: {e}")
            # 回退到普通LIKE搜索
            return await self.search_by_title(session, query, limit)
    
    async def get_by_journal(
        self,
        session: AsyncSession,
        journal: str,
        skip: int = 0,
        limit: int = 20
    ) -> List[Paper]:
        """
        根据期刊获取论文
        
        Args:
            session: 数据库会话
            journal: 期刊名
            skip: 跳过数量
            limit: 最大数量
            
        Returns:
            论文列表
        """
        result = await session.execute(
            select(Paper)
            .where(Paper.journal == journal)
            .order_by(desc(Paper.publish_date))
            .offset(skip)
            .limit(limit)
        )
        return result.scalars().all()
    
    async def get_top_cited(
        self,
        session: AsyncSession,
        limit: int = 20
    ) -> List[Paper]:
        """
        获取高引用论文
        
        Args:
            session: 数据库会话
            limit: 最大数量
            
        Returns:
            论文列表
        """
        result = await session.execute(
            select(Paper)
            .order_by(desc(Paper.citation_count))
            .limit(limit)
        )
        return result.scalars().all()
    
    async def get_recent(
        self,
        session: AsyncSession,
        days: int = 30,
        limit: int = 20
    ) -> List[Paper]:
        """
        获取最近添加的论文
        
        Args:
            session: 数据库会话
            days: 最近天数
            limit: 最大数量
            
        Returns:
            论文列表
        """
        from datetime import datetime, timedelta
        
        cutoff_date = datetime.utcnow() - timedelta(days=days)
        
        result = await session.execute(
            select(Paper)
            .where(Paper.created_at >= cutoff_date)
            .order_by(desc(Paper.created_at))
            .limit(limit)
        )
        return result.scalars().all()
    
    async def update_citation_count(
        self,
        session: AsyncSession,
        paper_id: str,
        count: int
    ) -> bool:
        """
        更新引用次数
        
        Args:
            session: 数据库会话
            paper_id: 论文ID
            count: 引用次数
            
        Returns:
            是否更新成功
        """
        result = await session.execute(
            text("""
                UPDATE papers
                SET citation_count = :count
                WHERE id = :paper_id
            """),
            {"paper_id": paper_id, "count": count}
        )
        
        return result.rowcount > 0
    
    async def get_statistics(
        self,
        session: AsyncSession
    ) -> Dict[str, Any]:
        """
        获取论文统计信息
        
        Args:
            session: 数据库会话
            
        Returns:
            统计信息字典
        """
        # 总数量
        total_result = await session.execute(
            select(func.count()).select_from(Paper)
        )
        total = total_result.scalar()
        
        # 有DOI的数量
        doi_result = await session.execute(
            select(func.count()).select_from(Paper).where(Paper.doi.isnot(None))
        )
        with_doi = doi_result.scalar()
        
        # 平均引用次数
        avg_citation_result = await session.execute(
            select(func.avg(Paper.citation_count)).select_from(Paper)
        )
        avg_citation = avg_citation_result.scalar() or 0
        
        # 期刊分布（前10）
        journal_result = await session.execute(
            select(Paper.journal, func.count().label("count"))
            .group_by(Paper.journal)
            .order_by(desc("count"))
            .limit(10)
        )
        journals = [{"name": row[0], "count": row[1]} for row in journal_result.fetchall()]
        
        return {
            "total": total,
            "with_doi": with_doi,
            "without_doi": total - with_doi,
            "avg_citation": round(avg_citation, 2),
            "top_journals": journals
        }


class AuthorDAL(BaseDAL[Author]):
    """作者数据访问层"""
    
    def __init__(self):
        super().__init__(Author)
    
    async def get_by_name(
        self,
        session: AsyncSession,
        name: str
    ) -> Optional[Author]:
        """
        根据姓名获取作者
        
        Args:
            session: 数据库会话
            name: 作者姓名
            
        Returns:
            作者对象或None
        """
        result = await session.execute(
            select(Author).where(Author.name == name)
        )
        return result.scalar_one_or_none()
    
    async def search_by_name(
        self,
        session: AsyncSession,
        name: str,
        limit: int = 20
    ) -> List[Author]:
        """
        根据姓名搜索作者
        
        Args:
            session: 数据库会话
            name: 姓名关键词
            limit: 最大数量
            
        Returns:
            作者列表
        """
        result = await session.execute(
            select(Author)
            .where(Author.name.like(f"%{name}%"))
            .limit(limit)
        )
        return result.scalars().all()


class KeywordDAL(BaseDAL[Keyword]):
    """关键词数据访问层"""
    
    def __init__(self):
        super().__init__(Keyword)
    
    async def get_by_word(
        self,
        session: AsyncSession,
        word: str
    ) -> Optional[Keyword]:
        """
        根据单词获取关键词
        
        Args:
            session: 数据库会话
            word: 关键词
            
        Returns:
            关键词对象或None
        """
        result = await session.execute(
            select(Keyword).where(Keyword.word == word)
        )
        return result.scalar_one_or_none()
    
    async def get_top_keywords(
        self,
        session: AsyncSession,
        limit: int = 50
    ) -> List[Keyword]:
        """
        获取热门关键词
        
        Args:
            session: 数据库会话
            limit: 最大数量
            
        Returns:
            关键词列表
        """
        result = await session.execute(
            select(Keyword)
            .order_by(desc(Keyword.frequency))
            .limit(limit)
        )
        return result.scalars().all()


# 全局实例
paper_dal = PaperDAL()
author_dal = AuthorDAL()
keyword_dal = KeywordDAL()
