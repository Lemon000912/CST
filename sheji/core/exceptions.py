from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from typing import Any, Dict, Optional
import traceback


class AppException(Exception):
    """
    应用基础异常类
    
    所有自定义异常的基类
    """
    
    def __init__(
        self,
        message: str,
        code: str = "INTERNAL_ERROR",
        status_code: int = 500,
        details: Optional[Dict[str, Any]] = None
    ):
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details or {}
        super().__init__(self.message)


class ValidationError(AppException):
    """参数验证错误"""
    
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(
            message=message,
            code="VALIDATION_ERROR",
            status_code=400,
            details=details
        )


class AuthenticationError(AppException):
    """认证错误"""
    
    def __init__(self, message: str = "认证失败"):
        super().__init__(
            message=message,
            code="AUTHENTICATION_ERROR",
            status_code=401
        )


class AuthorizationError(AppException):
    """授权错误"""
    
    def __init__(self, message: str = "权限不足"):
        super().__init__(
            message=message,
            code="AUTHORIZATION_ERROR",
            status_code=403
        )


class NotFoundError(AppException):
    """资源不存在错误"""
    
    def __init__(self, resource: str = "资源"):
        super().__init__(
            message=f"{resource}不存在",
            code="NOT_FOUND",
            status_code=404
        )


class DatabaseError(AppException):
    """数据库错误"""
    
    def __init__(self, message: str = "数据库操作失败"):
        super().__init__(
            message=message,
            code="DATABASE_ERROR",
            status_code=500
        )


class ExternalServiceError(AppException):
    """外部服务错误"""
    
    def __init__(self, service: str = "外部服务", message: str = "调用失败"):
        super().__init__(
            message=f"{service}: {message}",
            code="EXTERNAL_SERVICE_ERROR",
            status_code=502
        )


class RateLimitError(AppException):
    """请求频率限制错误"""
    
    def __init__(self, message: str = "请求过于频繁，请稍后再试"):
        super().__init__(
            message=message,
            code="RATE_LIMIT",
            status_code=429
        )


def setup_exception_handlers(app):
    """
    配置FastAPI全局异常处理
    
    Args:
        app: FastAPI应用实例
    """
    
    @app.exception_handler(AppException)
    async def handle_app_exception(request: Request, exc: AppException):
        """处理应用自定义异常"""
        from core.logging import get_logger
        logger = get_logger("exception")
        
        logger.warning(
            f"应用异常 | {exc.code} | {exc.message} | "
            f"路径: {request.url.path}"
        )
        
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "details": exc.details
                }
            }
        )
    
    @app.exception_handler(HTTPException)
    async def handle_http_exception(request: Request, exc: HTTPException):
        """处理FastAPI HTTP异常"""
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": f"HTTP_{exc.status_code}",
                    "message": exc.detail,
                    "details": {}
                }
            }
        )
    
    @app.exception_handler(Exception)
    async def handle_generic_exception(request: Request, exc: Exception):
        """处理未捕获的异常"""
        from core.logging import get_logger
        logger = get_logger("exception")
        
        # 记录详细错误信息
        error_trace = traceback.format_exc()
        logger.error(
            f"未捕获异常 | {type(exc).__name__}: {str(exc)} | "
            f"路径: {request.url.path}\n{error_trace}"
        )
        
        # 返回友好的错误信息（生产环境不暴露详细信息）
        from core.config import settings
        
        if settings.DEBUG:
            message = f"{type(exc).__name__}: {str(exc)}"
        else:
            message = "服务器内部错误，请稍后重试"
        
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": message,
                    "details": {}
                }
            }
        )


def success_response(data: Any = None, message: str = "操作成功") -> Dict[str, Any]:
    """
    生成成功响应
    
    Args:
        data: 响应数据
        message: 成功消息
    
    Returns:
        标准化的成功响应字典
    """
    response = {
        "success": True,
        "message": message
    }
    
    if data is not None:
        response["data"] = data
    
    return response


def error_response(
    message: str,
    code: str = "ERROR",
    details: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    生成错误响应
    
    Args:
        message: 错误消息
        code: 错误代码
        details: 错误详情
    
    Returns:
        标准化的错误响应字典
    """
    return {
        "success": False,
        "error": {
            "code": code,
            "message": message,
            "details": details or {}
        }
    }
