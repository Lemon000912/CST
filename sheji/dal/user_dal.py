from typing import Optional, List, Dict, Any
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from dal.base import BaseDAL
from models.database import User, UserPreference
from core.logging import get_logger

logger = get_logger("user_dal")


class UserDAL(BaseDAL[User]):
    """用户数据访问层"""
    
    def __init__(self):
        super().__init__(User)
    
    async def get_by_username(
        self,
        session: AsyncSession,
        username: str
    ) -> Optional[User]:
        """
        根据用户名获取用户
        
        Args:
            session: 数据库会话
            username: 用户名
            
        Returns:
            用户对象或None
        """
        result = await session.execute(
            select(User).where(User.username == username)
        )
        return result.scalar_one_or_none()
    
    async def get_by_email(
        self,
        session: AsyncSession,
        email: str
    ) -> Optional[User]:
        """
        根据邮箱获取用户
        
        Args:
            session: 数据库会话
            email: 邮箱
            
        Returns:
            用户对象或None
        """
        result = await session.execute(
            select(User).where(User.email == email)
        )
        return result.scalar_one_or_none()
    
    async def get_active_users(
        self,
        session: AsyncSession,
        skip: int = 0,
        limit: int = 100
    ) -> List[User]:
        """
        获取活跃用户列表
        
        Args:
            session: 数据库会话
            skip: 跳过数量
            limit: 最大数量
            
        Returns:
            用户列表
        """
        result = await session.execute(
            select(User)
            .where(User.is_active == True)
            .offset(skip)
            .limit(limit)
        )
        return result.scalars().all()
    
    async def update_last_active(
        self,
        session: AsyncSession,
        user_id: str
    ) -> bool:
        """
        更新用户最后活跃时间
        
        Args:
            session: 数据库会话
            user_id: 用户ID
            
        Returns:
            是否更新成功
        """
        from datetime import datetime
        
        result = await session.execute(
            text("""
                UPDATE users
                SET last_active = :now
                WHERE id = :user_id
            """),
            {"user_id": user_id, "now": datetime.utcnow()}
        )
        
        return result.rowcount > 0


class UserPreferenceDAL(BaseDAL[UserPreference]):
    """用户偏好数据访问层"""
    
    def __init__(self):
        super().__init__(UserPreference)
    
    async def get_by_user_id(
        self,
        session: AsyncSession,
        user_id: str
    ) -> Optional[UserPreference]:
        """
        根据用户ID获取偏好设置
        
        Args:
            session: 数据库会话
            user_id: 用户ID
            
        Returns:
            偏好设置或None
        """
        result = await session.execute(
            select(UserPreference).where(UserPreference.user_id == user_id)
        )
        return result.scalar_one_or_none()
    
    async def create_or_update(
        self,
        session: AsyncSession,
        user_id: str,
        data: Dict[str, Any]
    ) -> UserPreference:
        """
        创建或更新用户偏好
        
        Args:
            session: 数据库会话
            user_id: 用户ID
            data: 偏好数据
            
        Returns:
            偏好设置对象
        """
        existing = await self.get_by_user_id(session, user_id)
        
        if existing:
            # 更新
            for key, value in data.items():
                if hasattr(existing, key):
                    setattr(existing, key, value)
            await session.flush()
            return existing
        else:
            # 创建
            data["user_id"] = user_id
            return await self.create(session, data)


# 全局实例
user_dal = UserDAL()
user_preference_dal = UserPreferenceDAL()
