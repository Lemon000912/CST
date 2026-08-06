/**
 * 用户管理页面组件
 */
import { api } from '../api.js';
import { store } from '../store.js';

export class UsersPage {
    constructor() {
        this.container = document.getElementById('page-users');
        this.currentPage = 1;
        this.searchQuery = '';
        this.filterStatus = '';
    }

    async mount() {
        this.bindEvents();
        await this.loadData();
    }

    bindEvents() {
        // 搜索
        const searchInput = document.getElementById('user-search');
        if (searchInput) {
            searchInput.addEventListener('input', this.debounce((e) => {
                this.searchQuery = e.target.value;
                this.currentPage = 1;
                this.loadData();
            }, 300));
        }

        // 筛选
        const filterSelect = document.getElementById('user-filter');
        if (filterSelect) {
            filterSelect.addEventListener('change', (e) => {
                this.filterStatus = e.target.value;
                this.currentPage = 1;
                this.loadData();
            });
        }

        // 分页
        const prevBtn = document.getElementById('user-prev');
        const nextBtn = document.getElementById('user-next');
        
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

            if (this.filterStatus) {
                params.status = this.filterStatus;
            }

            const data = await api.getUsers(params);
            
            this.renderUsers(data.users || []);
            this.updatePagination(data.total || 0);
            
            store.updateList('users', data.users || [], {
                skip: params.skip,
                limit: params.limit,
                total: data.total || 0
            });
        } catch (error) {
            console.error('加载用户数据失败:', error);
            this.showError('加载用户数据失败');
        } finally {
            this.setLoading(false);
        }
    }

    renderUsers(users) {
        const tbody = document.getElementById('users-table-body');
        if (!tbody) return;

        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">暂无数据</td></tr>';
            return;
        }

        tbody.innerHTML = users.map(user => `
            <tr>
                <td>${user.id}</td>
                <td>${user.username}</td>
                <td>${user.email || '-'}</td>
                <td>${this.formatDate(user.created_at)}</td>
                <td>${this.formatDate(user.last_active)}</td>
                <td>
                    <span class="status-badge ${user.is_active ? 'active' : 'inactive'}">
                        ${user.is_active ? '活跃' : '禁用'}
                    </span>
                </td>
                <td>
                    <button class="btn-icon" onclick="editUser(${user.id})" title="编辑">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn-icon" onclick="deleteUser(${user.id})" title="删除">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    }

    updatePagination(total) {
        const pageInfo = document.getElementById('user-page-info');
        const prevBtn = document.getElementById('user-prev');
        const nextBtn = document.getElementById('user-next');

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
        const tbody = document.getElementById('users-table-body');
        if (tbody && loading) {
            tbody.innerHTML = '<tr><td colspan="7" class="loading"><div class="spinner"></div></td></tr>';
        }
    }

    formatDate(dateString) {
        if (!dateString) return '-';
        const date = new Date(dateString);
        return date.toLocaleString('zh-CN');
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
        // 清理资源
    }
}
