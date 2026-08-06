from fastapi import APIRouter

from api.endpoints import auth, search, documents, users, recommend, analysis
from api.endpoints import admin, doi

router = APIRouter()

# 认证相关
router.include_router(auth.router, prefix="/auth", tags=["认证"])

# 用户相关
router.include_router(users.router, prefix="/users", tags=["用户"])

# 搜索相关
router.include_router(search.router, prefix="/search", tags=["搜索"])

# 文档相关
router.include_router(documents.router, prefix="/documents", tags=["文档"])

# 推荐相关
router.include_router(recommend.router, prefix="/recommend", tags=["推荐"])

# 分析相关
router.include_router(analysis.router, prefix="/analysis", tags=["分析"])

# 管理端相关
router.include_router(admin.router, prefix="/admin", tags=["管理端"])

# DOI管理相关
router.include_router(doi.router, prefix="/admin", tags=["DOI管理"])
