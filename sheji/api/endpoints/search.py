from fastapi import APIRouter, Query, Header, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, List, Literal
from enum import Enum

from services.search_service_compat import search_service, SearchSource
from services.llm_service import llm_service
from services.search_service_compat import memory_service
from services.auth_service import auth_service
from core.exceptions import success_response
from core.logging import get_logger

logger = get_logger("search_api")
router = APIRouter()


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=500, description="搜索查询")
    source: SearchSource = SearchSource.BOTH
    max_results: int = Field(50, ge=1, le=100)
    filters: Optional[dict] = None


class SearchResultItem(BaseModel):
    id: str
    title: str
    abstract: Optional[str]
    authors: List[str]
    doi: Optional[str]
    url: Optional[str]
    source: str
    relevance_score: float
    publish_date: Optional[str]


@router.post("/", response_model=dict)
async def search(request: SearchRequest, authorization: Optional[str] = Header(None)):
    """
    执行搜索查询
    
    支持数据库检索、网页检索或两者结合
    """
    try:
        user_id = None
        
        # 获取用户ID（如果已登录）
        if authorization and authorization.startswith("Bearer "):
            token = authorization.replace("Bearer ", "")
            user = await auth_service.get_current_user(token)
            if user:
                user_id = user.id
        
        # 执行搜索
        result = await search_service.search(
            query=request.query,
            source=request.source,
            max_results=request.max_results,
            filters=request.filters
        )
        
        # 记录搜索历史
        if user_id:
            await memory_service.add_search_history(
                user_id,
                request.query,
                result["total"]
            )
        
        logger.info(
            f"搜索: '{request.query}' | 用户: {user_id or '匿名'} | "
            f"结果: {result['total']}"
        )
        
        return success_response(data=result)
        
    except Exception as e:
        logger.error(f"搜索失败: {e}")
        raise HTTPException(status_code=500, detail="搜索失败")


@router.get("/suggest")
async def search_suggestions(
    q: str = Query(..., min_length=1, description="搜索关键词"),
    limit: int = Query(10, ge=1, le=20)
):
    """
    搜索建议
    
    根据输入前缀返回搜索建议
    """
    try:
        suggestions = await search_service.get_search_suggestions(q, limit)
        
        return success_response(data={"suggestions": suggestions})
        
    except Exception as e:
        logger.error(f"获取搜索建议失败: {e}")
        raise HTTPException(status_code=500, detail="获取搜索建议失败")


@router.post("/rewrite")
async def rewrite_query(query: str):
    """
    使用大模型重写搜索查询
    
    优化查询词以提高检索效果
    """
    try:
        if not llm_service.is_available():
            return success_response(
                data={
                    "original": query,
                    "rewritten": query,
                    "keywords": query.split(),
                    "expanded_queries": [query]
                },
                message="LLM服务未配置，返回原始查询"
            )
        
        result = await llm_service.rewrite_query(query)
        
        return success_response(data=result)
        
    except Exception as e:
        logger.error(f"查询重写失败: {e}")
        raise HTTPException(status_code=500, detail="查询重写失败")


@router.get("/paper/{paper_id}")
async def get_paper_detail(paper_id: str):
    """
    获取论文详情
    
    Args:
        paper_id: 论文ID
    """
    try:
        paper = await search_service.get_paper_by_id(paper_id)
        
        if not paper:
            raise HTTPException(status_code=404, detail="论文未找到")
        
        return success_response(data=paper)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取论文详情失败: {e}")
        raise HTTPException(status_code=500, detail="获取论文详情失败")


@router.get("/doi/{doi:path}")
async def get_paper_by_doi(doi: str):
    """
    通过DOI获取论文
    
    Args:
        doi: DOI编号（支持含斜杠的DOI）
    """
    try:
        paper = await search_service.get_paper_by_doi(doi)
        
        if not paper:
            raise HTTPException(status_code=404, detail="论文未找到")
        
        return success_response(data=paper)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"DOI查询失败: {e}")
        raise HTTPException(status_code=500, detail="DOI查询失败")


@router.get("/hot")
async def get_hot_searches(limit: int = Query(10, ge=1, le=50)):
    """
    获取热门搜索
    
    返回最近热门的搜索关键词
    """
    try:
        # TODO: 实现热门搜索统计
        # 临时返回空列表
        return success_response(data={"hot_searches": []})
        
    except Exception as e:
        logger.error(f"获取热门搜索失败: {e}")
        raise HTTPException(status_code=500, detail="获取热门搜索失败")
