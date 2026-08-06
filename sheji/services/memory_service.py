"""
用户记忆服务
管理用户的历史主题、搜索偏好和记忆持久化
"""

import json
from typing import Optional, List, Dict, Any
from datetime import datetime
import uuid

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc

from models.database import UserMemory, UserTopic, SearchHistory, User
from core.database import get_cache


class MemoryService:
    """用户记忆服务"""
    
    @staticmethod
    async def get_user_memory(db: AsyncSession, user_id: str) -> Optional[Dict[str, Any]]:
        """获取用户记忆"""
        result = await db.execute(
            select(UserMemory).where(UserMemory.user_id == user_id)
        )
        memory = result.scalar_one_or_none()
        
        if not memory:
            return None
        
        return {
            "id": memory.id,
            "user_id": memory.user_id,
            "historical_topics": json.loads(memory.historical_topics) if memory.historical_topics else [],
            "preferences": json.loads(memory.preferences) if memory.preferences else {},
            "search_patterns": json.loads(memory.search_patterns) if memory.search_patterns else {},
            "memory_summary": memory.memory_summary,
            "updated_at": memory.updated_at.isoformat() if memory.updated_at else None
        }
    
    @staticmethod
    async def update_memory(db: AsyncSession, user_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """更新用户记忆"""
        result = await db.execute(
            select(UserMemory).where(UserMemory.user_id == user_id)
        )
        memory = result.scalar_one_or_none()
        
        if not memory:
            # 创建新记忆
            memory = UserMemory(
                id=str(uuid.uuid4()),
                user_id=user_id,
                historical_topics=json.dumps(data.get("historical_topics", []), ensure_ascii=False),
                preferences=json.dumps(data.get("preferences", {}), ensure_ascii=False),
                search_patterns=json.dumps(data.get("search_patterns", {}), ensure_ascii=False),
                memory_summary=data.get("memory_summary", "")
            )
            db.add(memory)
        else:
            # 更新现有记忆
            if "historical_topics" in data:
                memory.historical_topics = json.dumps(data["historical_topics"], ensure_ascii=False)
            if "preferences" in data:
                memory.preferences = json.dumps(data["preferences"], ensure_ascii=False)
            if "search_patterns" in data:
                memory.search_patterns = json.dumps(data["search_patterns"], ensure_ascii=False)
            if "memory_summary" in data:
                memory.memory_summary = data["memory_summary"]
        
        await db.commit()
        await db.refresh(memory)
        
        # 更新缓存
        cache = await get_cache()
        await cache.set(f"user_memory:{user_id}", {
            "historical_topics": json.loads(memory.historical_topics) if memory.historical_topics else [],
            "preferences": json.loads(memory.preferences) if memory.preferences else {},
            "search_patterns": json.loads(memory.search_patterns) if memory.search_patterns else {},
            "memory_summary": memory.memory_summary
        }, ttl=3600)
        
        return {
            "id": memory.id,
            "user_id": memory.user_id,
            "historical_topics": json.loads(memory.historical_topics) if memory.historical_topics else [],
            "preferences": json.loads(memory.preferences) if memory.preferences else {},
            "search_patterns": json.loads(memory.search_patterns) if memory.search_patterns else {},
            "memory_summary": memory.memory_summary
        }
    
    @staticmethod
    async def add_topic(db: AsyncSession, user_id: str, topic: str, category: Optional[str] = None, query: Optional[str] = None) -> Dict[str, Any]:
        """添加用户历史主题"""
        # 检查是否已存在该主题
        result = await db.execute(
            select(UserTopic).where(
                UserTopic.user_id == user_id,
                UserTopic.topic == topic
            )
        )
        existing = result.scalar_one_or_none()
        
        if existing:
            # 更新查询次数
            existing.query_count += 1
            existing.last_query = query or existing.last_query
            if category:
                existing.category = category
        else:
            # 创建新主题
            existing = UserTopic(
                id=str(uuid.uuid4()),
                user_id=user_id,
                topic=topic,
                category=category,
                query_count=1,
                last_query=query
            )
            db.add(existing)
        
        await db.commit()
        await db.refresh(existing)
        
        return {
            "id": existing.id,
            "topic": existing.topic,
            "category": existing.category,
            "query_count": existing.query_count,
            "last_query": existing.last_query
        }
    
    @staticmethod
    async def get_user_topics(db: AsyncSession, user_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        """获取用户历史主题列表"""
        result = await db.execute(
            select(UserTopic)
            .where(UserTopic.user_id == user_id)
            .order_by(desc(UserTopic.query_count))
            .limit(limit)
        )
        topics = result.scalars().all()
        
        return [
            {
                "id": t.id,
                "topic": t.topic,
                "category": t.category,
                "query_count": t.query_count,
                "last_query": t.last_query,
                "updated_at": t.updated_at.isoformat() if t.updated_at else None
            }
            for t in topics
        ]
    
    @staticmethod
    async def save_search_history(db: AsyncSession, user_id: str, query: str, 
                                   rewritten_query: Optional[str] = None,
                                   source: str = "database", 
                                   results_count: int = 0,
                                   search_time: float = 0,
                                   filters: Optional[Dict] = None) -> Dict[str, Any]:
        """保存搜索历史"""
        history = SearchHistory(
            id=str(uuid.uuid4()),
            user_id=user_id,
            query=query,
            rewritten_query=rewritten_query,
            source=source,
            results_count=results_count,
            search_time=search_time,
            filters=json.dumps(filters, ensure_ascii=False) if filters else None
        )
        db.add(history)
        await db.commit()
        await db.refresh(history)
        
        return {
            "id": history.id,
            "query": history.query,
            "rewritten_query": history.rewritten_query,
            "source": history.source,
            "results_count": history.results_count,
            "created_at": history.created_at.isoformat() if history.created_at else None
        }
    
    @staticmethod
    async def get_search_history(db: AsyncSession, user_id: str, limit: int = 50) -> List[Dict[str, Any]]:
        """获取用户搜索历史"""
        result = await db.execute(
            select(SearchHistory)
            .where(SearchHistory.user_id == user_id)
            .order_by(desc(SearchHistory.created_at))
            .limit(limit)
        )
        histories = result.scalars().all()
        
        return [
            {
                "id": h.id,
                "query": h.query,
                "rewritten_query": h.rewritten_query,
                "source": h.source,
                "results_count": h.results_count,
                "search_time": h.search_time,
                "created_at": h.created_at.isoformat() if h.created_at else None
            }
            for h in histories
        ]
    
    @staticmethod
    async def build_memory_summary(db: AsyncSession, user_id: str) -> str:
        """构建用户记忆摘要（用于LLM理解用户偏好）"""
        # 获取用户主题
        topics = await MemoryService.get_user_topics(db, user_id, limit=10)
        
        # 获取搜索历史
        histories = await MemoryService.get_search_history(db, user_id, limit=20)
        
        # 构建摘要
        topic_names = [t["topic"] for t in topics[:5]]
        categories = list(set([t["category"] for t in topics if t["category"]]))
        recent_queries = [h["query"] for h in histories[:5]]
        
        summary = f"""用户兴趣领域: {', '.join(categories) if categories else '未分类'}
经常查询的主题: {', '.join(topic_names) if topic_names else '暂无'}
近期查询: {', '.join(recent_queries) if recent_queries else '暂无'}
总查询次数: {sum(t['query_count'] for t in topics)}"""
        
        # 更新记忆摘要
        memory_result = await db.execute(
            select(UserMemory).where(UserMemory.user_id == user_id)
        )
        memory = memory_result.scalar_one_or_none()
        
        if memory:
            memory.memory_summary = summary
            await db.commit()
        
        return summary
