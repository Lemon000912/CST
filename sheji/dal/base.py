from typing import TypeVar, Generic, List, Optional, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, update, func
from sqlalchemy.orm import declarative_base

from core.logging import get_logger
from utils.helpers import generate_id

logger = get_logger("dal")
T = TypeVar("T", bound=declarative_base())


class BaseDAL(Generic[T]):
    """
    数据访问层基类
    
    提供基础的CRUD操作
    """
    
    def __init__(self, model_class: type[T]):
        self.model_class = model_class
        self.model_name = model_class.__name__
    
    async def get_by_id(
        self,
        session: AsyncSession,
        id: str
    ) -> Optional[T]:
        """
        根据ID获取记录
        
        Args:
            session: 数据库会话
            id: 记录ID
            
        Returns:
            记录对象或None
        """
        result = await session.execute(
            select(self.model_class).where(self.model_class.id == id)
        )
        return result.scalar_one_or_none()
    
    async def get_by_ids(
        self,
        session: AsyncSession,
        ids: List[str]
    ) -> List[T]:
        """
        根据ID列表获取多条记录
        
        Args:
            session: 数据库会话
            ids: ID列表
            
        Returns:
            记录列表
        """
        result = await session.execute(
            select(self.model_class).where(self.model_class.id.in_(ids))
        )
        return result.scalars().all()
    
    async def create(
        self,
        session: AsyncSession,
        data: Dict[str, Any]
    ) -> T:
        """
        创建记录
        
        Args:
            session: 数据库会话
            data: 记录数据
            
        Returns:
            创建的记录对象
        """
        # 自动生成ID
        if "id" not in data or not data["id"]:
            data["id"] = generate_id()
        
        instance = self.model_class(**data)
        session.add(instance)
        await session.flush()
        
        logger.debug(f"创建{self.model_name}: {data['id']}")
        return instance
    
    async def update(
        self,
        session: AsyncSession,
        id: str,
        data: Dict[str, Any]
    ) -> Optional[T]:
        """
        更新记录
        
        Args:
            session: 数据库会话
            id: 记录ID
            data: 更新数据
            
        Returns:
            更新后的记录或None
        """
        # 移除不能更新的字段
        data.pop("id", None)
        data.pop("created_at", None)
        
        await session.execute(
            update(self.model_class)
            .where(self.model_class.id == id)
            .values(**data)
        )
        
        logger.debug(f"更新{self.model_name}: {id}")
        return await self.get_by_id(session, id)
    
    async def delete(
        self,
        session: AsyncSession,
        id: str
    ) -> bool:
        """
        删除记录
        
        Args:
            session: 数据库会话
            id: 记录ID
            
        Returns:
            是否删除成功
        """
        result = await session.execute(
            delete(self.model_class).where(self.model_class.id == id)
        )
        
        success = result.rowcount > 0
        if success:
            logger.debug(f"删除{self.model_name}: {id}")
        
        return success
    
    async def list(
        self,
        session: AsyncSession,
        skip: int = 0,
        limit: int = 100,
        filters: Optional[Dict[str, Any]] = None
    ) -> List[T]:
        """
        获取记录列表
        
        Args:
            session: 数据库会话
            skip: 跳过数量
            limit: 最大数量
            filters: 过滤条件
            
        Returns:
            记录列表
        """
        query = select(self.model_class)
        
        # 应用过滤条件
        if filters:
            for key, value in filters.items():
                if hasattr(self.model_class, key) and value is not None:
                    query = query.where(getattr(self.model_class, key) == value)
        
        query = query.offset(skip).limit(limit)
        result = await session.execute(query)
        
        return result.scalars().all()
    
    async def count(
        self,
        session: AsyncSession,
        filters: Optional[Dict[str, Any]] = None
    ) -> int:
        """
        获取记录数量
        
        Args:
            session: 数据库会话
            filters: 过滤条件
            
        Returns:
            记录数量
        """
        query = select(func.count()).select_from(self.model_class)
        
        # 应用过滤条件
        if filters:
            for key, value in filters.items():
                if hasattr(self.model_class, key) and value is not None:
                    query = query.where(getattr(self.model_class, key) == value)
        
        result = await session.execute(query)
        return result.scalar()
    
    async def exists(
        self,
        session: AsyncSession,
        id: str
    ) -> bool:
        """
        检查记录是否存在
        
        Args:
            session: 数据库会话
            id: 记录ID
            
        Returns:
            是否存在
        """
        result = await session.execute(
            select(func.count())
            .select_from(self.model_class)
            .where(self.model_class.id == id)
        )
        return result.scalar() > 0
