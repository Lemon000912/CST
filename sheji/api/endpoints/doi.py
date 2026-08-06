"""
DOI管理API - 查询doi_records表
"""
from fastapi import APIRouter, HTTPException, Header, Query
from typing import Optional, List
from core.database import AsyncSessionLocal
from core.exceptions import success_response
from core.logging import get_logger
from api.endpoints.admin import get_admin_user
from sqlalchemy import text, func, desc

logger = get_logger("doi_api")
router = APIRouter()


@router.get("/dois", response_model=dict)
async def list_dois(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    search: Optional[str] = Query(None, description="搜索DOI或标题"),
    journal: Optional[str] = Query(None, description="期刊筛选"),
    year_from: Optional[int] = Query(None, description="起始年份"),
    year_to: Optional[int] = Query(None, description="结束年份"),
    authorization: Optional[str] = Header(None)
):
    """
    获取DOI列表（从doi_records表）
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            # 构建查询条件
            where_clauses = []
            params = {}
            
            if search:
                where_clauses.append("(doi ILIKE :search OR title ILIKE :search)")
                params["search"] = f"%{search}%"
            
            if journal:
                where_clauses.append("journal ILIKE :journal")
                params["journal"] = f"%{journal}%"
            
            if year_from:
                where_clauses.append("year >= :year_from")
                params["year_from"] = year_from
            
            if year_to:
                where_clauses.append("year <= :year_to")
                params["year_to"] = year_to
            
            where_sql = ""
            if where_clauses:
                where_sql = "WHERE " + " AND ".join(where_clauses)
            
            # 查询数据
            sql = f"""
                SELECT id, title, doi, authors, journal, year, publish_date, url, imported_at
                FROM doi_records
                {where_sql}
                ORDER BY imported_at DESC
                LIMIT :limit OFFSET :skip
            """
            params["limit"] = limit
            params["skip"] = skip
            
            result = await session.execute(text(sql), params)
            rows = result.fetchall()
            
            dois = []
            for row in rows:
                dois.append({
                    "id": row[0],
                    "title": row[1],
                    "doi": row[2],
                    "authors": row[3],
                    "journal": row[4],
                    "year": row[5],
                    "publish_date": str(row[6]) if row[6] else None,
                    "url": row[7],
                    "imported_at": str(row[8]) if row[8] else None
                })
            
            # 获取总数
            count_sql = f"SELECT COUNT(*) FROM doi_records {where_sql}"
            count_params = {k: v for k, v in params.items() if k not in ["limit", "skip"]}
            count_result = await session.execute(text(count_sql), count_params)
            total = count_result.scalar()
            
            return success_response(data={
                "dois": dois,
                "total": total,
                "skip": skip,
                "limit": limit
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取DOI列表失败: {e}")
        raise HTTPException(status_code=500, detail="获取DOI列表失败")


@router.get("/dois/statistics", response_model=dict)
async def get_doi_statistics(
    authorization: Optional[str] = Header(None)
):
    """
    获取DOI统计信息
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            # 总数
            total = await session.execute(text("SELECT COUNT(*) FROM doi_records"))
            total_count = total.scalar()
            
            # 按年份统计
            year_stats = await session.execute(
                text("""
                    SELECT year, COUNT(*) as count
                    FROM doi_records
                    WHERE year IS NOT NULL
                    GROUP BY year
                    ORDER BY year DESC
                    LIMIT 10
                """)
            )
            years = [{"year": row[0], "count": row[1]} for row in year_stats.fetchall()]
            
            # 按期刊统计Top10
            journal_stats = await session.execute(
                text("""
                    SELECT journal, COUNT(*) as count
                    FROM doi_records
                    WHERE journal IS NOT NULL
                    GROUP BY journal
                    ORDER BY count DESC
                    LIMIT 10
                """)
            )
            journals = [{"journal": row[0], "count": row[1]} for row in journal_stats.fetchall()]
            
            return success_response(data={
                "total": total_count,
                "years": years,
                "journals": journals
            })
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取DOI统计失败: {e}")
        raise HTTPException(status_code=500, detail="获取DOI统计失败")


@router.get("/dois/{doi_id}", response_model=dict)
async def get_doi_detail(
    doi_id: int,
    authorization: Optional[str] = Header(None)
):
    """
    获取DOI详情
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("""
                    SELECT id, title, doi, authors, journal, year, publish_date, url, imported_at
                    FROM doi_records
                    WHERE id = :id
                """),
                {"id": doi_id}
            )
            row = result.fetchone()
            
            if not row:
                raise HTTPException(status_code=404, detail="DOI记录不存在")
            
            doi = {
                "id": row[0],
                "title": row[1],
                "doi": row[2],
                "authors": row[3],
                "journal": row[4],
                "year": row[5],
                "publish_date": str(row[6]) if row[6] else None,
                "url": row[7],
                "imported_at": str(row[8]) if row[8] else None
            }
            
            return success_response(data=doi)
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取DOI详情失败: {e}")
        raise HTTPException(status_code=500, detail="获取DOI详情失败")


@router.delete("/dois/{doi_id}", response_model=dict)
async def delete_doi(
    doi_id: int,
    authorization: Optional[str] = Header(None)
):
    """
    删除DOI记录
    """
    try:
        await get_admin_user(authorization)
        
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("DELETE FROM doi_records WHERE id = :id RETURNING id"),
                {"id": doi_id}
            )
            deleted = result.fetchone()
            
            if not deleted:
                raise HTTPException(status_code=404, detail="DOI记录不存在")
            
            await session.commit()
            
            return success_response(message="删除成功")
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除DOI失败: {e}")
        raise HTTPException(status_code=500, detail="删除DOI失败")
