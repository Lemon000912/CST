#!/usr/bin/env python3
"""
PostgreSQL数据库表初始化脚本
"""

import asyncio
import sys
import os
from datetime import datetime
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import select

from models.database import (
    Base, User, UserPreference, UserMemory,
    PDFIndex, AnalysisResult, MaterialCategory,
)
from core.config import settings


def generate_id():
    return str(uuid.uuid4())


async def init_tables():
    engine = create_async_engine(
        settings.DATABASE_URL,
        pool_size=20, max_overflow=10, pool_pre_ping=True,
    )
    
    print("[Step 1] Creating tables...")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("[OK] All tables created")
    
    AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    
    async with AsyncSessionLocal() as session:
        print("\n[Step 2] Initializing material categories...")
        await init_categories(session)
        
        print("\n[Step 3] Creating admin user...")
        await init_admin(session)
        
        print("\n[Step 4] Initializing sample PDFs...")
        await init_sample_pdfs(session)
        
        print("\n[Step 5] Initializing sample analysis...")
        await init_sample_analysis(session)
    
    await engine.dispose()
    print("\n" + "=" * 60)
    print("[OK] PostgreSQL initialization completed!")
    print("=" * 60)


async def init_categories(session):
    """初始化9大领域 - 跳过已存在的"""
    categories = [
        {'code': 'alloy_metallic', 'name': '合金/金属材料', 'name_en': 'Alloy and Metallic Materials',
         'description': '包括各种金属合金、钢铁材料、有色金属及其合金等'},
        {'code': 'amorphous_glass', 'name': '非晶玻璃', 'name_en': 'Amorphous Glass',
         'description': '非晶态材料、金属玻璃、氧化物玻璃等'},
        {'code': 'ceramic_structural', 'name': '结构陶瓷', 'name_en': 'Structural Ceramics',
         'description': '氧化物陶瓷、非氧化物陶瓷、结构功能一体化陶瓷等'},
        {'code': 'composite_multiphase', 'name': '多相复合材料', 'name_en': 'Multiphase Composite Materials',
         'description': '金属基复合材料、陶瓷基复合材料、聚合物基复合材料等'},
        {'code': 'nanomaterials_lowdim', 'name': '低维纳米材料', 'name_en': 'Low-dimensional Nanomaterials',
         'description': '纳米颗粒、纳米线、纳米管、石墨烯、二维材料等'},
        {'code': 'optical_optoelectronic', 'name': '光电材料', 'name_en': 'Optical and Optoelectronic Materials',
         'description': '半导体材料、光电转换材料、发光材料、光学晶体等'},
        {'code': 'polymer_soft_matter', 'name': '软物质高分子', 'name_en': 'Soft Matter and Polymers',
         'description': '高分子材料、生物材料、胶体、液晶等软物质'},
        {'code': 'solid_state_ionic', 'name': '固态离子材料', 'name_en': 'Solid State Ionic Materials',
         'description': '固态电解质、离子导体、燃料电池材料、电池材料等'},
        {'code': 'surface_thin_film', 'name': '表面与薄膜材料', 'name_en': 'Surface and Thin Film Materials',
         'description': '薄膜材料、涂层、表面改性、界面材料等'}
    ]
    
    added = 0
    for cat_data in categories:
        result = await session.execute(
            select(MaterialCategory).where(MaterialCategory.code == cat_data['code'])
        )
        if not result.scalar_one_or_none():
            cat = MaterialCategory(id=generate_id(), **cat_data)
            session.add(cat)
            added += 1
    
    await session.commit()
    print(f"[OK] {added} new categories added (skipped {len(categories) - added} existing)")


async def init_admin(session):
    """创建管理员 - 如果已存在则跳过"""
    from services.auth_service import auth_service
    
    result = await session.execute(select(User).where(User.username == 'admin'))
    if result.scalar_one_or_none():
        print("[OK] Admin user already exists")
        return
    
    admin_id = generate_id()
    admin = User(
        id=admin_id, username='admin', email='admin@materialkb.com',
        password_hash=auth_service.hash_password('admin123'),
        created_at=datetime.utcnow(), last_active=datetime.utcnow(), is_active=True
    )
    session.add(admin)
    
    pref = UserPreference(
        id=generate_id(), user_id=admin_id,
        favorite_topics='["合金材料", "纳米技术"]',
        search_filters='{"language": "zh", "year_range": "2020-2024"}',
        theme='dark'
    )
    session.add(pref)
    
    memory = UserMemory(
        id=generate_id(), user_id=admin_id,
        historical_topics='["合金材料", "纳米技术", "固态电解质"]',
        preferences='{"preferred_categories": ["alloy_metallic", "nanomaterials_lowdim"], "result_count": 20}',
        search_patterns='{"common_keywords": ["强度", "导电性"], "search_frequency": {"合金": 5, "纳米": 3}}',
        memory_summary='用户主要关注合金材料和纳米材料领域，经常查询材料力学性能和电化学性能相关文献。'
    )
    session.add(memory)
    
    await session.commit()
    print("[OK] Admin user created (admin / admin123)")


async def init_sample_pdfs(session):
    """初始化示例PDF - 如果已存在则跳过"""
    import json
    
    result = await session.execute(select(PDFIndex).limit(1))
    if result.scalar_one_or_none():
        print("[OK] Sample PDFs already exist")
        return
    
    pdfs = [
        {
            'filename': 'alloy_strength_2023.pdf',
            'relative_path': 'alloy_metallic/2023/alloy_strength_2023.pdf',
            'title': '高强度钛合金的微观结构与力学性能研究',
            'authors': json.dumps(["张三", "李四", "王五"]),
            'doi': '10.1000/alloy001',
            'abstract': '本文研究了新型钛合金的微观结构特征及其对力学性能的影响...',
            'keywords': json.dumps(["钛合金", "微观结构", "力学性能"]),
            'publish_year': 2023,
            'material_name': 'Ti-6Al-4V钛合金',
            'symmetry_phase': '六方密堆积(HCP)',
            'structure_descriptor': 'α+β双相结构，晶粒尺寸约10μm',
            'properties': '抗拉强度: 1100MPa, 屈服强度: 950MPa, 延伸率: 12%',
            'applications': '航空航天结构件、医疗器械',
            'synthesis_method': '真空电弧熔炼 + 热轧工艺',
            'characterization_method': 'XRD, SEM, TEM, 拉伸试验',
            'quality_control': '超声波探伤、化学成分分析',
            'first_author': '张三',
            'corresponding_author': '李四',
            'category': 'alloy_metallic',
            'is_processed': True, 'is_indexed': True,
            'file_hash': 'abc123def456'
        },
        {
            'filename': 'nanowire_electronic_2024.pdf',
            'relative_path': 'nanomaterials_lowdim/2024/nanowire_electronic_2024.pdf',
            'title': '硅纳米线场效应晶体管的电学特性研究',
            'authors': json.dumps(["赵六", "钱七"]),
            'doi': '10.1000/nano001',
            'abstract': '制备了直径为20nm的硅纳米线，并研究了其场效应晶体管特性...',
            'keywords': json.dumps(["硅纳米线", "场效应晶体管", "纳米电子学"]),
            'publish_year': 2024,
            'material_name': '硅纳米线(SiNW)',
            'symmetry_phase': '金刚石立方结构',
            'structure_descriptor': '直径20nm，长度5μm，<111>取向',
            'properties': '载流子迁移率: 800 cm2/V·s, 开关比: 10^6',
            'applications': '纳米电子器件、传感器、太阳能电池',
            'synthesis_method': '化学气相沉积(CVD) + 金催化生长',
            'characterization_method': 'SEM, TEM, AFM, 电学测试',
            'quality_control': '直径分布统计、电学性能均匀性测试',
            'first_author': '赵六',
            'corresponding_author': '钱七',
            'category': 'nanomaterials_lowdim',
            'is_processed': True, 'is_indexed': True,
            'file_hash': 'ghi789jkl012'
        },
        {
            'filename': 'solid_electrolyte_2023.pdf',
            'relative_path': 'solid_state_ionic/2023/solid_electrolyte_2023.pdf',
            'title': '硫化物固态电解质的离子传导机制研究',
            'authors': json.dumps(["孙八", "周九", "吴十"]),
            'doi': '10.1000/ionic001',
            'abstract': '通过第一性原理计算和实验验证，揭示了硫化物固态电解质的高离子传导机制...',
            'keywords': json.dumps(["固态电解质", "硫化物", "离子传导", "全固态电池"]),
            'publish_year': 2023,
            'material_name': 'Li6PS5Cl',
            'symmetry_phase': '立方相',
            'structure_descriptor': 'argyrodite型结构，空间群F-43m',
            'properties': '离子电导率: 10 mS/cm, 电化学窗口: 0-5V',
            'applications': '全固态锂电池、固态钠电池',
            'synthesis_method': '高能球磨 + 热处理',
            'characterization_method': 'XRD, Raman, EIS, 固态NMR',
            'quality_control': '离子电导率测试、空气稳定性评估',
            'first_author': '孙八',
            'corresponding_author': '周九',
            'category': 'solid_state_ionic',
            'is_processed': True, 'is_indexed': True,
            'file_hash': 'mno345pqr678'
        }
    ]
    
    for pdf_data in pdfs:
        pdf = PDFIndex(id=generate_id(), **pdf_data)
        session.add(pdf)
    
    await session.commit()
    print(f"[OK] {len(pdfs)} sample PDFs initialized")


async def init_sample_analysis(session):
    """初始化示例分析结果"""
    import json
    
    result = await session.execute(select(AnalysisResult).limit(1))
    if result.scalar_one_or_none():
        print("[OK] Sample analysis already exists")
        return
    
    result = await session.execute(select(User).where(User.username == 'admin'))
    admin = result.scalar_one_or_none()
    
    result = await session.execute(select(PDFIndex).limit(1))
    pdf = result.scalar_one_or_none()
    
    if admin and pdf:
        analysis = AnalysisResult(
            id=generate_id(),
            source_type='paper', source_id=pdf.id,
            user_query='钛合金的力学性能研究', user_id=admin.id,
            summary='该研究系统分析了Ti-6Al-4V钛合金的微观结构与力学性能关系...',
            conclusions='1. 热轧工艺可细化晶粒\n2. α+β双相结构有利于协调变形\n3. 适用于航空航天结构件',
            key_findings='晶粒尺寸与屈服强度符合Hall-Petch关系',
            methodology='真空电弧熔炼 + 结构表征 + 力学测试',
            material_info=json.dumps({"material_name": "Ti-6Al-4V", "phase": "α+β", "strength": "1100MPa"}),
            confidence_score=0.92, quality_score=0.88,
            model_name='gpt-4o-mini'
        )
        session.add(analysis)
        await session.commit()
        print("[OK] Sample analysis initialized")


if __name__ == "__main__":
    print("=" * 60)
    print("PostgreSQL Tables Initialization")
    print("=" * 60)
    asyncio.run(init_tables())
