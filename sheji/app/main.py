from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from core.config import settings
from core.database import init_db, close_db, check_db_connection, init_cache, close_cache
from core.logging import get_logger, log_requests
from core.exceptions import setup_exception_handlers
from api.routes import router
from api.material_routes import router as material_router

logger = get_logger("main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # 启动时执行
    logger.info(f"🚀 {settings.APP_NAME} v{settings.APP_VERSION} 启动中...")
    
    # 检查数据库连接
    if await check_db_connection():
        logger.info("✅ 数据库连接正常")
    else:
        logger.warning("⚠️ 数据库连接失败，请检查配置")
    
    # 初始化缓存（Redis）
    await init_cache()
    
    yield
    
    # 关闭时执行
    await close_db()
    await close_cache()
    logger.info(f"👋 {settings.APP_NAME} 已关闭")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="材料AI知识库系统 - 支持材料检索、论文分析和智能推荐",
    lifespan=lifespan,
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
)

# 配置全局异常处理
setup_exception_handlers(app)

# 添加请求日志中间件
@app.middleware("http")
async def requests_logger(request, call_next):
    return await log_requests(request, call_next)

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(router, prefix="/api/v1")
app.include_router(material_router, prefix="/api/v1")


@app.get("/")
async def root():
    """根路径"""
    return {
        "name": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "docs": "/docs",
        "health": "/health"
    }


@app.get("/health")
async def health_check():
    """健康检查"""
    db_status = await check_db_connection()
    
    return {
        "status": "healthy" if db_status else "unhealthy",
        "database": "connected" if db_status else "disconnected",
        "version": settings.APP_VERSION
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG
    )
