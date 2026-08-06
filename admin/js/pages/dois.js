/**
 * DOI管理页面组件
 */
import { api } from '../api.js';
import { store } from '../store.js';

export class DOIsPage {
    constructor() {
        this.container = document.getElementById('page-doi');
        this.currentPage = 1;
        this.searchQuery = '';
    }

    async mount() {
        this.bindEvents();
        await this.loadData();
    }

    bindEvents() {
        // 搜索
        const searchInput = document.getElementById('doi-search');
        if (searchInput) {
            searchInput.addEventListener('input', this.debounce((e) => {
                this.searchQuery = e.target.value;
                this.currentPage = 1;
                this.loadData();
            }, 300));
        }

        // 分页
        const prevBtn = document.getElementById('doi-prev');
        const nextBtn = document.getElementById('doi-next');
        
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
        window.viewDOI = this.viewDOIDetail.bind(this);
        window.deleteDOI = this.deleteDOIConfirm.bind(this);
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

            const data = await api.getDOIs(params);
            
            this.renderDOIs(data.dois || []);
            this.updatePagination(data.total || 0);
            
            store.updateList('dois', data.dois || [], {
                skip: params.skip,
                limit: params.limit,
                total: data.total || 0
            });
        } catch (error) {
            console.error('加载DOI数据失败:', error);
            this.showError('加载DOI数据失败');
            this.renderDOIs([]);
        } finally {
            this.setLoading(false);
        }
    }

    async viewDOIDetail(id) {
        try {
            const doi = await api.getDOI(id);
            this.showDOIModal(doi);
        } catch (error) {
            console.error('获取DOI详情失败:', error);
            alert('获取详情失败: ' + error.message);
        }
    }

    showDOIModal(doi) {
        // 创建模态框
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'block';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 800px; max-height: 80vh; overflow-y: auto;">
                <div class="modal-header">
                    <h3><i class="fas fa-info-circle"></i> DOI详情</h3>
                    <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="detail-section">
                        <h4>基本信息</h4>
                        <div class="detail-item">
                            <label>ID:</label>
                            <span>${doi.id || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>DOI:</label>
                            <span>${doi.doi || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>标题:</label>
                            <span>${doi.title || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>作者:</label>
                            <span>${doi.authors || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>期刊:</label>
                            <span>${doi.journal || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>年份:</label>
                            <span>${doi.year || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>URL:</label>
                            <span><a href="${doi.url || '#'}" target="_blank">${doi.url || '-'}</a></span>
                        </div>
                    </div>
                    
                    <div class="detail-section">
                        <h4>扩展信息</h4>
                        <div class="detail-item">
                            <label>摘要:</label>
                            <span>${doi.abstract || '暂无摘要'}</span>
                        </div>
                        <div class="detail-item">
                            <label>关键词:</label>
                            <span>${doi.keywords || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>页码:</label>
                            <span>${doi.pages || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>卷号:</label>
                            <span>${doi.volume || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>期号:</label>
                            <span>${doi.issue || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>出版社:</label>
                            <span>${doi.publisher || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>语言:</label>
                            <span>${doi.language || '-'}</span>
                        </div>
                        <div class="detail-item">
                            <label>引用次数:</label>
                            <span>${doi.citations || '0'}</span>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="this.closest('.modal').remove()">关闭</button>
                    <a href="${doi.url || '#'}" target="_blank" class="btn-primary">
                        <i class="fas fa-external-link-alt"></i> 访问原文
                    </a>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    async deleteDOIConfirm(id) {
        if (!confirm('确定要删除这个DOI记录吗？此操作不可恢复。')) {
            return;
        }
        
        try {
            await api.deleteDOI(id);
            alert('删除成功');
            await this.loadData(); // 刷新列表
        } catch (error) {
            console.error('删除DOI失败:', error);
            alert('删除失败: ' + error.message);
        }
    }

    renderDOIs(dois) {
        const tbody = document.getElementById('doi-table-body');
        if (!tbody) return;

        if (dois.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">暂无数据</td></tr>';
            return;
        }

        tbody.innerHTML = dois.map(doi => `
            <tr>
                <td>${doi.id}</td>
                <td>${doi.doi || '-'}</td>
                <td>${doi.title || '-'}</td>
                <td>${doi.authors || '-'}</td>
                <td>${doi.journal || '-'}</td>
                <td>${doi.year || '-'}</td>
                <td>
                    <button class="btn-icon" onclick="viewDOI('${doi.id}')" title="查看详情">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="btn-icon" onclick="deleteDOI('${doi.id}')" title="删除">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    updatePagination(total) {
        const pageInfo = document.getElementById('doi-page-info');
        const prevBtn = document.getElementById('doi-prev');
        const nextBtn = document.getElementById('doi-next');

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
        const tbody = document.getElementById('doi-table-body');
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
        window.viewDOI = null;
        window.deleteDOI = null;
    }
}
