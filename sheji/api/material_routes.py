"""
材料知识库专用API路由
支持9大领域、11要素检索、用户记忆和分析结果
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

from core.database import get_db
from services.search_service import SearchService
from services.memory_service import MemoryService
from services.analysis_service import AnalysisService

router = APIRouter(prefix="/api/v1/material", tags=["材料知识库"])


# ==================== 请求模型 ====================

class ElementSearchRequest(BaseModel):
    """11要素检索请求"""
    category: Optional[str] = Field(None, description="9大领域代码")
    elements: Optional[Dict[str, str]] = Field(None, description="11要素筛选条件")
    query: Optional[str] = Field(None, description="通用搜索词")
    year_range: Optional[List[int]] = Field(None, description="年份范围 [from, to]")
    limit: int = Field(20, ge=1, le=100)
    offset: int = Field(0, ge=0)


class MemoryUpdateRequest(BaseModel):
    """用户记忆更新请求"""
    historical_topics: Optional[List[str]] = None
    preferences: Optional[Dict[str, Any]] = None
    search_patterns: Optional[Dict[str, Any]] = None
    memory_summary: Optional[str] = None


class TopicAddRequest(BaseModel):
    """添加历史主题请求"""
    topic: str
    category: Optional[str] = None
    query: Optional[str] = None


class SearchHistoryRequest(BaseModel):
    """保存搜索历史请求"""
    query: str
    rewritten_query: Optional[str] = None
    source: str = "database"
    results_count: int = 0
    search_time: float = 0
    filters: Optional[Dict[str, Any]] = None


class AnalysisSaveRequest(BaseModel):
    """保存分析结果请求"""
    source_type: str = Field(..., description="来源类型: paper/document/query")
    source_id: str
    user_query: Optional[str] = None
    user_id: Optional[str] = None
    summary: Optional[str] = None
    conclusions: Optional[str] = None
    key_findings: Optional[str] = None
    methodology: Optional[str] = None
    material_info: Optional[Dict[str, Any]] = None
    confidence_score: float = 0.0
    quality_score: float = 0.0
    model_name: str = "gpt-4o-mini"


# ==================== 9大领域接口 ====================

@router.get("/categories", response_model=Dict[str, Any])
async def get_categories(db: AsyncSession = Depends(get_db)):
    """
    获取9大材料领域列表
    
    返回所有可用的材料分类领域
    """
    categories = await SearchService.get_categories(db)
    return {
        "status": "success",
        "data": {
            "categories": categories,
            "total": len(categories)
        }
    }


@router.get("/elements/schema", response_model=Dict[str, Any])
async def get_elements_schema():
    """
    获取11个检索要素的结构定义
    
    返回可用于检索的11个要素字段定义和示例
    """
    schema = await SearchService.get_elements_schema()
    return {
        "status": "success",
        "data": schema
    }


# ==================== 文献检索接口 ====================

@router.post("/search", response_model=Dict[str, Any])
async def advanced_search(
    request: ElementSearchRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    高级检索 - 支持9大领域和11要素组合检索
    
    示例请求:
    ```json
    {
        "category": "alloy_metallic",
        "elements": {
            "material_name": "Ti-6Al-4V",
            "properties": "强度"
        },
        "query": "钛合金",
        "year_range": [2020, 2024],
        "limit": 20
    }
    ```
    """
    search_params = {
        "category": request.category,
        "elements": request.elements,
        "query": request.query,
        "year_range": request.year_range,
        "limit": request.limit,
        "offset": request.offset
    }
    
    results = await SearchService.advanced_search(db, search_params)
    
    if "error" in results:
        raise HTTPException(status_code=400, detail=results["error"])
    
    return {
        "status": "success",
        "data": results
    }


@router.get("/search/category/{category}", response_model=Dict[str, Any])
async def search_by_category(
    category: str,
    query: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db)
):
    """
    按9大领域检索文献
    
    - **category**: 领域代码 (alloy_metallic, nanomaterials_lowdim 等)
    - **query**: 可选的搜索关键词
    """
    results = await SearchService.search_by_category(db, category, query, limit)
    
    if "error" in results:
        raise HTTPException(status_code=400, detail=results["error"])
    
    return {
        "status": "success",
        "data": results
    }


@router.get("/paper/{paper_id}", response_model=Dict[str, Any])
async def get_paper_detail(paper_id: str, db: AsyncSession = Depends(get_db)):
    """
    获取文献详情（包含11个要素）
    
    返回指定文献的完整信息，包括11个要素字段
    """
    paper = await SearchService.get_paper_detail(db, paper_id)
    
    if not paper:
        raise HTTPException(status_code=404, detail="文献不存在")
    
    # 获取分析结果
    analysis = await SearchService.get_analysis_result(db, "paper", paper_id)
    
    return {
        "status": "success",
        "data": {
            "paper": paper,
            "analysis": analysis
        }
    }


# ==================== 用户记忆接口 ====================

@router.get("/memory/{user_id}", response_model=Dict[str, Any])
async def get_user_memory(user_id: str, db: AsyncSession = Depends(get_db)):
    """
    获取用户记忆
    
    返回用户的历史主题、偏好和搜索模式
    """
    memory = await MemoryService.get_user_memory(db, user_id)
    
    if not memory:
        raise HTTPException(status_code=404, detail="用户记忆不存在")
    
    return {
        "status": "success",
        "data": memory
    }


@router.post("/memory/{user_id}", response_model=Dict[str, Any])
async def update_user_memory(
    user_id: str,
    request: MemoryUpdateRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    更新用户记忆
    
    更新用户的历史主题、偏好设置和搜索模式
    """
    data = {}
    if request.historical_topics is not None:
        data["historical_topics"] = request.historical_topics
    if request.preferences is not None:
        data["preferences"] = request.preferences
    if request.search_patterns is not None:
        data["search_patterns"] = request.search_patterns
    if request.memory_summary is not None:
        data["memory_summary"] = request.memory_summary
    
    memory = await MemoryService.update_memory(db, user_id, data)
    return {
        "status": "success",
        "data": memory
    }


@router.post("/memory/{user_id}/topic", response_model=Dict[str, Any])
async def add_user_topic(
    user_id: str,
    request: TopicAddRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    添加用户历史主题
    
    记录用户查询过的主题，用于个性化推荐
    """
    topic = await MemoryService.add_topic(
        db, user_id, request.topic, request.category, request.query
    )
    return {
        "status": "success",
        "data": topic
    }


@router.get("/memory/{user_id}/topics", response_model=Dict[str, Any])
async def get_user_topics(
    user_id: str,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db)
):
    """
    获取用户历史主题列表
    
    按查询次数排序返回用户的历史主题
    """
    topics = await MemoryService.get_user_topics(db, user_id, limit)
    return {
        "status": "success",
        "data": {
            "topics": topics,
            "total": len(topics)
        }
    }


@router.get("/memory/{user_id}/history", response_model=Dict[str, Any])
async def get_search_history(
    user_id: str,
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db)
):
    """
    获取用户搜索历史
    
    返回用户的搜索历史记录
    """
    history = await MemoryService.get_search_history(db, user_id, limit)
    return {
        "status": "success",
        "data": {
            "history": history,
            "total": len(history)
        }
    }


@router.post("/memory/{user_id}/history", response_model=Dict[str, Any])
async def save_search_history(
    user_id: str,
    request: SearchHistoryRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    保存搜索历史记录
    
    在用户搜索后调用，自动记录搜索查询和结果
    """
    result = await MemoryService.save_search_history(
        db, user_id, request.query,
        rewritten_query=request.rewritten_query,
        source=request.source,
        results_count=request.results_count,
        search_time=request.search_time,
        filters=request.filters
    )
    return {
        "status": "success",
        "data": result
    }


# ==================== 分析结果接口 ====================

@router.post("/analysis", response_model=Dict[str, Any])
async def save_analysis(
    request: AnalysisSaveRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    保存分析结果
    
    存储LLM生成的摘要、结论和分析结果
    """
    analysis = await AnalysisService.save_analysis(
        db=db,
        source_type=request.source_type,
        source_id=request.source_id,
        user_query=request.user_query,
        user_id=request.user_id,
        summary=request.summary,
        conclusions=request.conclusions,
        key_findings=request.key_findings,
        methodology=request.methodology,
        material_info=request.material_info,
        confidence_score=request.confidence_score,
        quality_score=request.quality_score,
        model_name=request.model_name
    )
    
    return {
        "status": "success",
        "data": analysis
    }


@router.get("/analysis/{source_type}/{source_id}", response_model=Dict[str, Any])
async def get_analysis(
    source_type: str,
    source_id: str,
    db: AsyncSession = Depends(get_db)
):
    """
    获取分析结果
    
    获取指定来源的分析结果（摘要、结论等）
    """
    analysis = await AnalysisService.get_analysis_by_source(db, source_type, source_id)
    
    if not analysis:
        raise HTTPException(status_code=404, detail="分析结果不存在")
    
    return {
        "status": "success",
        "data": analysis
    }


@router.get("/analysis/user/{user_id}", response_model=Dict[str, Any])
async def get_user_analysis(
    user_id: str,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db)
):
    """
    获取用户的分析历史
    
    返回用户所有的分析结果记录
    """
    analyses = await AnalysisService.get_analysis_by_user(db, user_id, limit)
    return {
        "status": "success",
        "data": {
            "analyses": analyses,
            "total": len(analyses)
        }
    }
