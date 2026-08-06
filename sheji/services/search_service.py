"""
搜索服务
支持9大领域和11要素的文献检索
"""

import json
from typing import Optional, List, Dict, Any
from datetime import datetime
import uuid

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, desc, func

from models.database import (
    PDFIndex, Paper, AnalysisResult, MaterialCategory,
    MATERIAL_CATEGORIES, MATERIAL_ELEMENTS
)
from core.database import get_cache


class SearchService:
    """文献搜索服务"""
    
    # 9大领域代码映射
    CATEGORY_MAP = {
        'alloy_metallic': '合金/金属材料',
        'amorphous_glass': '非晶玻璃',
        'ceramic_structural': '结构陶瓷',
        'composite_multiphase': '多相复合材料',
        'nanomaterials_lowdim': '低维纳米材料',
        'optical_optoelectronic': '光电材料',
        'polymer_soft_matter': '软物质高分子',
        'solid_state_ionic': '固态离子材料',
        'surface_thin_film': '表面与薄膜材料'
    }
    
    # 11个要素字段映射
    ELEMENT_FIELDS = {
        'material_name': '材料名称',
        'symmetry_phase': '对称相',
        'structure_descriptor': '结构描述符',
        'properties': '属性',
        'applications': '应用',
        'synthesis_method': '合成方法工艺',
        'characterization_method': '表征方法',
        'quality_control': '质检',
        'first_author': '第一作者',
        'doi': 'DOI',
        'corresponding_author': '通讯作者'
    }
    
    @staticmethod
    async def search_by_elements(
        db: AsyncSession,
        category: Optional[str] = None,
        elements: Optional[Dict[str, str]] = None,
        query: Optional[str] = None,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
        limit: int = 30,
        offset: int = 0
    ) -> Dict[str, Any]:
        """
        基于11要素的精确检索
        
        Args:
            category: 9大领域代码
            elements: 11个要素的筛选条件
            query: 通用搜索词
            year_from: 起始年份
            year_to: 结束年份
            limit: 返回数量
            offset: 偏移量
        """
        # 构建查询
        stmt = select(PDFIndex).where(PDFIndex.is_indexed == True)
        
        # 领域筛选
        if category and category in SearchService.CATEGORY_MAP:
            stmt = stmt.where(PDFIndex.category == category)
        
        # 11要素筛选
        if elements:
            for field, value in elements.items():
                if field in SearchService.ELEMENT_FIELDS and value:
                    column = getattr(PDFIndex, field, None)
                    if column is not None:
                        stmt = stmt.where(column.contains(value))
        
        # 通用搜索
        if query:
            search_filter = or_(
                PDFIndex.title.contains(query),
                PDFIndex.abstract.contains(query),
                PDFIndex.material_name.contains(query),
                PDFIndex.keywords.contains(query)
            )
            stmt = stmt.where(search_filter)
        
        # 年份筛选
        if year_from:
            stmt = stmt.where(PDFIndex.publish_year >= year_from)
        if year_to:
            stmt = stmt.where(PDFIndex.publish_year <= year_to)
        
        # 计数
        count_stmt = select(func.count()).select_from(stmt.subquery())
        count_result = await db.execute(count_stmt)
        total = count_result.scalar() or 0
        
        # 分页
        stmt = stmt.order_by(desc(PDFIndex.publish_year)).limit(limit).offset(offset)
        
        result = await db.execute(stmt)
        papers = result.scalars().all()
        
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "results": [SearchService._format_pdf_index(p) for p in papers] if papers else []
        }
    
    @staticmethod
    async def search_by_category(
        db: AsyncSession,
        category: str,
        query: Optional[str] = None,
        limit: int = 30
    ) -> Dict[str, Any]:
        """按9大领域检索"""
        if category not in SearchService.CATEGORY_MAP:
            return {"error": f"未知的领域代码: {category}", "valid_categories": list(SearchService.CATEGORY_MAP.keys())}
        
        return await SearchService.search_by_elements(
            db=db,
            category=category,
            query=query,
            limit=limit
        )
    
    @staticmethod
    async def advanced_search(
        db: AsyncSession,
        search_params: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        高级检索 - 支持多条件组合
        
        search_params示例:
        {
            "category": "alloy_metallic",
            "elements": {
                "material_name": "Ti-6Al-4V",
                "properties": "强度",
                "synthesis_method": "熔炼"
            },
            "query": "钛合金",
            "year_range": [2020, 2024],
            "limit": 30
        }
        """
        category = search_params.get("category")
        elements = search_params.get("elements", {})
        query = search_params.get("query")
        year_range = search_params.get("year_range", [])
        limit = search_params.get("limit", 30)
        offset = search_params.get("offset", 0)
        
        year_from = year_range[0] if year_range and len(year_range) > 0 else None
        year_to = year_range[1] if year_range and len(year_range) > 1 else None
        
        return await SearchService.search_by_elements(
            db=db,
            category=category,
            elements=elements,
            query=query,
            year_from=year_from,
            year_to=year_to,
            limit=limit,
            offset=offset
        )
    
    @staticmethod
    async def get_categories(db: AsyncSession) -> List[Dict[str, Any]]:
        """获取9大领域列表"""
        result = await db.execute(select(MaterialCategory))
        categories = result.scalars().all()
        
        return [
            {
                "code": cat.code,
                "name": cat.name,
                "name_en": cat.name_en,
                "description": cat.description,
                "paper_count": cat.paper_count
            }
            for cat in categories
        ]
    
    @staticmethod
    async def get_elements_schema() -> Dict[str, Any]:
        """获取11个要素的结构定义"""
        return {
            "fields": [
                {"key": "material_name", "label": "材料名称", "type": "text", "example": "Ti-6Al-4V钛合金"},
                {"key": "symmetry_phase", "label": "对称相", "type": "text", "example": "六方密堆积(HCP)"},
                {"key": "structure_descriptor", "label": "结构描述符", "type": "text", "example": "α+β双相结构，晶粒尺寸约10μm"},
                {"key": "properties", "label": "属性", "type": "text", "example": "抗拉强度: 1100MPa, 屈服强度: 950MPa"},
                {"key": "applications", "label": "应用", "type": "text", "example": "航空航天结构件、医疗器械"},
                {"key": "synthesis_method", "label": "合成方法工艺", "type": "text", "example": "真空电弧熔炼 + 热轧工艺"},
                {"key": "characterization_method", "label": "表征方法", "type": "text", "example": "XRD, SEM, TEM, 拉伸试验"},
                {"key": "quality_control", "label": "质检", "type": "text", "example": "超声波探伤、化学成分分析"},
                {"key": "first_author", "label": "第一作者", "type": "text", "example": "张三"},
                {"key": "doi", "label": "DOI", "type": "text", "example": "10.1000/alloy001"},
                {"key": "corresponding_author", "label": "通讯作者", "type": "text", "example": "李四"}
            ],
            "categories": [
                {"code": "alloy_metallic", "name": "合金/金属材料"},
                {"code": "amorphous_glass", "name": "非晶玻璃"},
                {"code": "ceramic_structural", "name": "结构陶瓷"},
                {"code": "composite_multiphase", "name": "多相复合材料"},
                {"code": "nanomaterials_lowdim", "name": "低维纳米材料"},
                {"code": "optical_optoelectronic", "name": "光电材料"},
                {"code": "polymer_soft_matter", "name": "软物质高分子"},
                {"code": "solid_state_ionic", "name": "固态离子材料"},
                {"code": "surface_thin_film", "name": "表面与薄膜材料"}
            ]
        }
    
    @staticmethod
    async def get_paper_detail(db: AsyncSession, paper_id: str) -> Optional[Dict[str, Any]]:
        """获取文献详情"""
        result = await db.execute(
            select(PDFIndex).where(PDFIndex.id == paper_id)
        )
        paper = result.scalar_one_or_none()
        
        if not paper:
            return None
        
        return SearchService._format_pdf_index(paper, detail=True)
    
    @staticmethod
    async def get_analysis_result(
        db: AsyncSession, 
        source_type: str, 
        source_id: str
    ) -> Optional[Dict[str, Any]]:
        """获取分析结果（摘要和结论）"""
        result = await db.execute(
            select(AnalysisResult)
            .where(
                and_(
                    AnalysisResult.source_type == source_type,
                    AnalysisResult.source_id == source_id
                )
            )
            .order_by(desc(AnalysisResult.created_at))
        )
        analysis = result.scalar_one_or_none()
        
        if not analysis:
            return None
        
        return {
            "id": analysis.id,
            "source_type": analysis.source_type,
            "source_id": analysis.source_id,
            "user_query": analysis.user_query,
            "summary": analysis.summary,
            "conclusions": analysis.conclusions,
            "key_findings": analysis.key_findings,
            "methodology": analysis.methodology,
            "material_info": json.loads(analysis.material_info) if analysis.material_info else {},
            "confidence_score": analysis.confidence_score,
            "quality_score": analysis.quality_score,
            "model_name": analysis.model_name,
            "created_at": analysis.created_at.isoformat() if analysis.created_at else None
        }
    
    @staticmethod
    def _format_pdf_index(paper: PDFIndex, detail: bool = False) -> Dict[str, Any]:
        """格式化PDF索引数据"""
        data = {
            "id": paper.id,
            "title": paper.title,
            "authors": json.loads(paper.authors) if paper.authors else [],
            "doi": paper.doi,
            "abstract": paper.abstract,
            "keywords": json.loads(paper.keywords) if paper.keywords else [],
            "publish_year": paper.publish_year,
            "category": paper.category,
            "category_name": SearchService.CATEGORY_MAP.get(paper.category, "未知"),
            "is_processed": paper.is_processed,
            "is_indexed": paper.is_indexed,
            "created_at": paper.created_at.isoformat() if paper.created_at else None
        }
        
        if detail:
            # 11个要素详情
            data["elements"] = {
                "material_name": paper.material_name,
                "symmetry_phase": paper.symmetry_phase,
                "structure_descriptor": paper.structure_descriptor,
                "properties": paper.properties,
                "applications": paper.applications,
                "synthesis_method": paper.synthesis_method,
                "characterization_method": paper.characterization_method,
                "quality_control": paper.quality_control,
                "first_author": paper.first_author,
                "doi": paper.doi,
                "corresponding_author": paper.corresponding_author
            }
            data["file_path"] = paper.relative_path
        
        return data
