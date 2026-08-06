#!/usr/bin/env python3
"""
数据库初始化脚本
- 创建所有表
- 初始化9大领域数据
- 创建默认管理员用户
"""

import asyncio
import sys
import os
from datetime import datetime
import uuid

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy.ext.asyncio import AsyncSession
from core.database import engine, Base, AsyncSessionLocal
from models.database import (
    MATERIAL_CATEGORIES, 
    MaterialCategory, 
    User, 
    UserPreference,
    UserMemory,
    PDFIndex,
    AnalysisResult
)
from core.config import settings


def generate_id():
    """生成唯一ID"""
    return str(uuid.uuid4())


async def init_material_categories(session: AsyncSession):
    """初始化9大领域数据"""
    categories = [
        {
            'code': 'alloy_metallic',
            'name': '合金/金属材料',
            'name_en': 'Alloy and Metallic Materials',
            'description': '包括各种金属合金、钢铁材料、有色金属及其合金等'
        },
        {
            'code': 'amorphous_glass',
            'name': '非晶玻璃',
            'name_en': 'Amorphous Glass',
            'description': '非晶态材料、金属玻璃、氧化物玻璃等'
        },
        {
            'code': 'ceramic_structural',
            'name': '结构陶瓷',
            'name_en': 'Structural Ceramics',
            'description': '氧化物陶瓷、非氧化物陶瓷、结构功能一体化陶瓷等'
        },
        {
            'code': 'composite_multiphase',
            'name': '多相复合材料',
            'name_en': 'Multiphase Composite Materials',
            'description': '金属基复合材料、陶瓷基复合材料、聚合物基复合材料等'
        },
        {
            'code': 'nanomaterials_lowdim',
            'name': '低维纳米材料',
            'name_en': 'Low-dimensional Nanomaterials',
            'description': '纳米颗粒、纳米线、纳米管、石墨烯、二维材料等'
        },
        {
            'code': 'optical_optoelectronic',
            'name': '光电材料',
            'name_en': 'Optical and Optoelectronic Materials',
            'description': '半导体材料、光电转换材料、发光材料、光学晶体等'
        },
        {
            'code': 'polymer_soft_matter',
            'name': '软物质高分子',
            'name_en': 'Soft Matter and Polymers',
            'description': '高分子材料、生物材料、胶体、液晶等软物质'
        },
        {
            'code': 'solid_state_ionic',
            'name': '固态离子材料',
            'name_en': 'Solid State Ionic Materials',
            'description': '固态电解质、离子导体、燃料电池材料、电池材料等'
        },
        {
            'code': 'surface_thin_film',
            'name': '表面与薄膜材料',
            'name_en': 'Surface and Thin Film Materials',
            'description': '薄膜材料、涂层、表面改性、界面材料等'
        }
    ]
    
    for cat_data in categories:
        category = MaterialCategory(
            id=generate_id(),
            **cat_data
        )
        session.add(category)
    
    await session.commit()
    print(f"[OK] 已初始化 {len(categories)} 大材料领域")


async def init_admin_user(session: AsyncSession):
    """创建默认管理员用户"""
    import hashlib
    
    # 检查是否已存在
    from sqlalchemy import select
    result = await session.execute(
        select(User).where(User.username == 'admin')
    )
    existing = result.scalar_one_or_none()
    
    if existing:
        print("[OK] 管理员用户已存在")
        return
    
    # 创建管理员用户
    admin_id = generate_id()
    admin = User(
        id=admin_id,
        username='admin',
        email='admin@materialkb.com',
        password_hash=hashlib.sha256('admin123'.encode()).hexdigest(),
        created_at=datetime.utcnow(),
        last_active=datetime.utcnow(),
        is_active=True
    )
    session.add(admin)
    
    # 创建用户偏好
    preference = UserPreference(
        id=generate_id(),
        user_id=admin_id,
        favorite_topics='["合金材料", "纳米技术"]',
        search_filters='{"language": "zh", "year_range": "2020-2024"}',
        theme='dark'
    )
    session.add(preference)
    
    # 创建用户记忆
    memory = UserMemory(
        id=generate_id(),
        user_id=admin_id,
        historical_topics='["合金材料", "纳米技术", "固态电解质"]',
        preferences='{"preferred_categories": ["alloy_metallic", "nanomaterials_lowdim"], "result_count": 20}',
        search_patterns='{"common_keywords": ["强度", "导电性"], "search_frequency": {"合金": 5, "纳米": 3}}',
        memory_summary='用户主要关注合金材料和纳米材料领域，经常查询材料力学性能和电化学性能相关文献。'
    )
    session.add(memory)
    
    await session.commit()
    print("[OK] 已创建默认管理员用户 (admin / admin123)")


async def init_sample_pdf_index(session: AsyncSession):
    """初始化示例PDF文献索引数据"""
    from sqlalchemy import select
    result = await session.execute(select(PDFIndex).limit(1))
    if result.scalar_one_or_none():
        print("[OK] PDF索引数据已存在")
        return
    
    # 示例数据 - 模拟15万文献中的几条
    sample_pdfs = [
        {
            'filename': 'alloy_strength_2023.pdf',
            'relative_path': 'alloy_metallic/2023/alloy_strength_2023.pdf',
            'title': '高强度钛合金的微观结构与力学性能研究',
            'authors': '["张三", "李四", "王五"]',
            'doi': '10.1000/alloy001',
            'abstract': '本文研究了新型钛合金的微观结构特征及其对力学性能的影响...',
            'keywords': '["钛合金", "微观结构", "力学性能"]',
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
            'is_processed': True,
            'is_indexed': True,
            'file_hash': 'abc123def456'
        },
        {
            'filename': 'nanowire_electronic_2024.pdf',
            'relative_path': 'nanomaterials_lowdim/2024/nanowire_electronic_2024.pdf',
            'title': '硅纳米线场效应晶体管的电学特性研究',
            'authors': '["赵六", "钱七"]',
            'doi': '10.1000/nano001',
            'abstract': '制备了直径为20nm的硅纳米线，并研究了其场效应晶体管特性...',
            'keywords': '["硅纳米线", "场效应晶体管", "纳米电子学"]',
            'publish_year': 2024,
            'material_name': '硅纳米线(SiNW)',
            'symmetry_phase': '金刚石立方结构',
            'structure_descriptor': '直径20nm，长度5μm，<111>取向',
            'properties': '载流子迁移率: 800 cm²/V·s, 开关比: 10^6',
            'applications': '纳米电子器件、传感器、太阳能电池',
            'synthesis_method': '化学气相沉积(CVD) + 金催化生长',
            'characterization_method': 'SEM, TEM, AFM, 电学测试',
            'quality_control': '直径分布统计、电学性能均匀性测试',
            'first_author': '赵六',
            'corresponding_author': '钱七',
            'category': 'nanomaterials_lowdim',
            'is_processed': True,
            'is_indexed': True,
            'file_hash': 'ghi789jkl012'
        },
        {
            'filename': 'solid_electrolyte_2023.pdf',
            'relative_path': 'solid_state_ionic/2023/solid_electrolyte_2023.pdf',
            'title': '硫化物固态电解质的离子传导机制研究',
            'authors': '["孙八", "周九", "吴十"]',
            'doi': '10.1000/ionic001',
            'abstract': '通过第一性原理计算和实验验证，揭示了硫化物固态电解质的高离子传导机制...',
            'keywords': '["固态电解质", "硫化物", "离子传导", "全固态电池"]',
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
            'is_processed': True,
            'is_indexed': True,
            'file_hash': 'mno345pqr678'
        }
    ]
    
    for pdf_data in sample_pdfs:
        pdf = PDFIndex(
            id=generate_id(),
            **pdf_data
        )
        session.add(pdf)
    
    await session.commit()
    print(f"[OK] 已初始化 {len(sample_pdfs)} 条示例PDF文献索引")


async def init_analysis_results(session: AsyncSession):
    """初始化示例分析结果"""
    from sqlalchemy import select
    result = await session.execute(select(AnalysisResult).limit(1))
    if result.scalar_one_or_none():
        print("[OK] 分析结果数据已存在")
        return
    
    # 获取admin用户ID
    result = await session.execute(select(User).where(User.username == 'admin'))
    admin = result.scalar_one_or_none()
    
    if not admin:
        print("[!] 管理员用户不存在，跳过分析结果初始化")
        return
    
    # 获取第一条PDF
    result = await session.execute(select(PDFIndex).limit(1))
    pdf = result.scalar_one_or_none()
    
    if pdf:
        analysis = AnalysisResult(
            id=generate_id(),
            source_type='paper',
            source_id=pdf.id,
            user_query='钛合金的力学性能研究',
            user_id=admin.id,
            summary='该研究系统分析了Ti-6Al-4V钛合金的微观结构与力学性能关系。通过热轧工艺制备的合金表现出优异的综合力学性能，抗拉强度达到1100MPa，同时保持良好的塑性。',
            conclusions='1. 热轧工艺可细化晶粒，提高合金强度\n2. α+β双相结构有利于协调变形\n3. 该合金适用于航空航天结构件',
            key_findings='晶粒尺寸与屈服强度符合Hall-Petch关系；β相含量影响合金的加工硬化行为',
            methodology='采用真空电弧熔炼制备合金，通过XRD、SEM、TEM进行结构表征，使用万能试验机进行力学性能测试',
            material_info='{"material_name": "Ti-6Al-4V", "phase": "α+β", "grain_size": "10μm", "strength": "1100MPa"}',
            confidence_score=0.92,
            quality_score=0.88,
            model_name='gpt-4o-mini'
        )
        session.add(analysis)
        await session.commit()
        print("[OK] 已初始化示例分析结果")


async def main():
    """主函数"""
    print("=" * 60)
    print("Material AI Knowledge Base - Database Initialization")
    print("=" * 60)
    
    # 创建所有表
    print("\n[Step 1] Creating database tables...")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("[OK] Database tables created")
    
    # 初始化数据
    async with AsyncSessionLocal() as session:
        print("\n[Step 2] Initializing 9 material categories...")
        await init_material_categories(session)
        
        print("\n[Step 3] Creating admin user...")
        await init_admin_user(session)
        
        print("\n[Step 4] Initializing sample PDF index...")
        await init_sample_pdf_index(session)
        
        print("\n[Step 5] Initializing sample analysis results...")
        await init_analysis_results(session)
    
    print("\n" + "=" * 60)
    print("[OK] Database initialization completed!")
    print("=" * 60)
    print("\nDefault Account:")
    print("  Username: admin")
    print("  Password: admin123")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
