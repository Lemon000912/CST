from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel, Field
from typing import Optional

from services.auth_service import auth_service
from core.exceptions import success_response, error_response, ValidationError, AuthenticationError
from core.logging import get_logger

logger = get_logger("auth_api")
router = APIRouter()


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50, description="用户名")
    password: str = Field(..., min_length=6, description="密码")


class LoginResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user_id: str
    username: str


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50, description="用户名")
    password: str = Field(..., min_length=6, description="密码")
    email: Optional[str] = Field(None, description="邮箱")


class TokenRefreshRequest(BaseModel):
    refresh_token: str


@router.post("/login", response_model=dict)
async def login(request: LoginRequest):
    """
    用户登录
    
    验证用户名和密码，返回访问令牌
    """
    try:
        user = await auth_service.authenticate_user(
            request.username,
            request.password
        )
        
        if not user:
            raise AuthenticationError("用户名或密码错误")
        
        # 创建令牌
        access_token = auth_service.create_access_token(user.id, user.username)
        refresh_token = auth_service.create_refresh_token(user.id)
        
        logger.info(f"用户登录成功: {user.username}")
        
        return success_response(
            data={
                "access_token": access_token,
                "refresh_token": refresh_token,
                "token_type": "bearer",
                "user_id": user.id,
                "username": user.username
            },
            message="登录成功"
        )
        
    except AuthenticationError as e:
        raise HTTPException(status_code=401, detail=e.message)
    except Exception as e:
        logger.error(f"登录失败: {e}")
        raise HTTPException(status_code=500, detail="登录失败")


@router.post("/register", response_model=dict)
async def register(request: RegisterRequest):
    """
    用户注册
    
    创建新用户账号
    """
    try:
        user = await auth_service.register_user(
            request.username,
            request.password,
            request.email
        )
        
        logger.info(f"用户注册成功: {user.username}")
        
        return success_response(
            data={
                "user_id": user.id,
                "username": user.username
            },
            message="注册成功"
        )
        
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=e.message)
    except Exception as e:
        logger.error(f"注册失败: {e}")
        raise HTTPException(status_code=500, detail="注册失败")


@router.post("/refresh", response_model=dict)
async def refresh_token(request: TokenRefreshRequest):
    """
    刷新访问令牌
    
    使用刷新令牌获取新的访问令牌
    """
    try:
        new_token = await auth_service.refresh_access_token(request.refresh_token)
        
        if not new_token:
            raise AuthenticationError("无效的刷新令牌")
        
        return success_response(
            data={
                "access_token": new_token,
                "token_type": "bearer"
            },
            message="令牌刷新成功"
        )
        
    except AuthenticationError as e:
        raise HTTPException(status_code=401, detail=e.message)
    except Exception as e:
        logger.error(f"刷新令牌失败: {e}")
        raise HTTPException(status_code=500, detail="刷新令牌失败")


@router.post("/logout", response_model=dict)
async def logout(authorization: Optional[str] = Header(None)):
    """
    用户登出
    
    使当前令牌失效（客户端需要删除令牌）
    """
    # 这里可以实现令牌黑名单机制
    # 简单实现：客户端删除令牌即可
    return success_response(message="登出成功")


@router.get("/me", response_model=dict)
async def get_current_user_info(authorization: Optional[str] = Header(None)):
    """
    获取当前用户信息
    
    需要Authorization头包含Bearer令牌
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少认证令牌")
    
    token = authorization.replace("Bearer ", "")
    
    try:
        user = await auth_service.get_current_user(token)
        
        if not user:
            raise AuthenticationError("无效的令牌")
        
        return success_response(
            data={
                "user_id": user.id,
                "username": user.username,
                "email": user.email,
                "created_at": user.created_at.isoformat() if user.created_at else None,
                "last_active": user.last_active.isoformat() if user.last_active else None
            }
        )
        
    except AuthenticationError as e:
        raise HTTPException(status_code=401, detail=e.message)
    except Exception as e:
        logger.error(f"获取用户信息失败: {e}")
        raise HTTPException(status_code=500, detail="获取用户信息失败")
