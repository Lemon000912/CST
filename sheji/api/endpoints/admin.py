from fastapi import APIRouter, HTTPException, Header, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from datetime import datetime, timedelta
import os

from core.database import AsyncSessionLocal
from core.exceptions import success_response, AuthenticationError
from core.logging import get_logger
from services.auth_service import auth_service
from dal.user_dal import user_dal
from dal.paper_dal import paper_dal
from dal.pdf_index_dal import pdf_index_dal
from models.database import User, SearchHistory, Paper, PDFIndex
from sqlalchemy import text, func, desc

logger = get_logger("admin_api")
router = APIRouter()


async def get_admin_user(authorization: Optional[str] = Header(None)):
    """验证管理员权限"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="缺少认证令牌")
    
    token = authorization.replace("Bearer ", "")
    user = await auth_service.get_current_user(token)
    
    if not user:
        raise HTTPException(status_code=401, detail="无效的令牌")
    
    # TODO: 检查是否为管理员（可以添加is_admin字段到User模型）
    # 临时方案：admin用户为管理员
    if user.username != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    
    return user


# ==================== 仪表盘统计 ====================

@router.get("/stats", response_model=dict)
async def get_stats(authorization: Optional[str] = Header(None)):
    """
    获取统计信息（简化版）
    """
    try:
        async with AsyncSessionLocal() as session:
            # 用户统计
            user_count = await user_dal.count(session)
            
            # PDF统计
            pdf_stats = await pdf_index_dal.get_statistics(session)
            
            return success_response(data={
                "user_count": user_count,
                "paper_count": pdf_stats.get("total", 0),
                "processed_count": pdf_stats.get("processed", 0),
                "indexed_count": pdf_stats.get("indexed", 0)
            })
    except Exception as e:
        logger.error(f"获取统计失败: {e}")
        raise HTTPException(status_code=500, detail="获取统计失败")


@router.get("/dashboard", response_model=dict)
async def get_dashboard_stats(authorization: Optional[str] = Header(None)):
    """
    获取仪表盘统计数据
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            stats = {}
            
            # 用户统计
            user_count = await user_dal.count(session)
            active_users = await session.execute(
                text("SELECT COUNT(*) FROM users WHERE is_active = TRUE")
            )
            stats["users"] = {
                "total": user_count,
                "active": active_users.scalar()
            }
            
            # 论文统计 - 从 papers 表获取（15w文献的11个要素）
            paper_stats = await paper_dal.get_statistics(session)
            
            # DOI记录统计 - 从 doi_records 表获取（277万条）
            doi_count_result = await session.execute(
                text("SELECT COUNT(*) FROM doi_records")
            )
            doi_count = doi_count_result.scalar()
            
            # 合并论文统计：papers + doi_records
            stats["papers"] = {
                "total": paper_stats.get("total", 0) + doi_count,
                "local_papers": paper_stats.get("total", 0),  # 15w文献
                "doi_records": doi_count,  # 277万DOI
                "with_doi": paper_stats.get("with_doi", 0),
                "avg_citation": paper_stats.get("avg_citation", 0),
                "top_journals": paper_stats.get("top_journals", [])
            }
            
            # PDF索引统计 - 从 pdf_index 表获取
            pdf_stats = await pdf_index_dal.get_statistics(session)
            stats["pdf_index"] = pdf_stats
            
            # 今日搜索次数
            today = datetime.utcnow().date()
            today_searches = await session.execute(
                text("""
                    SELECT COUNT(*) FROM search_histories
                    WHERE DATE(created_at) = :today
                """),
                {"today": today}
            )
            stats["today_searches"] = today_searches.scalar()
            
            # 最近7天搜索趋势
            week_ago = datetime.utcnow() - timedelta(days=7)
            weekly_searches = await session.execute(
                text("""
                    SELECT DATE(created_at) as date, COUNT(*) as count
                    FROM search_histories
                    WHERE created_at >= :week_ago
                    GROUP BY DATE(created_at)
                    ORDER BY date
                """),
                {"week_ago": week_ago}
            )
            stats["weekly_trend"] = [
                {"date": str(row[0]), "count": row[1]}
                for row in weekly_searches.fetchall()
            ]
            
            return success_response(data=stats)
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取仪表盘数据失败: {e}")
        raise HTTPException(status_code=500, detail="获取仪表盘数据失败")


# ==================== 用户管理 ====================

@router.get("/users", response_model=dict)
async def list_users(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None, description="搜索用户名或邮箱"),
    is_active: Optional[bool] = Query(None),
    authorization: Optional[str] = Header(None)
):
    """
    获取用户列表（管理员）
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            # 构建查询
            sql = """
                SELECT id, username, email, created_at, last_active, is_active
                FROM users
                WHERE 1=1
            """
            params = {}
            
            if search:
                sql += " AND (username LIKE :search OR email LIKE :search)"
                params["search"] = f"%{search}%"
            
            if is_active is not None:
                sql += " AND is_active = :is_active"
                params["is_active"] = is_active
            
            sql += " ORDER BY created_at DESC LIMIT :limit OFFSET :skip"
            params["limit"] = limit
            params["skip"] = skip
            
            result = await session.execute(text(sql), params)
            rows = result.fetchall()
            
            users = []
            for row in rows:
                users.append({
                    "id": row[0],
                    "username": row[1],
                    "email": row[2],
                    "created_at": row[3].isoformat() if row[3] else None,
                    "last_active": row[4].isoformat() if row[4] else None,
                    "is_active": row[5]
                })
            
            # 获取总数
            count_sql = "SELECT COUNT(*) FROM users WHERE 1=1"
            count_params = {}
            if search:
                count_sql += " AND (username LIKE :search OR email LIKE :search)"
                count_params["search"] = f"%{search}%"
            if is_active is not None:
                count_sql += " AND is_active = :is_active"
                count_params["is_active"] = is_active
            
            count_result = await session.execute(text(count_sql), count_params)
            total = count_result.scalar()
            
            return success_response(data={
                "users": users,
                "total": total,
                "skip": skip,
                "limit": limit
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取用户列表失败: {e}")
        raise HTTPException(status_code=500, detail="获取用户列表失败")


@router.get("/users/{user_id}", response_model=dict)
async def get_user_detail(
    user_id: str,
    authorization: Optional[str] = Header(None)
):
    """
    获取用户详情（管理员）
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            user = await user_dal.get_by_id(session, user_id)
            
            if not user:
                raise HTTPException(status_code=404, detail="用户未找到")
            
            # 获取搜索历史数量
            search_count = await session.execute(
                text("SELECT COUNT(*) FROM search_histories WHERE user_id = :user_id"),
                {"user_id": user_id}
            )
            
            # 获取用户偏好
            preference = await session.execute(
                text("SELECT favorite_topics, theme FROM user_preferences WHERE user_id = :user_id"),
                {"user_id": user_id}
            )
            pref_row = preference.fetchone()
            
            return success_response(data={
                "id": user.id,
                "username": user.username,
                "email": user.email,
                "created_at": user.created_at.isoformat() if user.created_at else None,
                "last_active": user.last_active.isoformat() if user.last_active else None,
                "is_active": user.is_active,
                "search_count": search_count.scalar(),
                "preferences": {
                    "favorite_topics": pref_row[0] if pref_row else None,
                    "theme": pref_row[1] if pref_row else "light"
                }
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取用户详情失败: {e}")
        raise HTTPException(status_code=500, detail="获取用户详情失败")


class UpdateUserRequest(BaseModel):
    email: Optional[str] = None
    is_active: Optional[bool] = None


@router.put("/users/{user_id}", response_model=dict)
async def update_user(
    user_id: str,
    request: UpdateUserRequest,
    authorization: Optional[str] = Header(None)
):
    """
    更新用户信息（管理员）
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            user = await user_dal.get_by_id(session, user_id)
            
            if not user:
                raise HTTPException(status_code=404, detail="用户未找到")
            
            # 更新数据
            update_data = {}
            if request.email is not None:
                update_data["email"] = request.email
            if request.is_active is not None:
                update_data["is_active"] = request.is_active
            
            if update_data:
                await user_dal.update(session, user_id, update_data)
                await session.commit()
            
            logger.info(f"管理员更新用户 {user_id}: {update_data}")
            return success_response(message="用户更新成功")
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新用户失败: {e}")
        raise HTTPException(status_code=500, detail="更新用户失败")


@router.delete("/users/{user_id}", response_model=dict)
async def delete_user(
    user_id: str,
    authorization: Optional[str] = Header(None)
):
    """
    删除用户（管理员）
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            # 不允许删除admin用户
            user = await user_dal.get_by_id(session, user_id)
            if user and user.username == "admin":
                raise HTTPException(status_code=403, detail="不能删除管理员账号")
            
            success = await user_dal.delete(session, user_id)
            await session.commit()
            
            if success:
                logger.info(f"管理员删除用户 {user_id}")
                return success_response(message="用户删除成功")
            else:
                raise HTTPException(status_code=404, detail="用户未找到")
                
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除用户失败: {e}")
        raise HTTPException(status_code=500, detail="删除用户失败")


# ==================== 搜索日志监控 ====================

@router.get("/logs/searches", response_model=dict)
async def get_search_logs(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    user_id: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None)
):
    """
    获取搜索日志
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            sql = """
                SELECT sh.id, sh.query, sh.source, sh.results_count, 
                       sh.search_time, sh.created_at, u.username
                FROM search_histories sh
                LEFT JOIN users u ON sh.user_id = u.id
                WHERE 1=1
            """
            params = {}
            
            if user_id:
                sql += " AND sh.user_id = :user_id"
                params["user_id"] = user_id
            
            if date_from:
                sql += " AND DATE(sh.created_at) >= :date_from"
                params["date_from"] = date_from
            
            if date_to:
                sql += " AND DATE(sh.created_at) <= :date_to"
                params["date_to"] = date_to
            
            sql += " ORDER BY sh.created_at DESC LIMIT :limit OFFSET :skip"
            params["limit"] = limit
            params["skip"] = skip
            
            result = await session.execute(text(sql), params)
            rows = result.fetchall()
            
            logs = []
            for row in rows:
                logs.append({
                    "id": row[0],
                    "query": row[1],
                    "source": row[2],
                    "results_count": row[3],
                    "search_time": row[4],
                    "created_at": row[5].isoformat() if row[5] else None,
                    "username": row[6]
                })
            
            return success_response(data={
                "logs": logs,
                "total": len(logs)
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取搜索日志失败: {e}")
        raise HTTPException(status_code=500, detail="获取搜索日志失败")


@router.get("/logs/searches/stats", response_model=dict)
async def get_search_stats(
    days: int = Query(7, ge=1, le=30),
    authorization: Optional[str] = Header(None)
):
    """
    获取搜索统计
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            # 使用参数化查询，通过日期计算
            from datetime import datetime, timedelta
            date_from = datetime.utcnow() - timedelta(days=days)
            
            # 热门搜索词
            hot_queries = await session.execute(
                text("""
                    SELECT query, COUNT(*) as count
                    FROM search_histories
                    WHERE created_at >= :date_from
                    GROUP BY query
                    ORDER BY count DESC
                    LIMIT 20
                """),
                {"date_from": date_from}
            )
            
            # 搜索来源分布
            source_dist = await session.execute(
                text("""
                    SELECT source, COUNT(*) as count
                    FROM search_histories
                    WHERE created_at >= :date_from
                    GROUP BY source
                """),
                {"date_from": date_from}
            )
            
            # 每日搜索量
            daily_stats = await session.execute(
                text("""
                    SELECT DATE(created_at) as date, COUNT(*) as count
                    FROM search_histories
                    WHERE created_at >= :date_from
                    GROUP BY DATE(created_at)
                    ORDER BY date
                """),
                {"date_from": date_from}
            )
            
            return success_response(data={
                "hot_queries": [{"query": row[0], "count": row[1]} for row in hot_queries.fetchall()],
                "source_distribution": [{"source": row[0], "count": row[1]} for row in source_dist.fetchall()],
                "daily_stats": [{"date": str(row[0]), "count": row[1]} for row in daily_stats.fetchall()]
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取搜索统计失败: {e}")
        raise HTTPException(status_code=500, detail="获取搜索统计失败")


# ==================== 错误日志查看 ====================

@router.get("/logs/errors", response_model=dict)
async def get_error_logs(
    lines: int = Query(100, ge=1, le=1000),
    authorization: Optional[str] = Header(None)
):
    """
    获取错误日志
    """
    try:
        await get_admin_user(authorization)
        
        from core.config import settings
        
        error_log_file = os.path.join(os.path.dirname(settings.LOG_FILE), "error.log")
        
        if not os.path.exists(error_log_file):
            return success_response(data={"logs": [], "message": "错误日志文件不存在"})
        
        # 读取日志文件最后N行
        with open(error_log_file, "r", encoding="utf-8") as f:
            all_lines = f.readlines()
            last_lines = all_lines[-lines:]
        
        # 解析日志条目
        logs = []
        for line in last_lines:
            line = line.strip()
            if line:
                logs.append(line)
        
        return success_response(data={
            "logs": logs,
            "total_lines": len(logs),
            "file": error_log_file
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取错误日志失败: {e}")
        raise HTTPException(status_code=500, detail="获取错误日志失败")


@router.get("/logs/system", response_model=dict)
async def get_system_logs(
    lines: int = Query(100, ge=1, le=1000),
    level: Optional[str] = Query(None, description="日志级别过滤"),
    authorization: Optional[str] = Header(None)
):
    """
    获取系统日志
    """
    try:
        await get_admin_user(authorization)
        
        from core.config import settings
        
        if not os.path.exists(settings.LOG_FILE):
            return success_response(data={"logs": [], "message": "日志文件不存在"})
        
        with open(settings.LOG_FILE, "r", encoding="utf-8") as f:
            all_lines = f.readlines()
            last_lines = all_lines[-lines:]
        
        logs = []
        for line in last_lines:
            line = line.strip()
            if line:
                if level and level.upper() not in line:
                    continue
                logs.append(line)
        
        return success_response(data={
            "logs": logs,
            "total_lines": len(logs),
            "file": settings.LOG_FILE
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取系统日志失败: {e}")
        raise HTTPException(status_code=500, detail="获取系统日志失败")


# ==================== PDF文献分类管理 ====================

@router.get("/pdfs", response_model=dict)
async def list_pdfs(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    is_processed: Optional[bool] = Query(None),
    is_indexed: Optional[bool] = Query(None),
    year_from: Optional[int] = Query(None),
    year_to: Optional[int] = Query(None),
    category: Optional[str] = Query(None, description="9大领域筛选"),
    material_name: Optional[str] = Query(None, description="材料名称搜索"),
    search: Optional[str] = Query(None, description="综合搜索（DOI、标题、材料名称）"),
    authorization: Optional[str] = Header(None)
):
    """
    获取PDF文献列表（管理员）- 支持11个关键词和9大领域筛选
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            sql = """
                SELECT id, filename, relative_path, file_size, title, doi,
                       publish_year, is_processed, is_indexed, created_at,
                       material_name, symmetry_phase, structure_descriptor,
                       properties, applications, synthesis_method,
                       characterization_method, quality_control,
                       first_author, corresponding_author, category
                FROM pdf_index
                WHERE 1=1
            """
            params = {}
            
            if is_processed is not None:
                sql += " AND is_processed = :is_processed"
                params["is_processed"] = is_processed
            
            if is_indexed is not None:
                sql += " AND is_indexed = :is_indexed"
                params["is_indexed"] = is_indexed
            
            if year_from is not None:
                sql += " AND publish_year >= :year_from"
                params["year_from"] = year_from
            
            if year_to is not None:
                sql += " AND publish_year <= :year_to"
                params["year_to"] = year_to
            
            if category:
                sql += " AND category = :category"
                params["category"] = category
            
            if material_name:
                sql += " AND material_name LIKE :material_name"
                params["material_name"] = f"%{material_name}%"
            
            if search:
                sql += " AND (doi LIKE :search OR title LIKE :search OR material_name LIKE :search)"
                params["search"] = f"%{search}%"
            
            sql += " ORDER BY created_at DESC LIMIT :limit OFFSET :skip"
            params["limit"] = limit
            params["skip"] = skip
            
            result = await session.execute(text(sql), params)
            rows = result.fetchall()
            
            pdfs = []
            for row in rows:
                pdfs.append({
                    "id": row[0],
                    "filename": row[1],
                    "relative_path": row[2],
                    "file_size": row[3],
                    "title": row[4],
                    "doi": row[5],
                    "publish_year": row[6],
                    "is_processed": row[7],
                    "is_indexed": row[8],
                    "created_at": row[9].isoformat() if row[9] else None,
                    # 11个关键词
                    "material_name": row[10],
                    "symmetry_phase": row[11],
                    "structure_descriptor": row[12],
                    "properties": row[13],
                    "applications": row[14],
                    "synthesis_method": row[15],
                    "characterization_method": row[16],
                    "quality_control": row[17],
                    "first_author": row[18],
                    "corresponding_author": row[19],
                    "category": row[20]
                })
            
            # 获取总数
            count_sql = "SELECT COUNT(*) FROM pdf_index WHERE 1=1"
            count_params = {}
            if is_processed is not None:
                count_sql += " AND is_processed = :is_processed"
                count_params["is_processed"] = is_processed
            if is_indexed is not None:
                count_sql += " AND is_indexed = :is_indexed"
                count_params["is_indexed"] = is_indexed
            if year_from is not None:
                count_sql += " AND publish_year >= :year_from"
                count_params["year_from"] = year_from
            if year_to is not None:
                count_sql += " AND publish_year <= :year_to"
                count_params["year_to"] = year_to
            if category:
                count_sql += " AND category = :category"
                count_params["category"] = category
            if material_name:
                count_sql += " AND material_name LIKE :material_name"
                count_params["material_name"] = f"%{material_name}%"
            if search:
                count_sql += " AND (doi LIKE :search OR title LIKE :search OR material_name LIKE :search)"
                count_params["search"] = f"%{search}%"
            
            count_result = await session.execute(text(count_sql), count_params)
            total = count_result.scalar()
            
            return success_response(data={
                "pdfs": pdfs,
                "total": total,
                "skip": skip,
                "limit": limit
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取PDF列表失败: {e}")
        raise HTTPException(status_code=500, detail="获取PDF列表失败")


# 9大领域中文映射
CATEGORY_NAMES = {
    'amorphous_glass': '非晶玻璃',
    'composite_multiphase': '复合多相材料',
    'solid_state_ionic': '固态离子材料',
    'optical_optoelectronic': '光学/光电材料',
    'alloy_metallic': '合金/金属材料',
    'ceramic_structural': '结构陶瓷',
    'nanomaterials_lowdim': '低维纳米材料',
    'polymer_soft_matter': '高分子/软物质',
    'surface_thin_film': '表面/薄膜材料'
}

@router.get("/pdfs/categories", response_model=dict)
async def get_pdf_categories(authorization: Optional[str] = Header(None)):
    """
    获取PDF分类统计（9大领域 + 11个关键词统计）
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            # 按年份分布
            year_dist = await session.execute(
                text("""
                    SELECT publish_year, COUNT(*) as count
                    FROM pdf_index
                    WHERE publish_year IS NOT NULL
                    GROUP BY publish_year
                    ORDER BY publish_year DESC
                    LIMIT 20
                """)
            )
            
            # 处理状态分布
            process_dist = await session.execute(
                text("""
                    SELECT is_processed, COUNT(*) as count
                    FROM pdf_index
                    GROUP BY is_processed
                """)
            )
            
            # 索引状态分布
            index_dist = await session.execute(
                text("""
                    SELECT is_indexed, COUNT(*) as count
                    FROM pdf_index
                    GROUP BY is_indexed
                """)
            )
            
            # 文件大小分布
            size_dist = await session.execute(
                text("""
                    SELECT 
                        CASE 
                            WHEN file_size < 1024*1024 THEN '< 1MB'
                            WHEN file_size < 10*1024*1024 THEN '1-10MB'
                            WHEN file_size < 50*1024*1024 THEN '10-50MB'
                            ELSE '> 50MB'
                        END as size_range,
                        COUNT(*) as count
                    FROM pdf_index
                    GROUP BY size_range
                """)
            )
            
            # 9大领域分布
            category_dist = await session.execute(
                text("""
                    SELECT category, COUNT(*) as count
                    FROM pdf_index
                    WHERE category IS NOT NULL
                    GROUP BY category
                """)
            )
            
            # 11个关键词填充率统计
            keyword_stats = {}
            keyword_fields = [
                'material_name', 'symmetry_phase', 'structure_descriptor',
                'properties', 'applications', 'synthesis_method',
                'characterization_method', 'quality_control',
                'first_author', 'corresponding_author'
            ]
            
            for field in keyword_fields:
                result = await session.execute(
                    text(f"""
                        SELECT COUNT(*) FROM pdf_index
                        WHERE {field} IS NOT NULL AND {field} != ''
                    """)
                )
                keyword_stats[field] = result.scalar()
            
            return success_response(data={
                "year_distribution": [{"year": row[0], "count": row[1]} for row in year_dist.fetchall()],
                "process_distribution": [{"status": "已处理" if row[0] else "未处理", "count": row[1]} for row in process_dist.fetchall()],
                "index_distribution": [{"status": "已索引" if row[0] else "未索引", "count": row[1]} for row in index_dist.fetchall()],
                "size_distribution": [{"range": row[0], "count": row[1]} for row in size_dist.fetchall()],
                "category_distribution": [
                    {"category": CATEGORY_NAMES.get(row[0], row[0]), "count": row[1]} 
                    for row in category_dist.fetchall()
                ],
                "keyword_stats": keyword_stats
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取PDF分类统计失败: {e}")
        raise HTTPException(status_code=500, detail="获取PDF分类统计失败")


@router.get("/pdfs/{pdf_id}", response_model=dict)
async def get_pdf_detail(
    pdf_id: str,
    authorization: Optional[str] = Header(None)
):
    """
    获取PDF文献详情
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("""
                    SELECT id, filename, relative_path, file_size, title, doi,
                           publish_year, is_processed, is_indexed, created_at,
                           material_name, symmetry_phase, structure_descriptor,
                           properties, applications, synthesis_method,
                           characterization_method, quality_control,
                           first_author, corresponding_author, category
                    FROM pdf_index
                    WHERE id = :id
                """),
                {"id": pdf_id}
            )
            row = result.fetchone()
            
            if not row:
                raise HTTPException(status_code=404, detail="PDF文献不存在")
            
            pdf = {
                "id": row[0],
                "filename": row[1],
                "relative_path": row[2],
                "file_size": row[3],
                "title": row[4],
                "doi": row[5],
                "publish_year": row[6],
                "is_processed": row[7],
                "is_indexed": row[8],
                "created_at": row[9].isoformat() if row[9] else None,
                "material_name": row[10],
                "symmetry_phase": row[11],
                "structure_descriptor": row[12],
                "properties": row[13],
                "applications": row[14],
                "synthesis_method": row[15],
                "characterization_method": row[16],
                "quality_control": row[17],
                "first_author": row[18],
                "corresponding_author": row[19],
                "category": row[20]
            }
            
            return success_response(data=pdf)
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取PDF详情失败: {e}")
        raise HTTPException(status_code=500, detail="获取PDF详情失败")


@router.post("/pdfs/{pdf_id}/process", response_model=dict)
async def process_pdf(
    pdf_id: str,
    authorization: Optional[str] = Header(None)
):
    """
    手动触发PDF处理
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            success = await pdf_index_dal.mark_as_processed(session, pdf_id)
            await session.commit()
            
            if success:
                logger.info(f"管理员手动处理PDF: {pdf_id}")
                return success_response(message="PDF处理标记成功")
            else:
                raise HTTPException(status_code=404, detail="PDF未找到")
                
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"处理PDF失败: {e}")
        raise HTTPException(status_code=500, detail="处理PDF失败")


@router.delete("/pdfs/{pdf_id}", response_model=dict)
async def delete_pdf(
    pdf_id: str,
    authorization: Optional[str] = Header(None)
):
    """
    删除PDF文献
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("DELETE FROM pdf_index WHERE id = :id RETURNING id"),
                {"id": pdf_id}
            )
            deleted = result.fetchone()
            
            if not deleted:
                raise HTTPException(status_code=404, detail="PDF文献不存在")
            
            await session.commit()
            
            logger.info(f"管理员删除PDF文献: {pdf_id}")
            return success_response(message="PDF文献删除成功")
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除PDF失败: {e}")
        raise HTTPException(status_code=500, detail="删除PDF失败")


class BatchDOIRequest(BaseModel):
    dois: List[Dict[str, str]]


@router.post("/pdfs/batch", response_model=dict)
async def batch_import_dois(
    request: BatchDOIRequest,
    authorization: Optional[str] = Header(None)
):
    """
    批量导入DOI到doi_records表
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            imported = 0
            skipped = 0
            
            for item in request.dois:
                doi = item.get("doi", "").strip()
                title = item.get("title", "").strip()
                
                if not doi:
                    skipped += 1
                    continue
                
                # 检查是否已存在
                existing = await session.execute(
                    text("SELECT id FROM doi_records WHERE doi = :doi"),
                    {"doi": doi}
                )
                if existing.fetchone():
                    skipped += 1
                    continue
                
                # 插入新记录
                await session.execute(
                    text("""
                        INSERT INTO doi_records (doi, title, imported_at)
                        VALUES (:doi, :title, NOW())
                    """),
                    {"doi": doi, "title": title}
                )
                imported += 1
            
            await session.commit()
            
            logger.info(f"批量导入DOI: 成功 {imported} 条, 跳过 {skipped} 条")
            return success_response(data={
                "imported": imported,
                "skipped": skipped,
                "total": len(request.dois)
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"批量导入DOI失败: {e}")
        raise HTTPException(status_code=500, detail="批量导入DOI失败")


# ==================== 关键词管理 ====================

@router.get("/keywords", response_model=dict)
async def list_keywords(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: Optional[str] = Query(None),
    authorization: Optional[str] = Header(None)
):
    """
    获取关键词列表（管理员）
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            sql = """
                SELECT id, word, frequency
                FROM keywords
                WHERE 1=1
            """
            params = {}
            
            if search:
                sql += " AND word LIKE :search"
                params["search"] = f"%{search}%"
            
            sql += " ORDER BY frequency DESC LIMIT :limit OFFSET :skip"
            params["limit"] = limit
            params["skip"] = skip
            
            result = await session.execute(text(sql), params)
            rows = result.fetchall()
            
            keywords = []
            for row in rows:
                keywords.append({
                    "id": row[0],
                    "word": row[1],
                    "frequency": row[2]
                })
            
            # 获取总数
            count_sql = "SELECT COUNT(*) FROM keywords WHERE 1=1"
            count_params = {}
            if search:
                count_sql += " AND word LIKE :search"
                count_params["search"] = f"%{search}%"
            
            count_result = await session.execute(text(count_sql), count_params)
            total = count_result.scalar()
            
            return success_response(data={
                "keywords": keywords,
                "total": total,
                "skip": skip,
                "limit": limit
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取关键词列表失败: {e}")
        raise HTTPException(status_code=500, detail="获取关键词列表失败")


@router.get("/keywords/top", response_model=dict)
async def get_top_keywords(
    limit: int = Query(50, ge=1, le=200),
    authorization: Optional[str] = Header(None)
):
    """
    获取热门关键词
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            from dal.keyword_dal import keyword_dal
            keywords = await keyword_dal.get_top_keywords(session, limit)
            
            return success_response(data={
                "keywords": [
                    {"id": k.id, "word": k.word, "frequency": k.frequency}
                    for k in keywords
                ]
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取热门关键词失败: {e}")
        raise HTTPException(status_code=500, detail="获取热门关键词失败")


@router.delete("/keywords/{keyword_id}", response_model=dict)
async def delete_keyword(
    keyword_id: str,
    authorization: Optional[str] = Header(None)
):
    """
    删除关键词（管理员）
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            from dal.keyword_dal import keyword_dal
            success = await keyword_dal.delete(session, keyword_id)
            await session.commit()
            
            if success:
                logger.info(f"管理员删除关键词: {keyword_id}")
                return success_response(message="关键词删除成功")
            else:
                raise HTTPException(status_code=404, detail="关键词未找到")
                
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除关键词失败: {e}")
        raise HTTPException(status_code=500, detail="删除关键词失败")


# ==================== 系统配置 ====================

@router.get("/config", response_model=dict)
async def get_system_config(authorization: Optional[str] = Header(None)):
    """
    获取系统配置（管理员）
    """
    try:
        await get_admin_user(authorization)
        
        from core.config import settings
        
        # 返回非敏感配置
        return success_response(data={
            "app_name": settings.APP_NAME,
            "app_version": settings.APP_VERSION,
            "debug": settings.DEBUG,
            "database": settings.MYSQL_DATABASE,
            "max_search_results": settings.MAX_SEARCH_RESULTS,
            "search_timeout": settings.SEARCH_TIMEOUT,
            "log_level": settings.LOG_LEVEL
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取系统配置失败: {e}")
        raise HTTPException(status_code=500, detail="获取系统配置失败")
