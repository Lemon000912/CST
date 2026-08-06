from typing import Optional, List, Dict, Any
import json
import openai
import anthropic
from tenacity import retry, stop_after_attempt, wait_exponential
from core.config import settings
from core.logging import get_logger

logger = get_logger("llm_service")


class LLMService:
    """大语言模型服务 - 支持OpenAI/Claude/通义千问"""
    
    def __init__(self):
        self.openai_client = None
        self.anthropic_client = None
        self.dashscope_client = None
        
        # 优先使用通义千问
        if settings.DASHSCOPE_API_KEY and settings.DASHSCOPE_API_KEY != "your_dashscope_api_key_here":
            self.dashscope_client = openai.AsyncOpenAI(
                api_key=settings.DASHSCOPE_API_KEY,
                base_url=settings.DASHSCOPE_BASE_URL
            )
            logger.info("✅ 通义千问客户端初始化成功")
        else:
            logger.warning("⚠️ 未配置通义千问API密钥")
        
        if settings.OPENAI_API_KEY:
            self.openai_client = openai.AsyncOpenAI(
                api_key=settings.OPENAI_API_KEY,
                base_url=settings.OPENAI_BASE_URL
            )
            logger.info("✅ OpenAI客户端初始化成功")
        else:
            logger.warning("⚠️ 未配置OpenAI API密钥")
        
        if settings.ANTHROPIC_API_KEY:
            self.anthropic_client = anthropic.AsyncAnthropic(
                api_key=settings.ANTHROPIC_API_KEY
            )
            logger.info("✅ Claude客户端初始化成功")
        else:
            logger.warning("⚠️ 未配置Claude API密钥")
    
    def _get_client(self):
        """获取可用的LLM客户端 - 优先顺序: 通义千问 > OpenAI > Claude"""
        if self.dashscope_client:
            return self.dashscope_client, settings.DASHSCOPE_MODEL
        if self.openai_client:
            return self.openai_client, settings.OPENAI_MODEL
        return None, None
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def rewrite_query(self, query: str) -> Dict[str, Any]:
        """
        重写搜索查询
        
        使用大模型优化查询词，提高检索效果
        
        Args:
            query: 原始查询
            
        Returns:
            包含重写后查询和关键词的字典
        """
        client, model = self._get_client()
        if not client:
            logger.warning("未配置LLM，返回原始查询")
            return {
                "original": query,
                "rewritten": query,
                "keywords": query.split(),
                "expanded_queries": [query]
            }
        
        prompt = f"""你是一个材料科学领域的搜索优化专家。

请将以下查询优化为更适合学术数据库检索的形式：

原始查询: {query}

请提供：
1. 优化后的查询（英文，包含专业术语）
2. 3-5个关键词
3. 2-3个扩展查询（不同角度）

以JSON格式返回：
{{
    "rewritten": "优化后的查询",
    "keywords": ["关键词1", "关键词2", ...],
    "expanded_queries": ["扩展查询1", "扩展查询2", ...]
}}"""
        
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "你是一个材料科学领域的搜索优化专家。只输出JSON格式。"},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,
                max_tokens=500
            )
            
            content = response.choices[0].message.content
            result = json.loads(content)
            
            return {
                "original": query,
                "rewritten": result.get("rewritten", query),
                "keywords": result.get("keywords", query.split()),
                "expanded_queries": result.get("expanded_queries", [query])
            }
            
        except Exception as e:
            logger.error(f"查询重写失败: {e}")
            return {
                "original": query,
                "rewritten": query,
                "keywords": query.split(),
                "expanded_queries": [query]
            }
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def analyze_paper(
        self,
        content: str,
        analysis_type: str = "full"
    ) -> Dict[str, Any]:
        """
        分析论文内容
        
        提取摘要、关键词、结论等
        
        Args:
            content: 论文内容
            analysis_type: 分析类型 (summary, keywords, conclusions, full)
            
        Returns:
            分析结果字典
        """
        if not self.openai_client:
            logger.warning("未配置LLM，返回空分析")
            return {
                "summary": "",
                "keywords": [],
                "conclusions": "",
                "methodology": "",
                "credibility_score": 0.0
            }
        
        # 截断内容避免超出token限制
        max_length = 8000
        if len(content) > max_length:
            content = content[:max_length] + "..."
        
        analysis_prompts = {
            "summary": "请生成200字以内的摘要",
            "keywords": "请提取5-10个关键词",
            "conclusions": "请总结主要结论",
            "full": "请提供摘要、关键词、结论和研究方法"
        }
        
        prompt = f"""请分析以下材料科学论文内容：

{content}

{analysis_prompts.get(analysis_type, analysis_prompts["full"])}

以JSON格式返回：
{{
    "summary": "摘要",
    "keywords": ["关键词1", "关键词2", ...],
    "conclusions": "主要结论",
    "methodology": "研究方法",
    "credibility_score": 0.8
}}"""
        
        try:
            response = await self.openai_client.chat.completions.create(
                model=settings.OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": "你是一个材料科学论文分析专家。只输出JSON格式。"},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3,
                max_tokens=1000,
                response_format={"type": "json_object"}
            )
            
            result = json.loads(response.choices[0].message.content)
            
            return {
                "summary": result.get("summary", ""),
                "keywords": result.get("keywords", []),
                "conclusions": result.get("conclusions", ""),
                "methodology": result.get("methodology", ""),
                "credibility_score": result.get("credibility_score", 0.8)
            }
            
        except Exception as e:
            logger.error(f"论文分析失败: {e}")
            return {
                "summary": "",
                "keywords": [],
                "conclusions": "",
                "methodology": "",
                "credibility_score": 0.0
            }
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def generate_recommendation(
        self,
        query: str,
        context: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        生成推荐
        
        基于查询和上下文生成推荐
        
        Args:
            query: 用户查询
            context: 上下文信息
            
        Returns:
            推荐结果
        """
        if not self.openai_client:
            return {"recommendation": "", "confidence": 0.0}
        
        prompt = f"""基于以下查询和上下文，推荐合适的材料/产品/方案：

查询: {query}
上下文: {json.dumps(context, ensure_ascii=False)[:2000]}

请提供：
1. 推荐内容（详细说明）
2. 推荐理由
3. 置信度（0-1）

以JSON格式返回：
{{
    "recommendation": "推荐内容",
    "reason": "推荐理由",
    "confidence": 0.85
}}"""
        
        try:
            response = await self.openai_client.chat.completions.create(
                model=settings.OPENAI_MODEL,
                messages=[
                    {"role": "system", "content": "你是一个材料科学推荐专家。只输出JSON格式。"},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.5,
                max_tokens=800,
                response_format={"type": "json_object"}
            )
            
            result = json.loads(response.choices[0].message.content)
            
            return {
                "recommendation": result.get("recommendation", ""),
                "reason": result.get("reason", ""),
                "confidence": result.get("confidence", 0.0)
            }
            
        except Exception as e:
            logger.error(f"推荐生成失败: {e}")
            return {"recommendation": "", "reason": "", "confidence": 0.0}
    
    async def chat(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 1000
    ) -> str:
        """
        通用对话接口
        
        Args:
            messages: 消息列表
            temperature: 温度参数
            max_tokens: 最大token数
            
        Returns:
            模型回复
        """
        if not self.openai_client:
            return "未配置LLM服务"
        
        try:
            response = await self.openai_client.chat.completions.create(
                model=settings.OPENAI_MODEL,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens
            )
            
            return response.choices[0].message.content
            
        except Exception as e:
            logger.error(f"对话失败: {e}")
            return f"对话失败: {str(e)}"
    
    def is_available(self) -> bool:
        """检查LLM服务是否可用"""
        return self.dashscope_client is not None or self.openai_client is not None or self.anthropic_client is not None


# 全局LLM服务实例
llm_service = LLMService()
