"""
分析服务
存储和管理LLM生成的摘要、结论和分析结果
"""

import json
from typing import Optional, Dict, Any
from datetime import datetime
import uuid

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from models.database import AnalysisResult, PDFIndex


class AnalysisService:
    """分析结果存储服务"""
    
    @staticmethod
    async def save_analysis(
        db: AsyncSession,
        source_type: str,
        source_id: str,
        user_query: Optional[str] = None,
        user_id: Optional[str] = None,
        summary: Optional[str] = None,
        conclusions: Optional[str] = None,
        key_findings: Optional[str] = None,
        methodology: Optional[str] = None,
        material_info: Optional[Dict] = None,
        confidence_score: float = 0.0,
        quality_score: float = 0.0,
        model_name: str = "gpt-4o-mini"
    ) -> Dict[str, Any]:
        """
        保存分析结果
        
        Args:
            source_type: 来源类型 ('paper', 'document', 'query')
            source_id: 来源ID
            user_query: 用户查询
            user_id: 用户ID
            summary: 生成的摘要
            conclusions: 主要结论
            key_findings: 关键发现
            methodology: 研究方法总结
            material_info: 提取的材料信息
            confidence_score: 置信度
            quality_score: 质量评分
            model_name: 使用的模型名称
        """
        analysis = AnalysisResult(
            id=str(uuid.uuid4()),
            source_type=source_type,
            source_id=source_id,
            user_query=user_query,
            user_id=user_id,
            summary=summary,
            conclusions=conclusions,
            key_findings=key_findings,
            methodology=methodology,
            material_info=json.dumps(material_info, ensure_ascii=False) if material_info else None,
            confidence_score=confidence_score,
            quality_score=quality_score,
            model_name=model_name
        )
        
        db.add(analysis)
        await db.commit()
        await db.refresh(analysis)
        
        return {
            "id": analysis.id,
            "source_type": analysis.source_type,
            "source_id": analysis.source_id,
            "summary": analysis.summary,
            "conclusions": analysis.conclusions,
            "created_at": analysis.created_at.isoformat() if analysis.created_at else None
        }
    
    @staticmethod
    async def get_analysis_by_source(
        db: AsyncSession,
        source_type: str,
        source_id: str
    ) -> Optional[Dict[str, Any]]:
        """根据来源获取分析结果"""
        result = await db.execute(
            select(AnalysisResult)
            .where(
                AnalysisResult.source_type == source_type,
                AnalysisResult.source_id == source_id
            )
            .order_by(desc(AnalysisResult.created_at))
        )
        analysis = result.scalar_one_or_none()
        
        if not analysis:
            return None
        
        return AnalysisService._format_analysis(analysis)
    
    @staticmethod
    async def get_analysis_by_user(
        db: AsyncSession,
        user_id: str,
        limit: int = 20
    ) -> list:
        """获取用户的分析历史"""
        result = await db.execute(
            select(AnalysisResult)
            .where(AnalysisResult.user_id == user_id)
            .order_by(desc(AnalysisResult.created_at))
            .limit(limit)
        )
        analyses = result.scalars().all()
        
        return [AnalysisService._format_analysis(a) for a in analyses]
    
    @staticmethod
    async def update_analysis(
        db: AsyncSession,
        analysis_id: str,
        data: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """更新分析结果"""
        result = await db.execute(
            select(AnalysisResult).where(AnalysisResult.id == analysis_id)
        )
        analysis = result.scalar_one_or_none()
        
        if not analysis:
            return None
        
        # 更新字段
        if "summary" in data:
            analysis.summary = data["summary"]
        if "conclusions" in data:
            analysis.conclusions = data["conclusions"]
        if "key_findings" in data:
            analysis.key_findings = data["key_findings"]
        if "methodology" in data:
            analysis.methodology = data["methodology"]
        if "material_info" in data:
            analysis.material_info = json.dumps(data["material_info"], ensure_ascii=False)
        if "confidence_score" in data:
            analysis.confidence_score = data["confidence_score"]
        if "quality_score" in data:
            analysis.quality_score = data["quality_score"]
        
        await db.commit()
        await db.refresh(analysis)
        
        return AnalysisService._format_analysis(analysis)
    
    @staticmethod
    def _format_analysis(analysis: AnalysisResult) -> Dict[str, Any]:
        """格式化分析结果"""
        return {
            "id": analysis.id,
            "source_type": analysis.source_type,
            "source_id": analysis.source_id,
            "user_query": analysis.user_query,
            "user_id": analysis.user_id,
            "summary": analysis.summary,
            "conclusions": analysis.conclusions,
            "key_findings": analysis.key_findings,
            "methodology": analysis.methodology,
            "material_info": json.loads(analysis.material_info) if analysis.material_info else {},
            "confidence_score": analysis.confidence_score,
            "quality_score": analysis.quality_score,
            "model_name": analysis.model_name,
            "created_at": analysis.created_at.isoformat() if analysis.created_at else None,
            "updated_at": analysis.updated_at.isoformat() if analysis.updated_at else None
        }
