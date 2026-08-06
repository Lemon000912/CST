from pydantic_settings import BaseSettings
from typing import Optional
import os


class Settings(BaseSettings):
    """应用配置类 - 支持 SQLite/MySQL/PostgreSQL/Redis"""
    
    # 应用配置
    APP_NAME: str = "材料AI知识库"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True
    HOST: str = "0.0.0.0"
    PORT: int = 9003
    
    # 数据库类型: sqlite, mysql, postgresql
    DB_TYPE: str = "sqlite"
    
    # SQLite配置（开发环境默认）
    SQLITE_PATH: str = "./data/material_kb.db"
    
    # MySQL数据库配置
    MYSQL_HOST: str = "localhost"
    MYSQL_PORT: int = 3306
    MYSQL_USER: str = "root"
    MYSQL_PASSWORD: str = "123456"
    MYSQL_DATABASE: str = "material_kb"
    MYSQL_POOL_SIZE: int = 20
    
    # PostgreSQL数据库配置
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "postgres"
    POSTGRES_PASSWORD: str = "123456"
    POSTGRES_DATABASE: str = "material_kb"
    POSTGRES_POOL_SIZE: int = 20
    
    @property
    def DATABASE_URL(self) -> str:
        """生成数据库连接字符串"""
        if self.DB_TYPE == "sqlite":
            # 确保目录存在
            os.makedirs(os.path.dirname(self.SQLITE_PATH), exist_ok=True)
            return f"sqlite+aiosqlite:///{self.SQLITE_PATH}"
        elif self.DB_TYPE == "postgresql":
            return (
                f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
                f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DATABASE}"
            )
        else:
            return (
                f"mysql+aiomysql://{self.MYSQL_USER}:{self.MYSQL_PASSWORD}"
                f"@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DATABASE}"
            )
    
    # Redis配置
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_PASSWORD: Optional[str] = None
    REDIS_DB: int = 0
    REDIS_ENABLED: bool = True
    
    @property
    def REDIS_URL(self) -> str:
        """生成Redis连接字符串"""
        if self.REDIS_PASSWORD:
            return f"redis://:{self.REDIS_PASSWORD}@{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"
        return f"redis://{self.REDIS_HOST}:{self.REDIS_PORT}/{self.REDIS_DB}"
    
    # 向量数据库配置
    CHROMA_PERSIST_PATH: str = "./data/chroma"
    
    # LLM配置
    OPENAI_API_KEY: Optional[str] = None
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    OPENAI_MODEL: str = "gpt-4o-mini"
    
    ANTHROPIC_API_KEY: Optional[str] = None
    ANTHROPIC_MODEL: str = "claude-3-5-sonnet-20241022"
    
    # 通义千问配置
    DASHSCOPE_API_KEY: Optional[str] = None
    DASHSCOPE_BASE_URL: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    DASHSCOPE_MODEL: str = "qwen-turbo"
    
    # 文档存储路径
    DOCUMENT_STORAGE_PATH: str = "./data/documents"
    PDF_STORAGE_PATH: str = "E:/文献库"
    UPLOAD_MAX_SIZE: str = "100MB"
    
    # 日志配置
    LOG_LEVEL: str = "INFO"
    LOG_FILE: str = "./logs/app.log"
    
    # 安全配置
    SECRET_KEY: str = "your-secret-key-here-change-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    
    # 搜索配置
    MAX_SEARCH_RESULTS: int = 50
    SEARCH_TIMEOUT: int = 30
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


# 全局配置实例
settings = Settings()
