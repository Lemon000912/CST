from typing import List, Dict, Any, Optional
from dataclasses import dataclass
from difflib import SequenceMatcher

from core.logging import get_logger

logger = get_logger("fusion_service")


@dataclass
class SearchResult:
    """搜索结果数据类"""
    id: str
    title: str
    abstract: str
    authors: List[str]
    doi: Optional[str]
    url: str
    source: str  # "database", "web", "pdf_library"
    relevance_score: float
    publish_date: Optional[str]
    credibility_score: float = 0.0


class FusionService:
    """
    数据融合服务
    
    实现CE (Cross-Encoder) + GStack融合方法
    """
    
    def __init__(self):
        self.cross_encoder = None  # TODO: 加载Cross-Encoder模型
        self.similarity_threshold = 0.85  # 去重相似度阈值
    
    def _calculate_similarity(self, text1: str, text2: str) -> float:
        """
        计算文本相似度
        
        使用SequenceMatcher计算
        """
        if not text1 or not text2:
            return 0.0
        
        return SequenceMatcher(None, text1.lower(), text2.lower()).ratio()
    
    def deduplicate(
        self,
        results: List[SearchResult]
    ) -> List[SearchResult]:
        """
        去重处理
        
        基于DOI和标题相似度去重
        
        Args:
            results: 原始结果列表
            
        Returns:
            去重后的结果列表
        """
        if not results:
            return []
        
        seen_dois = set()
        unique_results = []
        
        for result in results:
            # 基于DOI去重（最精确）
            if result.doi:
                if result.doi in seen_dois:
                    logger.debug(f"DOI去重: {result.doi}")
                    continue
                seen_dois.add(result.doi)
                unique_results.append(result)
                continue
            
            # 基于标题相似度去重
            is_duplicate = False
            for existing in unique_results:
                similarity = self._calculate_similarity(result.title, existing.title)
                if similarity > self.similarity_threshold:
                    logger.debug(
                        f"标题去重: '{result.title[:50]}...' 与 "
                        f"'{existing.title[:50]}...' 相似度: {similarity:.3f}"
                    )
                    is_duplicate = True
                    break
            
            if not is_duplicate:
                unique_results.append(result)
        
        removed_count = len(results) - len(unique_results)
        logger.info(f"去重完成: 原始 {len(results)} 条, 去重后 {len(unique_results)} 条, 移除 {removed_count} 条")
        
        return unique_results
    
    def _calculate_credibility(self, result: SearchResult) -> float:
        """
        计算可信度权重
        
        基于来源、DOI、作者等因素
        """
        # 基础权重
        source_weights = {
            "database": 1.0,
            "pdf_library": 0.95,
            "web": 0.7
        }
        
        base_weight = source_weights.get(result.source, 0.5)
        
        # 有DOI增加可信度
        if result.doi:
            base_weight *= 1.1
        
        # 有作者信息增加可信度
        if result.authors and len(result.authors) > 0:
            base_weight *= 1.05
        
        # 有发布日期增加可信度
        if result.publish_date:
            base_weight *= 1.02
        
        return min(base_weight, 1.5)  # 上限1.5
    
    def rank_results(
        self,
        results: List[SearchResult],
        query: str
    ) -> List[SearchResult]:
        """
        结果排序
        
        基于相关性和可信度排序
        
        Args:
            results: 结果列表
            query: 查询词
            
        Returns:
            排序后的结果列表
        """
        if not results:
            return []
        
        for result in results:
            # 计算可信度权重
            credibility_weight = self._calculate_credibility(result)
            
            # 计算查询相关性（简单版本）
            title_similarity = self._calculate_similarity(query, result.title)
            abstract_similarity = self._calculate_similarity(query, result.abstract) if result.abstract else 0
            
            # 综合分数 = 原始相关性 * 可信度 * 标题匹配度
            result.relevance_score = (
                result.relevance_score * 0.3 +  # 原始分数
                title_similarity * 0.4 +         # 标题匹配
                abstract_similarity * 0.2 +      # 摘要匹配
                credibility_weight * 0.1         # 可信度
            )
        
        # 按分数降序排序
        ranked = sorted(results, key=lambda x: x.relevance_score, reverse=True)
        
        logger.info(f"排序完成: {len(ranked)} 条结果")
        return ranked
    
    def evaluate_credibility(
        self,
        results: List[SearchResult]
    ) -> List[Dict[str, Any]]:
        """
        评估可信度
        
        为每个结果计算可信度分数
        
        Args:
            results: 结果列表
            
        Returns:
            可信度评估列表
        """
        evaluations = []
        
        for result in results:
            score = self._calculate_credibility(result)
            
            # 确定可信度等级
            if score >= 1.2:
                level = "高"
            elif score >= 0.9:
                level = "中"
            else:
                level = "低"
            
            evaluations.append({
                "id": result.id,
                "title": result.title[:100],
                "credibility_score": round(score, 3),
                "credibility_level": level,
                "factors": {
                    "has_doi": bool(result.doi),
                    "has_authors": bool(result.authors),
                    "has_date": bool(result.publish_date),
                    "source": result.source
                }
            })
        
        return evaluations
    
    def _dict_to_result(self, data: Dict[str, Any]) -> SearchResult:
        """
        将字典转换为SearchResult
        
        Args:
            data: 结果字典
            
        Returns:
            SearchResult对象
        """
        return SearchResult(
            id=data.get("id", ""),
            title=data.get("title", ""),
            abstract=data.get("abstract", ""),
            authors=data.get("authors", []),
            doi=data.get("doi"),
            url=data.get("url", ""),
            source=data.get("source", "unknown"),
            relevance_score=data.get("relevance_score", 0.5),
            publish_date=data.get("publish_date"),
            credibility_score=data.get("credibility_score", 0.0)
        )
    
    def _result_to_dict(self, result: SearchResult) -> Dict[str, Any]:
        """
        将SearchResult转换为字典
        
        Args:
            result: SearchResult对象
            
        Returns:
            结果字典
        """
        return {
            "id": result.id,
            "title": result.title,
            "abstract": result.abstract,
            "authors": result.authors,
            "doi": result.doi,
            "url": result.url,
            "source": result.source,
            "relevance_score": round(result.relevance_score, 4),
            "publish_date": result.publish_date,
            "credibility_score": round(result.credibility_score, 4)
        }
    
    async def fuse_data(
        self,
        database_results: List[Dict[str, Any]],
        web_results: List[Dict[str, Any]],
        pdf_results: List[Dict[str, Any]] = None,
        query: str = ""
    ) -> Dict[str, Any]:
        """
        融合数据
        
        合并数据库、网页和PDF结果，去重、排序、评估可信度
        
        Args:
            database_results: 数据库结果
            web_results: 网页结果
            pdf_results: PDF文献结果（可选）
            query: 查询词
            
        Returns:
            融合后的结果字典
        """
        logger.info(
            f"开始数据融合: 数据库 {len(database_results)} 条, "
            f"网页 {len(web_results)} 条, "
            f"PDF {len(pdf_results or [])} 条"
        )
        
        # 1. 转换为统一格式
        all_results = []
        
        for r in database_results:
            all_results.append(self._dict_to_result(r))
        
        for r in web_results:
            all_results.append(self._dict_to_result(r))
        
        if pdf_results:
            for r in pdf_results:
                all_results.append(self._dict_to_result(r))
        
        # 2. 去重
        unique_results = self.deduplicate(all_results)
        duplicates_removed = len(all_results) - len(unique_results)
        
        # 3. 排序
        ranked_results = self.rank_results(unique_results, query)
        
        # 4. 评估可信度
        credibility_evaluations = self.evaluate_credibility(ranked_results)
        
        # 5. 转换回字典格式
        fused_results = []
        for result in ranked_results:
            fused_results.append(self._result_to_dict(result))
        
        logger.info(
            f"数据融合完成: 原始 {len(all_results)} 条, "
            f"去重 {duplicates_removed} 条, "
            f"最终 {len(fused_results)} 条"
        )
        
        return {
            "fused_results": fused_results,
            "total": len(fused_results),
            "duplicates_removed": duplicates_removed,
            "ranking_applied": True,
            "credibility_evaluated": True,
            "credibility_evaluations": credibility_evaluations
        }
    
    async def quick_fuse(
        self,
        results: List[Dict[str, Any]],
        query: str = ""
    ) -> List[Dict[str, Any]]:
        """
        快速融合
        
        简化版融合，只进行去重和排序
        
        Args:
            results: 结果列表
            query: 查询词
            
        Returns:
            融合后的结果列表
        """
        if not results:
            return []
        
        # 转换为SearchResult
        search_results = [self._dict_to_result(r) for r in results]
        
        # 去重
        unique_results = self.deduplicate(search_results)
        
        # 排序
        ranked_results = self.rank_results(unique_results, query)
        
        # 转换回字典
        return [self._result_to_dict(r) for r in ranked_results]


# 全局融合服务实例
fusion_service = FusionService()
