from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any
from enum import Enum

from services.fusion_service import fusion_service
from services.llm_service import llm_service
from core.exceptions import success_response
from core.logging import get_logger

logger = get_logger("analysis_api")
router = APIRouter()


class AnalysisType(str, Enum):
    SUMMARY = "summary"
    KEYWORDS = "keywords"
    CONCLUSIONS = "conclusions"
    FULL = "full"


class DataFusionRequest(BaseModel):
    database_results: List[dict] = []
    web_results: List[dict] = []
    pdf_results: List[dict] = []
    query: str = ""


class AnalysisRequest(BaseModel):
    content: str
    analysis_type: AnalysisType = AnalysisType.FULL


@router.post("/fuse", response_model=dict)
async def fuse_data(request: DataFusionRequest):
    """
    融合数据库和网页数据
    
    使用CE+GStack方法进行数据融合
    """
    try:
        result = await fusion_service.fuse_data(
            database_results=request.database_results,
            web_results=request.web_results,
            pdf_results=request.pdf_results,
            query=request.query
        )
        
        return success_response(data=result)
        
    except Exception as e:
        logger.error(f"数据融合失败: {e}")
        raise HTTPException(status_code=500, detail="数据融合失败")


@router.post("/content", response_model=dict)
async def analyze_content(request: AnalysisRequest):
    """
    分析内容
    
    使用大模型进行内容分析
    """
    try:
        if not llm_service.is_available():
            return success_response(
                data={
                    "summary": "LLM服务未配置",
                    "keywords": [],
                    "conclusions": "",
                    "methodology": "",
                    "credibility_score": 0.0
                },
                message="LLM服务不可用"
            )
        
        result = await llm_service.analyze_paper(
            request.content,
            request.analysis_type.value
        )
        
        return success_response(data=result)
        
    except Exception as e:
        logger.error(f"内容分析失败: {e}")
        raise HTTPException(status_code=500, detail="内容分析失败")


@router.post("/rank")
async def rank_results(results: List[dict], query: str = ""):
    """
    对结果进行排序
    
    基于相关性和可信度排序
    """
    try:
        ranked = await fusion_service.quick_fuse(results, query)
        
        return success_response(data={"ranked_results": ranked})
        
    except Exception as e:
        logger.error(f"排序失败: {e}")
        raise HTTPException(status_code=500, detail="排序失败")


@router.post("/deduplicate")
async def deduplicate_results(results: List[dict]):
    """
    去重处理
    
    移除重复的结果
    """
    try:
        from services.fusion_service import SearchResult
        
        # 转换为SearchResult
        search_results = []
        for r in results:
            search_results.append(SearchResult(
                id=r.get("id", ""),
                title=r.get("title", ""),
                abstract=r.get("abstract", ""),
                authors=r.get("authors", []),
                doi=r.get("doi"),
                url=r.get("url", ""),
                source=r.get("source", "unknown"),
                relevance_score=r.get("relevance_score", 0.5),
                publish_date=r.get("publish_date")
            ))
        
        # 去重
        unique = fusion_service.deduplicate(search_results)
        
        # 转换回字典
        deduplicated = []
        for r in unique:
            deduplicated.append({
                "id": r.id,
                "title": r.title,
                "abstract": r.abstract,
                "authors": r.authors,
                "doi": r.doi,
                "url": r.url,
                "source": r.source,
                "relevance_score": r.relevance_score,
                "publish_date": r.publish_date
            })
        
        return success_response(data={
            "deduplicated_results": deduplicated,
            "removed_count": len(results) - len(deduplicated)
        })
        
    except Exception as e:
        logger.error(f"去重失败: {e}")
        raise HTTPException(status_code=500, detail="去重失败")


@router.post("/evaluate-credibility")
async def evaluate_credibility(results: List[dict]):
    """
    评估可信度
    
    评估每个结果的可信度分数
    """
    try:
        from services.fusion_service import SearchResult
        
        # 转换为SearchResult
        search_results = []
        for r in results:
            search_results.append(SearchResult(
                id=r.get("id", ""),
                title=r.get("title", ""),
                abstract=r.get("abstract", ""),
                authors=r.get("authors", []),
                doi=r.get("doi"),
                url=r.get("url", ""),
                source=r.get("source", "unknown"),
                relevance_score=r.get("relevance_score", 0.5),
                publish_date=r.get("publish_date")
            ))
        
        evaluations = fusion_service.evaluate_credibility(search_results)
        
        return success_response(data={"credibility_evaluations": evaluations})
        
    except Exception as e:
        logger.error(f"可信度评估失败: {e}")
        raise HTTPException(status_code=500, detail="可信度评估失败")


@router.post("/generate-summary")
async def generate_summary(texts: List[str]):
    """
    生成摘要
    
    合并多个文本生成摘要
    """
    try:
        if not llm_service.is_available():
            return success_response(
                data={"summary": "LLM服务未配置"},
                message="LLM服务不可用"
            )
        
        # 合并文本
        combined_text = "\n\n".join(texts)
        
        # 使用LLM生成摘要
        result = await llm_service.analyze_paper(combined_text, "summary")
        
        return success_response(data={"summary": result.get("summary", "")})
        
    except Exception as e:
        logger.error(f"生成摘要失败: {e}")
        raise HTTPException(status_code=500, detail="生成摘要失败")


@router.post("/extract-keywords")
async def extract_keywords(text: str, top_k: int = 10):
    """
    提取关键词
    
    从文本中提取关键词
    """
    try:
        if not llm_service.is_available():
            return success_response(
                data={"keywords": text.split()[:top_k]},
                message="LLM服务不可用，返回简单分词结果"
            )
        
        # 使用LLM提取关键词
        result = await llm_service.analyze_paper(text, "keywords")
        
        keywords = result.get("keywords", [])[:top_k]
        
        return success_response(data={"keywords": keywords})
        
    except Exception as e:
        logger.error(f"提取关键词失败: {e}")
        raise HTTPException(status_code=500, detail="提取关键词失败")
