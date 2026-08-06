import hashlib
import uuid
import re
from datetime import datetime
from typing import Optional


def generate_id() -> str:
    """生成唯一ID"""
    return str(uuid.uuid4())


def generate_short_id() -> str:
    """生成短ID"""
    return hashlib.md5(uuid.uuid4().bytes).hexdigest()[:12]


def hash_password(password: str) -> str:
    """密码哈希"""
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(password: str, hashed: str) -> bool:
    """验证密码"""
    return hash_password(password) == hashed


def sanitize_filename(filename: str) -> str:
    """清理文件名"""
    # 移除非法字符
    filename = re.sub(r'[<>:"/\\|?*]', '', filename)
    # 限制长度
    if len(filename) > 200:
        name, ext = filename.rsplit('.', 1) if '.' in filename else (filename, '')
        filename = name[:200] + ('.' + ext if ext else '')
    return filename


def parse_doi(doi_string: str) -> Optional[str]:
    """解析DOI"""
    # DOI格式: 10.xxxx/xxxxx
    pattern = r'10\.\d{4,}/[^\s]+'
    match = re.search(pattern, doi_string)
    return match.group(0) if match else None


def format_datetime(dt: datetime) -> str:
    """格式化日期时间"""
    return dt.strftime('%Y-%m-%d %H:%M:%S')


def truncate_text(text: str, max_length: int = 200) -> str:
    """截断文本"""
    if len(text) <= max_length:
        return text
    return text[:max_length].rsplit(' ', 1)[0] + '...'


def calculate_relevance_score(query: str, text: str) -> float:
    """
    计算相关性分数
    
    简单的关键词匹配算法
    """
    query_words = set(query.lower().split())
    text_words = set(text.lower().split())
    
    if not query_words:
        return 0.0
    
    matches = len(query_words & text_words)
    return matches / len(query_words)


def merge_dicts(base: dict, override: dict) -> dict:
    """合并字典"""
    result = base.copy()
    result.update(override)
    return result


def safe_json_loads(data: str, default=None):
    """安全加载JSON"""
    import json
    try:
        return json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return default if default is not None else {}


def safe_json_dumps(data, default=None):
    """安全转储JSON"""
    import json
    try:
        return json.dumps(data, ensure_ascii=False, default=default)
    except (TypeError, ValueError):
        return '{}'
