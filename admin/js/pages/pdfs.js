/**
 * 文献数据库页面组件
 */
import { api } from '../api.js';
import { store } from '../store.js';

export class PDFsPage {
    constructor() {
        this.container = document.getElementById('page-pdfs');
        this.currentPage = 1;
        this.searchQuery = '';
        this.categoryFilter = '';
    }

    async mount() {
        this.bindEvents();
        await this.loadData();
    }

    bindEvents() {
        // 搜索
        const searchInput = document.getElementById('pdf-search');
        if (searchInput) {
            searchInput.addEventListener('input', this.debounce((e) => {
                this.searchQuery = e.target.value;
                this.currentPage = 1;
                this.loadData();
            }, 300));
        }

        // 分类筛选
        const categorySelect = document.getElementById('pdf-category');
        if (categorySelect) {
            categorySelect.addEventListener('change', (e) => {
                this.categoryFilter = e.target.value;
                this.currentPage = 1;
                this.loadData();
            });
        }

        // 分页
        const prevBtn = document.getElementById('pdf-prev');
        const nextBtn = document.getElementById('pdf-next');
        
        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.loadData();
                }
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                this.currentPage++;
                this.loadData();
            });
        }

        // 绑定全局函数到window对象
        window.viewPDF = this.viewPDFDetail.bind(this);
        window.deletePDF = this.deletePDFConfirm.bind(this);
    }

    async loadData() {
        try {
            this.setLoading(true);
            
            const params = {
                skip: (this.currentPage - 1) * 10,
                limit: 10
            };

            if (this.searchQuery) {
                params.search = this.searchQuery;
            }

            if (this.categoryFilter) {
                params.category = this.categoryFilter;
            }

            const data = await api.getPDFs(params);
            
            this.renderPDFs(data.pdfs || []);
            this.updatePagination(data.total || 0);
            
            store.updateList('pdfs', data.pdfs || [], {
                skip: params.skip,
                limit: params.limit,
                total: data.total || 0
            });
        } catch (error) {
            console.error('加载文献数据失败:', error);
            this.showError('加载文献数据失败');
            this.renderPDFs([]);
        } finally {
            this.setLoading(false);
        }
    }

    async viewPDFDetail(id) {
        try {
            const pdf = await api.getPDF(id);
            this.showPDFModal(pdf);
        } catch (error) {
            console.error('获取文献详情失败:', error);
            alert('获取详情失败: ' + error.message);
        }
    }

    showPDFModal(pdf) {
        // 创建模态框显示11个要素
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'block';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 900px; max-height: 85vh; overflow-y: auto;">
                <div class="modal-header">
                    <h3><i class="fas fa-file-pdf"></i> 文献详情（11要素）</h3>
                    <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="detail-section">
                        <h4>核心要素</h4>
                        <div class="detail-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <div class="detail-item">
                                <label>1. 材料名称:</label>
                                <span>${pdf.material_name || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>2. 材料类型:</label>
                                <span>${pdf.material_type || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>3. 应用领域:</label>
                                <span>${pdf.application_field || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>4. 性能指标:</label>
                                <span>${pdf.performance_metrics || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>5. 制备方法:</label>
                                <span>${pdf.preparation_method || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>6. 测试条件:</label>
                                <span>${pdf.test_conditions || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>7. 数据来源:</label>
                                <span>${pdf.data_source || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>8. 发表年份:</label>
                                <span>${pdf.year || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>9. 期刊名称:</label>
                                <span>${pdf.journal || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>10. DOI:</label>
                                <span>${pdf.doi || '-'}</span>
                            </div>
                            <div class="detail-item" style="grid-column: 1 / -1;">
                                <label>11. 摘要:</label>
                                <span style="white-space: pre-wrap;">${pdf.abstract || '暂无摘要'}</span>
                            </div>
                        </div>
                    </div>
                    
                    <div class="detail-section" style="margin-top: 20px;">
                        <h4>附加信息</h4>
                        <div class="detail-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                            <div class="detail-item">
                                <label>ID:</label>
                                <span>${pdf.id || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>标题:</label>
                                <span>${pdf.title || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>作者:</label>
                                <span>${pdf.authors || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>关键词:</label>
                                <span>${pdf.keywords || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>页码:</label>
                                <span>${pdf.pages || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>卷号:</label>
                                <span>${pdf.volume || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>期号:</label>
                                <span>${pdf.issue || '-'}</span>
                            </div>
                            <div class="detail-item">
                                <label>引用次数:</label>
                                <span>${pdf.citations || '0'}</span>
                            </div>
                            <div class="detail-item" style="grid-column: 1 / -1;">
                                <label>URL:</label>
                                <span><a href="${pdf.url || '#'}" target="_blank">${pdf.url || '-'}</a></span>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="this.closest('.modal').remove()">关闭</button>
                    <a href="${pdf.url || '#'}" target="_blank" class="btn-primary">
                        <i class="fas fa-external-link-alt"></i> 访问原文
                    </a>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    async deletePDFConfirm(id) {
        if (!confirm('确定要删除这个文献记录吗？此操作不可恢复。')) {
            return;
        }
        
        try {
            await api.deletePDF(id);
            alert('删除成功');
            await this.loadData(); // 刷新列表
        } catch (error) {
            console.error('删除文献失败:', error);
            alert('删除失败: ' + error.message);
        }
    }

    renderPDFs(pdfs) {
        const tbody = document.getElementById('pdfs-table-body');
        if (!tbody) return;

        if (pdfs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">暂无数据</td></tr>';
            return;
        }

        tbody.innerHTML = pdfs.map(pdf => `
            <tr>
                <td>${pdf.id}</td>
                <td>${pdf.doi || '-'}</td>
                <td title="${pdf.title || ''}">${pdf.title ? (pdf.title.length > 40 ? pdf.title.substring(0, 40) + '...' : pdf.title) : '-'}</td>
                <td>${pdf.material_name || '-'}</td>
                <td>${pdf.material_type || '-'}</td>
                <td>${pdf.year || '-'}</td>
                <td>
                    <button class="btn-icon" onclick="viewPDF('${pdf.id}')" title="查看详情（11要素）">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="btn-icon" onclick="deletePDF('${pdf.id}')" title="删除">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    updatePagination(total) {
        const pageInfo = document.getElementById('pdf-page-info');
        const prevBtn = document.getElementById('pdf-prev');
        const nextBtn = document.getElementById('pdf-next');

        const totalPages = Math.ceil(total / 10) || 1;
        
        if (pageInfo) {
            pageInfo.textContent = `第 ${this.currentPage} 页 / 共 ${totalPages} 页`;
        }
        
        if (prevBtn) {
            prevBtn.disabled = this.currentPage <= 1;
        }
        
        if (nextBtn) {
            nextBtn.disabled = this.currentPage >= totalPages;
        }
    }

    setLoading(loading) {
        const tbody = document.getElementById('pdfs-table-body');
        if (tbody && loading) {
            tbody.innerHTML = '<tr><td colspan="7" class="loading"><div class="spinner"></div></td></tr>';
        }
    }

    debounce(fn, delay) {
        let timer = null;
        return function(...args) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    showError(message) {
        console.error(message);
    }

    unmount() {
        // 清理全局函数
        window.viewPDF = null;
        window.deletePDF = null;
    }
}
