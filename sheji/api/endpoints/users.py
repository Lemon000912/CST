from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime

from services.auth_service import auth_service
from services.memory_service import MemoryService
from core.database import AsyncSessionLocal
from core.exceptions import success_response, AuthenticationError
from core.logging import get_logger

logger = get_logger("users_api")
router = APIRouter()


class UpdateProfileRequest(BaseModel):
    email: Optional[str] = None


class UpdatePreferencesRequest(BaseModel):
    preferences: dict


async def get_current_user(authorization: Optional[str] = Header(None)):
    """获取当前用户的辅助函数"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少认证令牌")
    
    token = authorization.replace("Bearer ", "")
    user = await auth_service.get_current_user(token)
    
    if not user:
        raise HTTPException(status_code=401, detail="无效的令牌")
    
    return user


@router.get("/profile", response_model=dict)
async def get_profile(authorization: Optional[str] = Header(None)):
    """
    获取用户资料
    """
    try:
        user = await get_current_user(authorization)
        
        return success_response(
            data={
                "user_id": user.id,
                "username": user.username,
                "email": user.email,
                "created_at": user.created_at.isoformat() if user.created_at else None,
                "last_active": user.last_active.isoformat() if user.last_active else None,
                "is_active": user.is_active
            }
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取用户资料失败: {e}")
        raise HTTPException(status_code=500, detail="获取用户资料失败")


@router.put("/profile", response_model=dict)
async def update_profile(
    request: UpdateProfileRequest,
    authorization: Optional[str] = Header(None)
):
    """
    更新用户资料
    """
    try:
        user = await get_current_user(authorization)
        
        # TODO: 实现资料更新逻辑
        
        return success_response(message="资料更新成功")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新用户资料失败: {e}")
        raise HTTPException(status_code=500, detail="更新用户资料失败")


@router.get("/memory", response_model=dict)
async def get_user_memory(authorization: Optional[str] = Header(None)):
    """
    获取用户记忆
    
    包括历史主题、偏好设置、搜索模式等
    """
    try:
        user = await get_current_user(authorization)
        
        async with AsyncSessionLocal() as session:
            memory = await MemoryService.get_user_memory(session, user.id)
        
        if not memory:
            return success_response(
                data={
                    "user_id": user.id,
                    "historical_topics": [],
                    "preferences": {},
                    "search_patterns": {}
                }
            )
        
        return success_response(data=memory)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取用户记忆失败: {e}")
        raise HTTPException(status_code=500, detail="获取用户记忆失败")


@router.post("/memory/save", response_model=dict)
async def save_user_memory(
    memory: dict,
    authorization: Optional[str] = Header(None)
):
    """
    保存用户记忆
    
    保存偏好与搜索结果到记忆系统
    """
    try:
        user = await get_current_user(authorization)
        
        async with AsyncSessionLocal() as session:
            await MemoryService.update_memory(session, user.id, memory)
        
        return success_response(message="记忆保存成功")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"保存用户记忆失败: {e}")
        raise HTTPException(status_code=500, detail="保存用户记忆失败")


@router.get("/history", response_model=dict)
async def get_search_history(
    limit: int = 20,
    authorization: Optional[str] = Header(None)
):
    """
    获取搜索历史
    """
    try:
        user = await get_current_user(authorization)
        
        async with AsyncSessionLocal() as session:
            history = await MemoryService.get_search_history(session, user.id, limit)
        
        return success_response(data={"history": history})
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取搜索历史失败: {e}")
        raise HTTPException(status_code=500, detail="获取搜索历史失败")


@router.post("/preferences", response_model=dict)
async def update_preferences(
    request: UpdatePreferencesRequest,
    authorization: Optional[str] = Header(None)
):
    """
    更新用户偏好
    """
    try:
        user = await get_current_user(authorization)
        
        async with AsyncSessionLocal() as session:
            memory = await MemoryService.get_user_memory(session, user.id)
            if memory:
                preferences = memory.get("preferences", {})
                preferences.update(request.preferences)
                await MemoryService.update_memory(session, user.id, {"preferences": preferences})
            else:
                await MemoryService.update_memory(session, user.id, {"preferences": request.preferences})
        
        return success_response(message="偏好更新成功")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新用户偏好失败: {e}")
        raise HTTPException(status_code=500, detail="更新用户偏好失败")


@router.delete("/memory/clear", response_model=dict)
async def clear_memory(authorization: Optional[str] = Header(None)):
    """
    清除用户记忆
    """
    try:
        user = await get_current_user(authorization)
        
        async with AsyncSessionLocal() as session:
            await MemoryService.update_memory(session, user.id, {
                "historical_topics": [],
                "preferences": {},
                "search_patterns": {},
                "memory_summary": ""
            })
        
        return success_response(message="记忆清除成功")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"清除用户记忆失败: {e}")
        raise HTTPException(status_code=500, detail="清除用户记忆失败")
