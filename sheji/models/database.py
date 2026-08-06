from sqlalchemy import (
    Column, String, Integer, DateTime, Text, 
    Float, Boolean, ForeignKey, Table, Index, BigInteger, JSON
)
from sqlalchemy.orm import relationship
from datetime import datetime

from core.database import Base

# ==================== 9大领域定义 ====================
MATERIAL_CATEGORIES = {
    'alloy_metallic': '合金/金属材料',
    'amorphous_glass': '非晶玻璃',
    'ceramic_structural': '结构陶瓷',
    'composite_multiphase': '多相复合材料',
    'nanomaterials_lowdim': '低维纳米材料',
    'optical_optoelectronic': '光电材料',
    'polymer_soft_matter': '软物质高分子',
    'solid_state_ionic': '固态离子材料',
    'surface_thin_film': '表面与薄膜材料'
}

# ==================== 11个要素定义 ====================
MATERIAL_ELEMENTS = [
    'material_name',           # 材料名称
    'symmetry_phase',          # 对称相
    'structure_descriptor',    # 结构描述符
    'properties',              # 属性
    'applications',            # 应用
    'synthesis_method',        # 合成方法工艺
    'characterization_method', # 表征方法
    'quality_control',         # 质检
    'first_author',            # 第一作者
    'doi',                     # DOI
    'corresponding_author'     # 通讯作者
]

# 关联表：论文-作者
paper_author = Table(
    'paper_author',
    Base.metadata,
    Column('paper_id', String(36), ForeignKey('papers.id')),
    Column('author_id', String(36), ForeignKey('authors.id'))
)

# 关联表：论文-关键词
paper_keyword = Table(
    'paper_keyword',
    Base.metadata,
    Column('paper_id', String(36), ForeignKey('papers.id')),
    Column('keyword_id', String(36), ForeignKey('keywords.id'))
)


class User(Base):
    """用户模型"""
    __tablename__ = 'users'
    
    id = Column(String(36), primary_key=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(100), unique=True, index=True)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_active = Column(DateTime, default=datetime.utcnow)
    is_active = Column(Boolean, default=True)
    
    # 关系
    search_histories = relationship("SearchHistory", back_populates="user", cascade="all, delete-orphan")
    preferences = relationship("UserPreference", back_populates="user", uselist=False, cascade="all, delete-orphan")
    memories = relationship("UserMemory", back_populates="user", cascade="all, delete-orphan")
    topics = relationship("UserTopic", back_populates="user", cascade="all, delete-orphan")
    
    __table_args__ = (
        Index('idx_user_username', 'username'),
        Index('idx_user_email', 'email'),
    )


class UserPreference(Base):
    """用户偏好设置"""
    __tablename__ = 'user_preferences'
    
    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), ForeignKey('users.id'), unique=True)
    favorite_topics = Column(Text)  # JSON格式存储
    search_filters = Column(Text)  # JSON格式存储
    notification_enabled = Column(Boolean, default=True)
    theme = Column(String(20), default='light')
    
    user = relationship("User", back_populates="preferences")


class UserMemory(Base):
    """用户记忆模型 - 存储用户的提问历史、主题偏好、搜索模式"""
    __tablename__ = 'user_memories'
    
    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), ForeignKey('users.id'), index=True)
    
    # 历史主题（用户经常查询的主题）
    historical_topics = Column(Text)  # JSON数组 ["纳米材料", "合金"]
    
    # 用户偏好
    preferences = Column(Text)  # JSON对象
    
    # 搜索模式
    search_patterns = Column(Text)  # JSON对象
    
    # 记忆摘要（由LLM生成）
    memory_summary = Column(Text)
    
    # 时间戳
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    user = relationship("User", back_populates="memories")
    
    __table_args__ = (
        Index('idx_memory_user', 'user_id'),
        Index('idx_memory_updated', 'updated_at'),
    )


class UserTopic(Base):
    """用户历史主题 - 记录用户查询过的具体主题"""
    __tablename__ = 'user_topics'
    
    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), ForeignKey('users.id'), index=True)
    
    # 主题信息
    topic = Column(String(200), nullable=False)  # 主题名称
    category = Column(String(50))  # 所属9大领域
    query_count = Column(Integer, default=1)  # 查询次数
    last_query = Column(Text)  # 最后一次查询内容
    
    # 时间戳
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    user = relationship("User", back_populates="topics")
    
    __table_args__ = (
        Index('idx_topic_user', 'user_id'),
        Index('idx_topic_name', 'topic'),
        Index('idx_topic_category', 'category'),
    )


class SearchHistory(Base):
    """搜索历史"""
    __tablename__ = 'search_histories'
    
    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), ForeignKey('users.id'), index=True)
    query = Column(Text, nullable=False)
    rewritten_query = Column(Text)  # LLM重写后的查询
    source = Column(String(20))  # database, web, both
    results_count = Column(Integer)
    search_time = Column(Float)
    
    # 搜索条件
    filters = Column(Text)  # JSON格式存储筛选条件
    
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    
    user = relationship("User", back_populates="search_histories")
    
    __table_args__ = (
        Index('idx_search_user_time', 'user_id', 'created_at'),
    )


class Paper(Base):
    """论文/文献模型"""
    __tablename__ = 'papers'
    
    id = Column(String(36), primary_key=True)
    title = Column(Text, nullable=False)
    abstract = Column(Text)
    doi = Column(String(100), unique=True, index=True)
    url = Column(String(500))
    pdf_url = Column(String(500))
    pdf_path = Column(String(500))  # 本地PDF路径
    publish_date = Column(DateTime, index=True)
    journal = Column(String(200), index=True)
    volume = Column(String(50))
    issue = Column(String(50))
    pages = Column(String(50))
    language = Column(String(10), default='en')
    
    # 分析结果
    summary = Column(Text)  # 生成的摘要
    conclusions = Column(Text)  # 主要结论
    methodology = Column(Text)  # 研究方法
    
    # 元数据
    citation_count = Column(Integer, default=0)
    download_count = Column(Integer, default=0)
    relevance_score = Column(Float, default=0.0)
    credibility_score = Column(Float, default=0.0)
    
    # 时间戳
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # 关系
    authors = relationship("Author", secondary=paper_author, back_populates="papers")
    keywords = relationship("Keyword", secondary=paper_keyword, back_populates="papers")
    
    __table_args__ = (
        Index('idx_paper_doi', 'doi'),
        Index('idx_paper_journal_date', 'journal', 'publish_date'),
        Index('idx_paper_relevance', 'relevance_score'),
    )


class Author(Base):
    """作者模型"""
    __tablename__ = 'authors'
    
    id = Column(String(36), primary_key=True)
    name = Column(String(100), nullable=False, index=True)
    affiliation = Column(String(300))
    email = Column(String(100))
    orcid = Column(String(50), unique=True)
    
    papers = relationship("Paper", secondary=paper_author, back_populates="authors")


class Keyword(Base):
    """关键词模型"""
    __tablename__ = 'keywords'
    
    id = Column(String(36), primary_key=True)
    word = Column(String(100), unique=True, nullable=False, index=True)
    frequency = Column(Integer, default=0)
    
    papers = relationship("Paper", secondary=paper_keyword, back_populates="keywords")


class Document(Base):
    """上传文档模型"""
    __tablename__ = 'documents'
    
    id = Column(String(36), primary_key=True)
    filename = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)
    file_size = Column(Integer)
    file_type = Column(String(50))
    
    title = Column(String(300))
    doi = Column(String(100))
    upload_by = Column(String(36), ForeignKey('users.id'))
    
    status = Column(String(20), default='pending')
    
    extracted_text = Column(Text)
    summary = Column(Text)
    keywords = Column(Text)
    
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    __table_args__ = (
        Index('idx_doc_status', 'status'),
        Index('idx_doc_upload_time', 'upload_by', 'created_at'),
    )


class Recommendation(Base):
    """推荐记录模型"""
    __tablename__ = 'recommendations'
    
    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), ForeignKey('users.id'), index=True)
    query = Column(Text, nullable=False)
    recommendation_type = Column(String(20))  # material, product, solution
    content = Column(Text)
    confidence = Column(Float)
    reason = Column(Text)
    is_accepted = Column(Boolean, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    
    __table_args__ = (
        Index('idx_rec_user_time', 'user_id', 'created_at'),
    )


class PDFIndex(Base):
    """PDF文献索引表 - 用于管理15万文献"""
    __tablename__ = 'pdf_index'
    
    id = Column(String(36), primary_key=True)
    filename = Column(String(255), nullable=False, index=True)
    relative_path = Column(String(500), nullable=False)
    file_size = Column(BigInteger)
    
    # 文献元数据
    title = Column(Text)
    authors = Column(Text)  # JSON格式
    doi = Column(String(100), index=True)
    abstract = Column(Text)
    keywords = Column(Text)  # JSON格式
    publish_year = Column(Integer, index=True)
    
    # ==================== 11个要素字段 ====================
    material_name = Column(String(500), index=True)           # 1. 材料名称
    symmetry_phase = Column(String(300), index=True)          # 2. 对称相
    structure_descriptor = Column(Text)                        # 3. 结构描述符
    properties = Column(Text)                                  # 4. 属性
    applications = Column(Text)                                # 5. 应用
    synthesis_method = Column(Text)                            # 6. 合成方法工艺
    characterization_method = Column(Text)                     # 7. 表征方法
    quality_control = Column(Text)                             # 8. 质检
    first_author = Column(String(200), index=True)             # 9. 第一作者
    corresponding_author = Column(String(200), index=True)     # 10. 通讯作者
    # doi 已在上面定义                                        # 11. DOI
    
    # ==================== 9大领域分类 ====================
    category = Column(String(50), index=True)  # 所属领域
    
    # 处理状态
    is_processed = Column(Boolean, default=False)
    is_indexed = Column(Boolean, default=False)
    process_time = Column(DateTime)
    
    # 文件哈希（用于去重）
    file_hash = Column(String(64), unique=True, index=True)
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    __table_args__ = (
        Index('idx_pdf_processed', 'is_processed'),
        Index('idx_pdf_indexed', 'is_indexed'),
        Index('idx_pdf_year', 'publish_year'),
        Index('idx_pdf_category', 'category'),
        Index('idx_pdf_material', 'material_name'),
        Index('idx_pdf_symmetry', 'symmetry_phase'),
        Index('idx_pdf_first_author', 'first_author'),
        Index('idx_pdf_corr_author', 'corresponding_author'),
    )


class AnalysisResult(Base):
    """分析结果存储 - 存储LLM生成的摘要和结论"""
    __tablename__ = 'analysis_results'
    
    id = Column(String(36), primary_key=True)
    
    # 关联类型
    source_type = Column(String(20), nullable=False)  # 'paper', 'document', 'query'
    source_id = Column(String(36), index=True)  # 关联的论文ID或文档ID
    
    # 用户查询（如果是基于查询生成的）
    user_query = Column(Text)
    user_id = Column(String(36), ForeignKey('users.id'), index=True)
    
    # LLM分析结果
    summary = Column(Text)  # 生成的摘要
    conclusions = Column(Text)  # 主要结论
    key_findings = Column(Text)  # 关键发现
    methodology = Column(Text)  # 研究方法总结
    
    # 材料信息提取
    material_info = Column(Text)  # JSON格式，提取的材料信息
    
    # 质量评估
    confidence_score = Column(Float, default=0.0)  # 置信度
    quality_score = Column(Float, default=0.0)  # 质量评分
    
    # 使用的模型
    model_name = Column(String(50))
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    __table_args__ = (
        Index('idx_analysis_source', 'source_type', 'source_id'),
        Index('idx_analysis_user', 'user_id'),
        Index('idx_analysis_created', 'created_at'),
    )


class MaterialCategory(Base):
    """材料领域分类表 - 9大领域"""
    __tablename__ = 'material_categories'
    
    id = Column(String(36), primary_key=True)
    code = Column(String(50), unique=True, nullable=False)  # 领域代码
    name = Column(String(100), nullable=False)  # 领域名称
    name_en = Column(String(100))  # 英文名称
    description = Column(Text)  # 领域描述
    
    # 统计
    paper_count = Column(Integer, default=0)  # 该领域论文数量
    
    created_at = Column(DateTime, default=datetime.utcnow)


class SearchCache(Base):
    """搜索缓存 - 缓存热门搜索结果"""
    __tablename__ = 'search_cache'
    
    id = Column(String(36), primary_key=True)
    query_hash = Column(String(64), unique=True, index=True)  # 查询哈希
    query = Column(Text, nullable=False)
    
    # 搜索结果
    results = Column(Text)  # JSON格式存储结果
    result_count = Column(Integer)
    
    # 缓存元数据
    hit_count = Column(Integer, default=1)  # 命中次数
    last_hit = Column(DateTime, default=datetime.utcnow)
    expires_at = Column(DateTime, index=True)  # 过期时间
    
    created_at = Column(DateTime, default=datetime.utcnow)
    
    __table_args__ = (
        Index('idx_cache_expires', 'expires_at'),
        Index('idx_cache_hit', 'hit_count'),
    )
