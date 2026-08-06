"""
搜索服务兼容层
提供与旧版API兼容的搜索服务接口
"""

from enum import Enum
from typing import Optional, List, Dict, Any
import random

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from core.database import AsyncSessionLocal
from models.database import Paper, PDFIndex
from core.logging import get_logger

logger = get_logger("search_service_compat")


class SearchSource(str, Enum):
    """搜索来源"""
    DATABASE = "database"
    WEB = "web"
    BOTH = "both"


class SearchServiceCompat:
    """兼容旧API的搜索服务"""
    
    async def search(
        self,
        query: str,
        source: SearchSource = SearchSource.BOTH,
        max_results: int = 50,
        filters: Optional[dict] = None
    ) -> Dict[str, Any]:
        """
        执行搜索
        
        兼容旧版search_service.search接口
        """
        results = []
        
        # 数据库搜索
        if source in [SearchSource.DATABASE, SearchSource.BOTH]:
            db_results = await self.search_database(query, max_results)
            results.extend(db_results)
        
        # 网页搜索（模拟）
        if source in [SearchSource.WEB, SearchSource.BOTH]:
            web_results = await self.search_web(query, max_results)
            results.extend(web_results)
        
        # 去重和排序
        seen = set()
        unique_results = []
        for r in results:
            key = r.get("doi") or r.get("id")
            if key and key not in seen:
                seen.add(key)
                unique_results.append(r)
        
        # 限制结果数量
        unique_results = unique_results[:max_results]
        
        return {
            "query": query,
            "source": source,
            "total": len(unique_results),
            "results": unique_results,
            "search_time": 0.5,
            "rewritten_query": query
        }
    
    async def search_database(self, query: str, max_results: int = 50) -> List[Dict[str, Any]]:
        """搜索数据库"""
        async with AsyncSessionLocal() as session:
            # 搜索PDF索引 - 使用不区分大小写的匹配
            from sqlalchemy import func
            query_lower = query.lower()
            stmt = select(PDFIndex).where(
                (func.lower(PDFIndex.title).contains(query_lower)) |
                (func.lower(PDFIndex.abstract).contains(query_lower)) |
                (func.lower(PDFIndex.material_name).contains(query_lower)) |
                (func.lower(PDFIndex.keywords).contains(query_lower))
            ).limit(max_results)
            
            result = await session.execute(stmt)
            pdfs = result.scalars().all()
            
            return [
                {
                    "id": pdf.id,
                    "title": pdf.title or "无标题",
                    "abstract": pdf.abstract or "",
                    "authors": self._parse_json(pdf.authors),
                    "doi": pdf.doi,
                    "url": f"https://doi.org/{pdf.doi}" if pdf.doi else None,
                    "pdf_url": None,
                    "source": "database",
                    "relevance_score": random.uniform(0.7, 0.99),
                    "publish_date": str(pdf.publish_year) if pdf.publish_year else None,
                    "journal": None,
                    "category": pdf.category,
                    "material_name": pdf.material_name
                }
                for pdf in pdfs
            ]
    
    async def search_web(self, query: str, max_results: int = 50) -> List[Dict[str, Any]]:
        """搜索网页（模拟）"""
        # 这里可以集成arXiv API或其他学术搜索引擎
        # 目前返回空列表
        return []
    
    async def get_search_suggestions(self, query: str, limit: int = 10) -> List[str]:
        """获取搜索建议"""
        # 基于查询返回一些建议
        suggestions = [
            f"{query} 性能",
            f"{query} 合成方法",
            f"{query} 应用",
            f"{query} 表征",
            f"{query} 最新研究"
        ]
        return suggestions[:limit]
    
    async def get_paper_by_id(self, paper_id: str) -> Optional[Dict[str, Any]]:
        """通过ID获取论文"""
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(PDFIndex).where(PDFIndex.id == paper_id)
            )
            pdf = result.scalar_one_or_none()
            
            if not pdf:
                return None
            
            return {
                "id": pdf.id,
                "title": pdf.title,
                "abstract": pdf.abstract,
                "authors": self._parse_json(pdf.authors),
                "doi": pdf.doi,
                "url": f"https://doi.org/{pdf.doi}" if pdf.doi else None,
                "source": "database",
                "publish_date": str(pdf.publish_year) if pdf.publish_year else None,
                "category": pdf.category,
                "material_name": pdf.material_name,
                "properties": pdf.properties,
                "applications": pdf.applications,
                "synthesis_method": pdf.synthesis_method
            }
    
    async def get_paper_by_doi(self, doi: str) -> Optional[Dict[str, Any]]:
        """通过DOI获取论文"""
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(PDFIndex).where(PDFIndex.doi == doi)
            )
            pdf = result.scalar_one_or_none()
            
            if not pdf:
                return None
            
            return await self.get_paper_by_id(pdf.id)
    
    def _parse_json(self, data: Optional[str]) -> List[str]:
        """解析JSON字符串"""
        if not data:
            return []
        try:
            import json
            return json.loads(data)
        except:
            return []


class MemoryServiceCompat:
    """兼容旧API的记忆服务"""
    
    async def get_user_memory(self, user_id: str) -> Optional[Dict[str, Any]]:
        """获取用户记忆"""
        from services.memory_service import MemoryService
        async with AsyncSessionLocal() as session:
            return await MemoryService.get_user_memory(session, user_id)
    
    async def add_search_history(self, user_id: str, query: str, results_count: int = 0):
        """添加搜索历史"""
        from services.memory_service import MemoryService
        async with AsyncSessionLocal() as session:
            await MemoryService.save_search_history(
                session, user_id, query, 
                results_count=results_count
            )


# 全局服务实例
search_service = SearchServiceCompat()
memory_service = MemoryServiceCompat()
