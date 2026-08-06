from typing import List, Dict, Any, Optional
from enum import Enum
from services.llm_service import llm_service
from services.memory_service import MemoryService
from services.search_service_compat import search_service
from core.database import AsyncSessionLocal


class RecommendationType(str, Enum):
    MATERIAL = "material"
    PRODUCT = "product"
    SOLUTION = "solution"


class RecommendService:
    """推荐服务"""
    
    async def check_data_sufficiency(
        self,
        query: str,
        source: str = "both"
    ) -> Dict[str, Any]:
        """
        检查数据充足度
        
        判断数据库和网页结果是否充足
        """
        # 执行搜索检查
        db_count = 0
        web_count = 0
        
        if source in ["database", "both"]:
            db_results = await search_service.search_database(query, max_results=10)
            db_count = len(db_results)
        
        if source in ["web", "both"]:
            web_results = await search_service.search_web(query, max_results=10)
            web_count = len(web_results)
        
        return {
            "database_sufficient": db_count >= 5,
            "web_sufficient": web_count >= 5,
            "db_count": db_count,
            "web_count": web_count,
            "should_recommend": db_count >= 5 or web_count >= 5
        }
    
    async def get_recommendations(
        self,
        query: str,
        user_id: Optional[str] = None,
        rec_type: RecommendationType = RecommendationType.SOLUTION
    ) -> Dict[str, Any]:
        """
        获取推荐
        
        基于查询和用户特征生成推荐
        """
        # 1. 检查数据充足度
        sufficiency = await self.check_data_sufficiency(query)
        
        if not sufficiency["should_recommend"]:
            return {
                "query": query,
                "recommendations": [],
                "is_recommended": False,
                "reason": "数据不足，无法生成可靠推荐"
            }
        
        # 2. 获取用户记忆（如果有）
        user_context = {}
        if user_id:
            async with AsyncSessionLocal() as session:
                memory = await MemoryService.get_user_memory(session, user_id)
                if memory:
                    user_context = {
                        "historical_topics": memory.get("historical_topics", []),
                        "preferences": memory.get("preferences", {})
                    }
        
        # 3. 执行搜索获取数据
        search_results = await search_service.search(
            query,
            source="both",
            max_results=20
        )
        
        # 4. 使用LLM生成推荐
        context = {
            "search_results": search_results["results"],
            "user_context": user_context,
            "recommendation_type": rec_type
        }
        
        recommendation = await llm_service.generate_recommendation(query, context)
        
        return {
            "query": query,
            "recommendations": [{
                "id": "rec_1",
                "title": "推荐结果",
                "description": recommendation["recommendation"],
                "confidence": recommendation["confidence"],
                "reason": "基于搜索数据和用户偏好",
                "source": "ai_generated",
                "metadata": sufficiency
            }],
            "is_recommended": True,
            "reason": None
        }
    
    async def recommend_materials(
        self,
        query: str,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """推荐材料"""
        # TODO: 实现材料推荐逻辑
        return []
    
    async def recommend_products(
        self,
        query: str,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """推荐产品"""
        # TODO: 实现产品推荐逻辑
        return []
    
    async def recommend_solutions(
        self,
        query: str,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        """推荐综合方案"""
        # TODO: 实现方案推荐逻辑
        return []


# 全局推荐服务实例
recommend_service = RecommendService()
