"""
本机可选：通过 Sci-Hub 镜像按 DOI 批量下载 PDF。

【法律与版权】仅供个人研究、在有权访问的前提下使用；可能违反出版商条款或当地法律。
请勿用于商业分发或与对外服务绑定；使用后果自负。与「论文查询」Web 服务无自动关联。

用法示例：
  python scripts/batch_pdf_scihub.py --input dois.txt --output ./pdf_out

依赖：pip install requests beautifulsoup4 urllib3
"""
import argparse
import requests
import os
import time
import random
import re
import json
from pathlib import Path
from datetime import datetime
import logging
from urllib.parse import urlparse, parse_qs, urlencode, urljoin
import urllib3
from bs4 import BeautifulSoup
import base64

# 禁用SSL警告
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logger = logging.getLogger(__name__)

# 多个Sci-Hub镜像站点
MIRRORS = [
    "https://sci-hub.se",
    "https://sci-hub.st",
    "https://sci-hub.ru",
    "https://sci-hub.shop",
    "https://sci-hub.world",
    "https://sci-hub.do",
    "https://sci-hub.bar",
    "https://sci-hub.mksa.top",
    "https://sci-hub.tf",
    "https://sci-hub.wf",
    "https://sci-hub.cat",
    "https://sci-hub.nu",
    "https://sci-hub.nz",
    "https://sci-hub.li",
    "https://sci-hub.la",
    "https://sci-hub.one",
    "https://sci-hub.ren",
    "https://sci-hub.wine",
    "https://sci-hub.black",
    "https://sci-hub.gr",
    "https://sci-hub.ink",
    "https://sci-hub.mn",
    "https://sci-hub.observer",
    "https://sci-hub.pm",
    "https://sci-hub.pub",
    "https://sci-hub.reviews",
    "https://sci-hub.sbs",
    "https://sci-hub.show",
    "https://sci-hub.studio",
    "https://sci-hub.tel",
    "https://sci-hub.tw",
    "https://sci-hub.vc",
    "https://sci-hub.video",
    "https://sci-hub.wiki",
    "https://sci-hub.yt",
    "https://sci-hub.za",
    "https://sci-hub.zone",
]

class SmartSciHubDownloader:
    def __init__(self, input_file, download_dir, state_file, mirrors, config):
        self.input_file = input_file
        self.download_dir = Path(download_dir)
        self.state_file = state_file
        self.mirrors = mirrors
        self.config = config
        
        # 镜像统计和状态跟踪
        self.mirror_stats = {mirror: {
            "success": 0, 
            "failure": 0, 
            "last_used": 0, 
            "blocked": False, 
            "block_until": 0,
            "consecutive_failures": 0,
            "last_error": None
        } for mirror in mirrors}
        
        # 统计信息
        self.stats = {"total": 0, "success": 0, "failed": 0, "skipped": 0}
        
        # 会话配置
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Cache-Control': 'max-age=0',
        })

    def clean_doi(self, doi_str):
        """清理DOI字符串，提取纯净的DOI"""
        doi_str = doi_str.strip()
        
        if doi_str.startswith('http'):
            # 从URL中提取DOI
            doi_match = re.search(r'10\.\d{4,}/[^\s<>"\']+', doi_str)
            if doi_match:
                return doi_match.group(0)
        elif doi_str.startswith('10.'):
            # 已经是DOI格式
            return doi_str
        else:
            # 尝试从各种格式中提取DOI
            doi_match = re.search(r'10\.\d{4,}/[^\s<>"\']+', doi_str)
            if doi_match:
                return doi_match.group(0)
        
        return None

    def doi_to_filename(self, doi):
        """将 DOI 转为合法文件名"""
        safe_doi = re.sub(r'[\\/*?:"<>|]', "_", doi)
        safe_doi = safe_doi.replace("/", "_").replace(":", "_")
        return f"{safe_doi}.pdf"

    def is_valid_pdf(self, file_path):
        """验证PDF文件是否有效"""
        try:
            if not file_path.exists():
                return False
            
            # 检查文件大小
            if file_path.stat().st_size < 2048:  # 小于2KB可能是错误页面
                return False
            
            # 检查PDF文件头
            with open(file_path, 'rb') as f:
                header = f.read(4)
                return header == b'%PDF'
        except:
            return False

    def is_downloaded(self, doi):
        """检查该 DOI 是否已下载"""
        pdf_path = self.download_dir / self.doi_to_filename(doi)
        return pdf_path.exists() and self.is_valid_pdf(pdf_path)

    def extract_pdf_url_advanced(self, html_content, base_url):
        """高级PDF URL提取 - 多种策略结合"""
        soup = BeautifulSoup(html_content, 'html.parser')
        
        # 策略1: 搜索所有可能的PDF相关元素
        strategies = [
            # iframe src
            lambda: soup.find('iframe', src=re.compile(r'\.pdf')),
            # embed src
            lambda: soup.find('embed', src=re.compile(r'\.pdf')),
            # object data
            lambda: soup.find('object', {'data': re.compile(r'\.pdf')}),
            # a标签包含pdf关键词
            lambda: soup.find('a', href=re.compile(r'\.pdf')),
            # script标签中的PDF URL
            lambda: soup.find('script', string=re.compile(r'pdf|PDF|\.pdf')),
            # meta标签
            lambda: soup.find('meta', content=re.compile(r'\.pdf')),
            # style标签中的background-image
            lambda: soup.find('style', string=re.compile(r'pdf|PDF|\.pdf')),
        ]
        
        for i, strategy in enumerate(strategies):
            try:
                element = strategy()
                if element:
                    # 尝试获取不同的属性值
                    attrs_to_try = ['src', 'href', 'data', 'content']
                    for attr in attrs_to_try:
                        url = element.get(attr)
                        if url and '.pdf' in url.lower():
                            if url.startswith('//'):
                                url = 'https:' + url
                            elif url.startswith('/'):
                                url = urljoin(base_url, url)
                            elif not url.startswith(('http://', 'https://')):
                                url = urljoin(base_url, url)
                            return url
                            
                    # 如果是script标签，尝试从内容中提取URL
                    if element.name == 'script' and element.string:
                        script_urls = re.findall(r'https?://[^\s\'"<>]+\.pdf[^\s\'"<>]*', element.string)
                        if script_urls:
                            return script_urls[0]
            except:
                continue
        
        # 策略2: 正则表达式搜索
        patterns = [
            r'<iframe[^>]*src=["\']([^"\']*\.pdf[^"\'>]*)["\']',
            r'<embed[^>]*src=["\']([^"\']*\.pdf[^"\'>]*)["\']',
            r'<object[^>]*data=["\']([^"\']*\.pdf[^"\'>]*)["\']',
            r'href=["\']([^"\']*\.pdf[^"\'>]*)["\'][^>]*(?:id=["\']pdf|>PDF|>Download|download)',
            r'location\.href\s*=\s*["\']([^"\']*\.pdf[^"\'>]*)["\']',
            r'window\.open\(["\']([^"\']*\.pdf[^"\'>]*)["\']',
            r'document\.location\s*=\s*["\']([^"\']*\.pdf[^"\'>]*)["\']',
            r'url\(["\']([^"\']*\.pdf[^"\'>]*)["\']\)',
        ]
        
        for pattern in patterns:
            matches = re.findall(pattern, html_content, re.IGNORECASE)
            if matches:
                url = matches[0]
                if url.startswith('//'):
                    url = 'https:' + url
                elif url.startswith('/'):
                    url = urljoin(base_url, url)
                elif not url.startswith(('http://', 'https://')):
                    url = urljoin(base_url, url)
                return url
        
        # 策略3: 搜索按钮或链接
        buttons = soup.find_all(['a', 'button', 'input'], 
                               string=re.compile(r'pdf|PDF|download|Download|view|View', re.IGNORECASE))
        for btn in buttons:
            href = btn.get('href') or btn.get('onclick') or btn.get('value')
            if href and '.pdf' in href.lower():
                if href.startswith('//'):
                    href = 'https:' + href
                elif href.startswith('/'):
                    href = urljoin(base_url, href)
                elif not href.startswith(('http://', 'https://')):
                    href = urljoin(base_url, href)
                return href
        
        # 策略4: 搜索隐藏的iframe或嵌入元素
        hidden_elements = soup.find_all(['iframe', 'embed', 'object'], 
                                       style=re.compile(r'display:\s*none|visibility:\s*hidden'))
        for elem in hidden_elements:
            src = elem.get('src') or elem.get('data')
            if src and '.pdf' in src.lower():
                if src.startswith('//'):
                    src = 'https:' + src
                elif src.startswith('/'):
                    src = urljoin(base_url, src)
                elif not src.startswith(('http://', 'https://')):
                    src = urljoin(base_url, src)
                return src
        
        # 策略5: 搜索JavaScript变量
        script_tags = soup.find_all('script')
        for script in script_tags:
            if script.string:
                js_matches = re.findall(r'(?:pdfUrl|pdf|file|src)\s*[:=]\s*["\']([^"\']*\.pdf[^"\'>]*)["\']', 
                                      script.string, re.IGNORECASE)
                if js_matches:
                    url = js_matches[0]
                    if url.startswith('//'):
                        url = 'https:' + url
                    elif url.startswith('/'):
                        url = urljoin(base_url, url)
                    elif not url.startswith(('http://', 'https://')):
                        url = urljoin(base_url, url)
                    return url
        
        return None

    def extract_pdf_url_from_scihub(self, html_content, base_url):
        """专门针对Sci-Hub的PDF URL提取"""
        # Sci-Hub特定的提取策略
        soup = BeautifulSoup(html_content, 'html.parser')
        
        # 查找Sci-Hub特有的元素
        sci_hub_patterns = [
            # Sci-Hub的iframe
            lambda: soup.find('iframe', id='pdf'),
            # Sci-Hub的PDF容器
            lambda: soup.find('div', id='pdf'),
            # Sci-Hub的embed
            lambda: soup.find('embed', id='pdf'),
            # Sci-Hub的对象
            lambda: soup.find('object', id='pdf'),
            # Sci-Hub的下载链接
            lambda: soup.find('a', class_=re.compile(r'download|pdf', re.IGNORECASE)),
            # Sci-Hub的按钮
            lambda: soup.find('button', string=re.compile(r'download|pdf', re.IGNORECASE)),
        ]
        
        for pattern in sci_hub_patterns:
            try:
                element = pattern()
                if element:
                    # 检查多个可能的属性
                    for attr in ['src', 'data', 'href']:
                        url = element.get(attr)
                        if url and '.pdf' in url.lower():
                            if url.startswith('//'):
                                url = 'https:' + url
                            elif url.startswith('/'):
                                url = urljoin(base_url, url)
                            elif not url.startswith(('http://', 'https://')):
                                url = urljoin(base_url, url)
                            return url
            except:
                continue
        
        # 查找Sci-Hub页面中的JavaScript
        scripts = soup.find_all('script')
        for script in scripts:
            if script.string:
                # 查找Sci-Hub的PDF URL变量
                pdf_matches = re.findall(r'pdf.*?["\']([^"\']*\.pdf[^"\'>]*)["\']', script.string, re.IGNORECASE)
                if pdf_matches:
                    url = pdf_matches[0]
                    if url.startswith('//'):
                        url = 'https:' + url
                    elif url.startswith('/'):
                        url = urljoin(base_url, url)
                    elif not url.startswith(('http://', 'https://')):
                        url = urljoin(base_url, url)
                    return url
        
        # 使用通用提取方法
        return self.extract_pdf_url_advanced(html_content, base_url)

    def download_single_pdf(self, doi):
        """下载单个PDF - 智能版本"""
        pdf_path = self.download_dir / self.doi_to_filename(doi)
        
        # 检查是否已存在
        if self.is_downloaded(doi):
            logger.info(f"✅ 已存在: {doi}")
            self.stats['skipped'] += 1
            return True
        
        # 记录已尝试的镜像
        tried_mirrors = set()
        
        for retry in range(self.config['max_retries']):
            # 获取可用镜像
            available_mirrors = [m for m in self.get_available_mirrors() if m not in tried_mirrors]
            if not available_mirrors:
                wait_time = 60
                logger.info(f"⏳ 所有镜像都被限制，等待{wait_time}秒后重试...")
                time.sleep(wait_time)
                available_mirrors = self.get_available_mirrors()
                if not available_mirrors:
                    logger.error("❌ 没有可用的镜像")
                    break
                tried_mirrors.clear()
            
            # 根据成功率排序选择镜像
            sorted_mirrors = sorted(
                available_mirrors,
                key=lambda m: (
                    self.mirror_stats[m]["success"] / max(1, self.mirror_stats[m]["success"] + self.mirror_stats[m]["failure"]),
                    -self.mirror_stats[m]["failure"],
                    -self.mirror_stats[m]["consecutive_failures"]
                ),
                reverse=True
            )
            mirror = sorted_mirrors[0]
            tried_mirrors.add(mirror)
            
            try:
                # 计算延迟
                if retry == 0:
                    delay = random.uniform(*self.config['delay_range'])
                else:
                    backoff = min((3.0 ** retry) * random.uniform(3.0, 6.0), 120)
                    delay = backoff
                    logger.info(f"🔄 第{retry+1}次重试，等待{delay:.1f}秒后尝试镜像: {mirror}")
                
                logger.info(f"⏳ 等待 {delay:.1f}s...")
                time.sleep(delay)
                
                # 构建请求URL
                url = f"{mirror}/{doi}"
                logger.info(f"🌐 请求: {url}")
                
                # 设置请求超时
                timeout = self.config['timeout'][1]
                
                # 访问Sci-Hub页面获取PDF链接
                try:
                    response = self.session.get(url, timeout=timeout)
                    
                    if response.status_code == 200:
                        content_type = response.headers.get('content-type', '').lower()
                        
                        if 'application/pdf' in content_type:
                            # 直接是PDF文件
                            logger.info("📥 直接获取PDF文件")
                            with open(pdf_path, 'wb') as f:
                                f.write(response.content)
                            
                            if self.is_valid_pdf(pdf_path):
                                logger.info(f"🎉 成功下载: {pdf_path.name}")
                                self.update_mirror_status(mirror, success=True)
                                self.stats['success'] += 1
                                return True
                            else:
                                logger.error(f"❌ 下载的文件无效: {pdf_path.name}")
                                if pdf_path.exists():
                                    pdf_path.unlink()
                                self.update_mirror_status(mirror, success=False, error_type="invalid_pdf")
                                continue
                        elif 'text/html' in content_type or 'text/plain' in content_type:
                            # 是HTML页面，需要解析
                            logger.info("🔍 解析HTML页面寻找PDF...")
                            
                            # 尝试从页面中提取PDF URL
                            pdf_url = self.extract_pdf_url_from_scihub(response.text, mirror)
                            
                            if pdf_url:
                                logger.info(f"📥 找到PDF链接: {pdf_url}")
                                
                                # 下载PDF文件
                                pdf_response = self.session.get(pdf_url, timeout=timeout, stream=True)
                                
                                if pdf_response.status_code == 200:
                                    # 检查内容类型是否为PDF
                                    pdf_content_type = pdf_response.headers.get('content-type', '').lower()
                                    
                                    # 如果响应不是PDF，尝试从响应中查找新的URL
                                    if 'application/pdf' not in pdf_content_type and 'pdf' not in pdf_content_type:
                                        # 可能是另一个HTML页面，尝试再次解析
                                        try:
                                            new_html = pdf_response.text
                                            new_pdf_url = self.extract_pdf_url_advanced(new_html, pdf_url)
                                            if new_pdf_url:
                                                logger.info(f"🔄 二次解析找到PDF: {new_pdf_url}")
                                                final_response = self.session.get(new_pdf_url, timeout=timeout, stream=True)
                                                if final_response.status_code == 200:
                                                    with open(pdf_path, 'wb') as f:
                                                        for chunk in final_response.iter_content(chunk_size=8192):
                                                            if chunk:
                                                                f.write(chunk)
                                                if self.is_valid_pdf(pdf_path):
                                                    logger.info(f"🎉 成功下载: {pdf_path.name}")
                                                    self.update_mirror_status(mirror, success=True)
                                                    self.stats['success'] += 1
                                                    return True
                                        except:
                                            pass
                                    else:
                                        # 直接保存PDF
                                        with open(pdf_path, 'wb') as f:
                                            for chunk in pdf_response.iter_content(chunk_size=8192):
                                                if chunk:
                                                    f.write(chunk)
                                        
                                        if self.is_valid_pdf(pdf_path):
                                            logger.info(f"🎉 成功下载: {pdf_path.name}")
                                            self.update_mirror_status(mirror, success=True)
                                            self.stats['success'] += 1
                                            return True
                            
                            # 如果没有找到PDF URL，检查页面是否包含错误信息
                            page_text = response.text.lower()
                            if any(keyword in page_text for keyword in ['not found', 'error', '404', 'forbidden', 'captcha']):
                                logger.error(f"❌ 页面错误: {doi}")
                                self.update_mirror_status(mirror, success=False, error_type="page_error")
                                continue
                            else:
                                logger.error(f"❌ 未找到PDF链接: {doi}")
                                self.update_mirror_status(mirror, success=False, error_type="no_pdf_link")
                                continue
                        else:
                            logger.error(f"❌ 意外的内容类型: {content_type}")
                            self.update_mirror_status(mirror, success=False, error_type="unexpected_content_type")
                            continue
                    else:
                        logger.error(f"❌ HTTP错误: {response.status_code}")
                        self.update_mirror_status(mirror, success=False, error_type=f"http_{response.status_code}")
                        continue
                        
                except requests.exceptions.Timeout:
                    logger.error(f"⏰ 请求超时: {doi}")
                    self.update_mirror_status(mirror, success=False, error_type="timeout")
                    continue
                except requests.exceptions.RequestException as e:
                    logger.error(f"❌ 请求异常: {e}")
                    self.update_mirror_status(mirror, success=False, error_type="request_error")
                    continue
                except Exception as e:
                    logger.error(f"❌ 未知异常: {e}")
                    self.update_mirror_status(mirror, success=False, error_type="unknown_error")
                    continue
            
            except Exception as e:
                logger.error(f"❌ 未知错误: {doi} @ {mirror} - {str(e)[:100]}...")
                self.update_mirror_status(mirror, success=False, error_type="unknown_error")
                time.sleep(10)
        
        logger.error(f"❌ 所有重试均失败: {doi}")
        self.stats['failed'] += 1
        return False

    def get_available_mirrors(self):
        """获取可用的镜像列表"""
        current_time = time.time()
        available = []
        for mirror in self.mirrors:
            info = self.mirror_stats[mirror]
            if not info["blocked"] or current_time >= info["block_until"]:
                if info["blocked"]:
                    # 解除限制
                    info["blocked"] = False
                    info["block_until"] = 0
                    info["consecutive_failures"] = 0
                available.append(mirror)
        return available

    def update_mirror_status(self, mirror, success, error_type=None):
        """更新镜像状态"""
        info = self.mirror_stats[mirror]
        current_time = time.time()
        
        if success:
            info["success"] += 1
            info["consecutive_failures"] = 0
        else:
            info["failure"] += 1
            info["consecutive_failures"] += 1
            info["last_error"] = error_type
            
            # 如果连续失败太多次，暂时禁用镜像
            if info["consecutive_failures"] >= 5:
                info["blocked"] = True
                info["block_until"] = current_time + 600  # 禁用10分钟

    def load_dois(self):
        """加载并清理DOI列表"""
        dois = []
        try:
            with open(self.input_file, 'r', encoding='utf-8') as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line or line.lower() in ['doi', 'nan', 'null', ''] or line.startswith('#'):
                        continue
                    
                    cleaned_doi = self.clean_doi(line)
                    if cleaned_doi:
                        dois.append(cleaned_doi)
                    else:
                        logger.warning(f"⚠️ 无法从行 {line_num} 提取DOI: {line}")
        
            # 去重
            original_count = len(dois)
            dois = list(set(dois))
            logger.info(f"✅ 加载 {len(dois)} 个唯一DOI (原 {original_count} 个)")
            return dois
            
        except Exception as e:
            logger.error(f"❌ 读取文件失败: {e}")
            return []

    def save_state(self):
        """保存下载状态"""
        state_data = {
            "stats": self.stats,
            "mirror_stats": self.mirror_stats,
            "timestamp": datetime.now().isoformat()
        }
        try:
            with open(self.state_file, 'w', encoding='utf-8') as f:
                json.dump(state_data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"❌ 保存状态失败: {e}")

    def load_state(self):
        """加载下载状态"""
        try:
            if os.path.exists(self.state_file):
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    state_data = json.load(f)
                    self.stats = state_data.get("stats", self.stats)
                    self.mirror_stats = state_data.get("mirror_stats", self.mirror_stats)
                    logger.info(f"✅ 恢复之前的状态: 成功{self.stats['success']}, 失败{self.stats['failed']}, 跳过{self.stats['skipped']}")
        except Exception as e:
            logger.error(f"❌ 加载状态失败: {e}")

    def run(self):
        """主执行函数"""
        logger.info("=" * 80)
        logger.info("🚀 开始批量下载PDF (智能版本 - 使用BeautifulSoup解析)")
        logger.info(f"📁 输入文件: {self.input_file}")
        logger.info(f"💾 输出目录: {self.download_dir}")
        logger.info(f"🔗 镜像数量: {len(self.mirrors)}")
        logger.info(f"⚙️  配置: 延迟({self.config['delay_range'][0]}-{self.config['delay_range'][1]}s), 重试({self.config['max_retries']}次)")
        logger.info("=" * 80)
        
        try:
            # 加载状态
            self.load_state()
            
            # 加载DOI
            dois = self.load_dois()
            if not dois:
                logger.error("❌ 未找到有效DOI，程序退出")
                return
            
            self.stats['total'] = len(dois)
            
            # 逐个下载PDF
            start_time = time.time()
            for idx, doi in enumerate(dois, 1):
                progress = f"[{idx}/{len(dois)}]"
                logger.info(f"\n📥 {progress} DOI: {doi}")
                
                # 检查是否已存在
                if self.is_downloaded(doi):
                    logger.info(f"⏩ 已存在，跳过: {doi}")
                    self.stats['skipped'] += 1
                    continue
                
                success = self.download_single_pdf(doi)
                
                if success:
                    success_rate = (self.stats['success'] / max(1, self.stats['success'] + self.stats['failed'])) * 100
                    logger.info(f"📊 成功率: {success_rate:.1f}%")
                else:
                    logger.error(f"❌ 下载失败: {doi}")
                
                # 每20个显示一次详细进度
                if idx % 20 == 0 or idx == len(dois):
                    elapsed = time.time() - start_time
                    avg_time = elapsed / idx if idx > 0 else 0
                    remaining = (len(dois) - idx) * avg_time
                    success_rate = (self.stats['success'] / max(1, self.stats['total'] - self.stats['skipped'])) * 100
                    logger.info(
                        f"📈 进度: {idx}/{len(dois)} "
                        f"(成功: {self.stats['success']}, "
                        f"失败: {self.stats['failed']}, "
                        f"跳过: {self.stats['skipped']}) "
                        f"- 成功率: {success_rate:.1f}% "
                        f"- 预计剩余: {remaining/60:.1f}分钟"
                    )
                    
                    # 保存当前状态
                    self.save_state()
            
            # 最终统计
            total_time = time.time() - start_time
            logger.info("=" * 80)
            logger.info("🏁 下载完成!")
            logger.info(f"📄 总计DOI: {self.stats['total']}")
            logger.info(f"✅ 成功下载: {self.stats['success']}")
            logger.info(f"⏭️  跳过/已有: {self.stats['skipped']}")
            logger.info(f"❌ 下载失败: {self.stats['failed']}")
            if (self.stats['total'] - self.stats['skipped']) > 0:
                success_rate = (self.stats['success'] / (self.stats['total'] - self.stats['skipped'])) * 100
                logger.info(f"🎯 实际下载成功率: {success_rate:.1f}%")
            logger.info(f"⏱️  总耗时: {total_time/60:.1f}分钟")
            logger.info("=" * 80)
            
        finally:
            # 保存最终状态
            self.save_state()

def configure_logging(download_dir: Path) -> None:
    download_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.handlers.clear()
    kwargs = dict(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(download_dir / "smart_download.log", encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )
    try:
        logging.basicConfig(**kwargs, force=True)
    except TypeError:
        root.handlers.clear()
        logging.basicConfig(**kwargs)


def main():
    parser = argparse.ArgumentParser(description="按 DOI 列表从 Sci-Hub 镜像批量下载 PDF（本机脚本，自负版权责任）")
    parser.add_argument("--input", "-i", required=True, help="每行一个 DOI 或含 DOI 的文本文件")
    parser.add_argument(
        "--output",
        "-o",
        default=str(Path.cwd() / "scihub_pdf_out"),
        help="PDF 保存目录（默认 ./scihub_pdf_out）",
    )
    args = parser.parse_args()
    download_dir = Path(args.output).resolve()
    input_file = str(Path(args.input).resolve())
    state_file = str(download_dir / "download_state.json")
    configure_logging(download_dir)

    config = {
        "delay_range": (8, 15),
        "timeout": (20, 90),
        "max_retries": 5,
    }

    downloader = SmartSciHubDownloader(
        input_file=input_file,
        download_dir=str(download_dir),
        state_file=state_file,
        mirrors=MIRRORS,
        config=config,
    )

    try:
        downloader.run()
    except KeyboardInterrupt:
        logger.info("⏹️  用户中断，程序退出")
    except Exception as e:
        logger.error(f"💥 程序异常: {e}")
        import traceback

        logger.error(traceback.format_exc())


if __name__ == "__main__":
    main()
