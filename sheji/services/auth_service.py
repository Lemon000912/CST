from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import jwt
from passlib.context import CryptContext

from core.config import settings
from core.database import AsyncSessionLocal
from core.logging import get_logger
from core.exceptions import AuthenticationError, ValidationError
from dal.user_dal import user_dal
from models.database import User
from utils.helpers import generate_id

logger = get_logger("auth_service")

# 密码加密上下文
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class AuthService:
    """认证服务"""
    
    def __init__(self):
        self.secret_key = settings.SECRET_KEY
        self.algorithm = "HS256"
        self.access_token_expire = settings.ACCESS_TOKEN_EXPIRE_MINUTES
        self.refresh_token_expire = settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60
    
    def hash_password(self, password: str) -> str:
        """
        哈希密码
        
        Args:
            password: 明文密码
            
        Returns:
            哈希后的密码
        """
        return pwd_context.hash(password)
    
    def verify_password(self, plain_password: str, hashed_password: str) -> bool:
        """
        验证密码
        
        Args:
            plain_password: 明文密码
            hashed_password: 哈希密码
            
        Returns:
            是否匹配
        """
        return pwd_context.verify(plain_password, hashed_password)
    
    def create_access_token(
        self,
        user_id: str,
        username: str,
        expires_delta: Optional[timedelta] = None
    ) -> str:
        """
        创建访问令牌
        
        Args:
            user_id: 用户ID
            username: 用户名
            expires_delta: 过期时间
            
        Returns:
            JWT令牌
        """
        if expires_delta is None:
            expires_delta = timedelta(minutes=self.access_token_expire)
        
        expire = datetime.utcnow() + expires_delta
        
        payload = {
            "sub": user_id,
            "username": username,
            "type": "access",
            "exp": expire,
            "iat": datetime.utcnow()
        }
        
        token = jwt.encode(payload, self.secret_key, algorithm=self.algorithm)
        return token
    
    def create_refresh_token(self, user_id: str) -> str:
        """
        创建刷新令牌
        
        Args:
            user_id: 用户ID
            
        Returns:
            JWT刷新令牌
        """
        expire = datetime.utcnow() + timedelta(minutes=self.refresh_token_expire)
        
        payload = {
            "sub": user_id,
            "type": "refresh",
            "exp": expire,
            "iat": datetime.utcnow()
        }
        
        token = jwt.encode(payload, self.secret_key, algorithm=self.algorithm)
        return token
    
    def decode_token(self, token: str) -> Optional[Dict[str, Any]]:
        """
        解码令牌
        
        Args:
            token: JWT令牌
            
        Returns:
            令牌内容或None
        """
        try:
            payload = jwt.decode(token, self.secret_key, algorithms=[self.algorithm])
            return payload
        except jwt.ExpiredSignatureError:
            logger.warning("令牌已过期")
            return None
        except jwt.InvalidTokenError as e:
            logger.warning(f"无效令牌: {e}")
            return None
    
    async def authenticate_user(
        self,
        username: str,
        password: str
    ) -> Optional[User]:
        """
        验证用户
        
        Args:
            username: 用户名
            password: 密码
            
        Returns:
            用户对象或None
        """
        async with AsyncSessionLocal() as session:
            user = await user_dal.get_by_username(session, username)
            
            if not user:
                return None
            
            if not self.verify_password(password, user.password_hash):
                return None
            
            # 更新最后活跃时间
            await user_dal.update_last_active(session, user.id)
            await session.commit()
            
            return user
    
    async def register_user(
        self,
        username: str,
        password: str,
        email: Optional[str] = None
    ) -> User:
        """
        注册用户
        
        Args:
            username: 用户名
            password: 密码
            email: 邮箱
            
        Returns:
            新用户对象
            
        Raises:
            ValidationError: 验证失败
        """
        # 验证输入
        if len(username) < 3:
            raise ValidationError("用户名至少需要3个字符")
        
        if len(password) < 6:
            raise ValidationError("密码至少需要6个字符")
        
        async with AsyncSessionLocal() as session:
            # 检查用户名是否已存在
            existing = await user_dal.get_by_username(session, username)
            if existing:
                raise ValidationError("用户名已存在")
            
            # 检查邮箱是否已存在
            if email:
                existing_email = await user_dal.get_by_email(session, email)
                if existing_email:
                    raise ValidationError("邮箱已存在")
            
            # 创建用户
            user_data = {
                "id": generate_id(),
                "username": username,
                "email": email,
                "password_hash": self.hash_password(password),
                "is_active": True
            }
            
            user = await user_dal.create(session, user_data)
            await session.commit()
            
            logger.info(f"新用户注册: {username}")
            return user
    
    async def get_current_user(self, token: str) -> Optional[User]:
        """
        获取当前用户
        
        Args:
            token: JWT令牌
            
        Returns:
            用户对象或None
        """
        payload = self.decode_token(token)
        if not payload:
            return None
        
        user_id = payload.get("sub")
        if not user_id:
            return None
        
        async with AsyncSessionLocal() as session:
            user = await user_dal.get_by_id(session, user_id)
            return user
    
    async def refresh_access_token(self, refresh_token: str) -> Optional[str]:
        """
        刷新访问令牌
        
        Args:
            refresh_token: 刷新令牌
            
        Returns:
            新的访问令牌或None
        """
        payload = self.decode_token(refresh_token)
        if not payload:
            return None
        
        # 检查是否为刷新令牌
        if payload.get("type") != "refresh":
            return None
        
        user_id = payload.get("sub")
        if not user_id:
            return None
        
        async with AsyncSessionLocal() as session:
            user = await user_dal.get_by_id(session, user_id)
            if not user or not user.is_active:
                return None
            
            # 创建新的访问令牌
            return self.create_access_token(user.id, user.username)


# 全局认证服务实例
auth_service = AuthService()
