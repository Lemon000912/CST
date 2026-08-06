from fastapi import APIRouter, Query, Header, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from enum import Enum

from services.recommend_service import recommend_service, RecommendationType
from services.auth_service import auth_service
from services.llm_service import llm_service
from core.exceptions import success_response
from core.logging import get_logger

logger = get_logger("recommend_api")
router = APIRouter()


class RecommendationRequest(BaseModel):
    query: str
    rec_type: RecommendationType = RecommendationType.SOLUTION
    context: Optional[dict] = None


@router.post("/", response_model=dict)
async def get_recommendations(
    request: RecommendationRequest,
    authorization: Optional[str] = Header(None)
):
    """
    获取智能推荐
    
    基于用户特征和历史行为进行推荐
    """
    try:
        user_id = None
        
        # 获取用户ID
        if authorization and authorization.startswith("Bearer "):
            token = authorization.replace("Bearer ", "")
            user = await auth_service.get_current_user(token)
            if user:
                user_id = user.id
        
        # 获取推荐
        result = await recommend_service.get_recommendations(
            query=request.query,
            user_id=user_id,
            rec_type=request.rec_type
        )
        
        return success_response(data=result)
        
    except Exception as e:
        logger.error(f"获取推荐失败: {e}")
        raise HTTPException(status_code=500, detail="获取推荐失败")


@router.get("/check")
async def check_recommendation(
    query: str = Query(..., description="查询内容"),
    user_id: Optional[str] = None
):
    """
    检查是否应该推荐
    
    根据数据充足度和用户特征判断
    """
    try:
        result = await recommend_service.check_data_sufficiency(query)
        
        return success_response(data={
            "should_recommend": result["should_recommend"],
            "reason": "数据充足" if result["should_recommend"] else "数据不足",
            "details": result
        })
        
    except Exception as e:
        logger.error(f"检查推荐失败: {e}")
        raise HTTPException(status_code=500, detail="检查推荐失败")


@router.get("/materials")
async def recommend_materials(
    query: str = Query(..., description="材料查询"),
    limit: int = Query(10, ge=1, le=50)
):
    """
    推荐材料
    """
    try:
        materials = await recommend_service.recommend_materials(query, limit)
        
        return success_response(data={"materials": materials})
        
    except Exception as e:
        logger.error(f"材料推荐失败: {e}")
        raise HTTPException(status_code=500, detail="材料推荐失败")


@router.get("/products")
async def recommend_products(
    query: str = Query(..., description="产品查询"),
    limit: int = Query(10, ge=1, le=50)
):
    """
    推荐产品
    """
    try:
        products = await recommend_service.recommend_products(query, limit)
        
        return success_response(data={"products": products})
        
    except Exception as e:
        logger.error(f"产品推荐失败: {e}")
        raise HTTPException(status_code=500, detail="产品推荐失败")


@router.get("/solutions")
async def recommend_solutions(
    query: str = Query(..., description="综合方案查询"),
    limit: int = Query(5, ge=1, le=20)
):
    """
    推荐综合方案
    """
    try:
        solutions = await recommend_service.recommend_solutions(query, limit)
        
        return success_response(data={"solutions": solutions})
        
    except Exception as e:
        logger.error(f"方案推荐失败: {e}")
        raise HTTPException(status_code=500, detail="方案推荐失败")


@router.post("/ai")
async def ai_recommend(
    query: str,
    authorization: Optional[str] = Header(None)
):
    """
    AI智能推荐
    
    使用大模型生成推荐
    """
    try:
        if not llm_service.is_available():
            return success_response(
                data={"recommendation": "LLM服务未配置"},
                message="LLM服务不可用"
            )
        
        user_context = {}
        
        # 获取用户上下文
        if authorization and authorization.startswith("Bearer "):
            token = authorization.replace("Bearer ", "")
            user = await auth_service.get_current_user(token)
            if user:
                from services.memory_service import memory_service
                memory = await memory_service.get_user_memory(user.id)
                if memory:
                    user_context = {
                        "historical_topics": memory.get("historical_topics", []),
                        "preferences": memory.get("preferences", {})
                    }
        
        # 使用LLM生成推荐
        result = await llm_service.generate_recommendation(query, user_context)
        
        return success_response(data={
            "query": query,
            "recommendation": result["recommendation"],
            "reason": result["reason"],
            "confidence": result["confidence"]
        })
        
    except Exception as e:
        logger.error(f"AI推荐失败: {e}")
        raise HTTPException(status_code=500, detail="AI推荐失败")



