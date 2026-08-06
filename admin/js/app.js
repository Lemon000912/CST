/**
 * QuantumPinnacle（量子巅）- 管理端前端
 */

// ==================== 配置 ====================
// 后端 API：与当前站点同源（Apache 反代 /api → 8787）
const API_BASE_URL = `${window.location.origin}/api/v1`;

// ==================== 全局状态 ====================
let currentToken = localStorage.getItem('admin_token');
let currentUser = localStorage.getItem('admin_username');
let currentPage = 'dashboard';
let pagination = {
    users: { skip: 0, limit: 10, total: 0 },
    pdfs: { skip: 0, limit: 10, total: 0 },
    dois: { skip: 0, limit: 10, total: 0 }
};

// ==================== 工具函数 ====================
function showError(message) {
    const errorDiv = document.getElementById('login-error');
    if (errorDiv) {
        errorDiv.textContent = message;
        setTimeout(() => errorDiv.textContent = '', 3000);
    }
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN');
}

function formatFileSize(bytes) {
    if (!bytes) return '-';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

function getAuthHeaders() {
    return {
        'Authorization': `Bearer ${currentToken}`,
        'Content-Type': 'application/json'
    };
}

async function apiRequest(url, options = {}) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
        
        const response = await fetch(url, {
            ...options,
            headers: {
                ...getAuthHeaders(),
                ...options.headers
            },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (response.status === 401 || response.status === 403) {
            if (response.status === 403) {
                showError('该账号没有管理员权限');
                logout();
                return null;
            }
            showError('登录已过期，请重新登录');
            logout();
            return null;
        }
        
        if (!response.ok) {
            console.error(`API错误: ${response.status} ${response.statusText}`);
            return null;
        }
        
        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('API请求超时:', url);
            showError('请求超时，请检查网络连接');
        } else {
            console.error('API请求失败:', error);
        }
        return null;
    }
}

// ==================== 页面切换 ====================
function showPage(pageName) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    
    const targetPage = document.getElementById(`page-${pageName}`);
    if (targetPage) {
        targetPage.classList.add('active');
    }
    
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === pageName) {
            item.classList.add('active');
        }
    });
    
    currentPage = pageName;
    loadPageData(pageName);
}

function loadPageData(pageName) {
    switch(pageName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'users':
            loadUsers();
            break;
        case 'pdfs':
            loadPDFs();
            break;
        case 'doi':
            loadDOIs();
            break;
        case 'logs':
            loadLogs('system');
            break;
        case 'config':
            loadConfig();
            break;
    }
}

// ==================== 登录/登出 ====================
async function login(username, password) {
    try {
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        // 适配后端返回格式: { token, user: { id, username } }
        if (data.token && data.user) {
            if (data.user.isAdmin !== true) {
                showError('该账号没有管理员权限');
                return false;
            }
            currentToken = data.token;
            currentUser = data.user.username;
            
            localStorage.setItem('admin_token', currentToken);
            localStorage.setItem('admin_username', currentUser);
            
            showAdminPage();
            return true;
        } else if ((data.success || data.status === 'success') && data.data) {
            // 兼容旧格式
            currentToken = data.data.access_token;
            currentUser = data.data.username;
            
            localStorage.setItem('admin_token', currentToken);
            localStorage.setItem('admin_username', currentUser);
            
            showAdminPage();
            return true;
        } else {
            const errorMsg = data.error || data.message || data.detail || '登录失败';
            showError(errorMsg);
            return false;
        }
    } catch (error) {
        showError('网络错误，请检查服务是否运行');
        console.error('Login error:', error);
        return false;
    }
}

function logout() {
    currentToken = null;
    currentUser = null;
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_username');
    showLoginPage();
}

function showLoginPage() {
    document.getElementById('login-page').style.display = 'flex';
    document.getElementById('admin-page').style.display = 'none';
}

function showAdminPage() {
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('admin-page').style.display = 'flex';
    document.getElementById('admin-username').innerHTML = `<i class="fas fa-user-circle"></i> ${currentUser || 'admin'}`;
    showPage('dashboard');
}

// ==================== 仪表盘 ====================
async function loadDashboard() {
    // 显示加载状态
    document.getElementById('stat-users').textContent = '-';
    document.getElementById('stat-active').textContent = '-';
    document.getElementById('stat-papers').textContent = '-';
    document.getElementById('stat-searches').textContent = '-';

    const data = await apiRequest(`${API_BASE_URL}/admin/dashboard`);

    if (data && (data.success || data.status === 'success')) {
        const stats = data.data;

        document.getElementById('stat-users').textContent = stats.users?.total || 0;
        document.getElementById('stat-active').textContent = stats.users?.active || 0;
        // 论文数量 = DOI数量 + 15万
        const paperTotal = stats.papers?.total || 0;
        document.getElementById('stat-papers').textContent = paperTotal.toLocaleString();

        document.getElementById('stat-searches').textContent = stats.today_searches || 0;

        loadSearchTrend(stats.weekly_trend);
        loadPaperSource(stats.papers);
    } else {
        // 加载失败时显示0
        document.getElementById('stat-users').textContent = '0';
        document.getElementById('stat-active').textContent = '0';
        document.getElementById('stat-papers').textContent = '0';
        document.getElementById('stat-searches').textContent = '0';

        // 图表显示无数据
        document.getElementById('trend-loading').innerHTML = '<p style="text-align: center; color: #999;">加载失败</p>';
        document.getElementById('source-loading').innerHTML = '<p style="text-align: center; color: #999;">加载失败</p>';
    }
}

function loadSearchTrend(trendData) {
    const loading = document.getElementById('trend-loading');
    const canvas = document.getElementById('trendCanvas');
    
    if (!trendData || trendData.length === 0) {
        loading.innerHTML = '<p style="text-align: center; color: #999;">暂无数据</p>';
        return;
    }
    
    loading.style.display = 'none';
    canvas.style.display = 'block';
    
    const ctx = canvas.getContext('2d');
    const labels = trendData.map(d => d.date);
    const values = trendData.map(d => d.count);
    
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;
    const padding = 40;
    const barWidth = (width - padding * 2) / labels.length - 10;
    const maxValue = Math.max(...values, 1);
    
    ctx.clearRect(0, 0, width, height);
    
    ctx.strokeStyle = '#ddd';
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, height - padding);
    ctx.lineTo(width - padding, height - padding);
    ctx.stroke();
    
    values.forEach((value, index) => {
        const x = padding + index * (barWidth + 10) + 5;
        const barHeight = (value / maxValue) * (height - padding * 2);
        const y = height - padding - barHeight;
        
        ctx.fillStyle = '#4a90e2';
        ctx.fillRect(x, y, barWidth, barHeight);
        
        ctx.fillStyle = '#333';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(value.toString(), x + barWidth / 2, y - 5);
        
        ctx.save();
        ctx.translate(x + barWidth / 2, height - padding + 15);
        ctx.rotate(-Math.PI / 4);
        ctx.fillText(labels[index], 0, 0);
        ctx.restore();
    });
}

function loadPaperSource(paperStats) {
    const loading = document.getElementById('source-loading');
    const info = document.getElementById('source-info');

    if (!paperStats) {
        loading.innerHTML = '<p style="text-align: center; color: #999;">暂无数据</p>';
        return;
    }

    loading.style.display = 'none';
    info.style.display = 'block';

    document.getElementById('source-doi').textContent = (paperStats.doi_count || 0).toLocaleString();
    document.getElementById('source-journal').textContent = (paperStats.journal_papers || 0).toLocaleString();
}

// ==================== 用户管理 ====================
async function loadUsers() {
    const { skip, limit } = pagination.users;
    const search = document.getElementById('user-search')?.value || '';
    const isActive = document.getElementById('user-filter')?.value || '';
    
    let url = `${API_BASE_URL}/admin/users?skip=${skip}&limit=${limit}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (isActive) url += `&is_active=${isActive}`;
    
    const data = await apiRequest(url);
    const tbody = document.getElementById('users-table-body');
    
    if (data && (data.success || data.status === 'success')) {
        const users = data.data.users || [];
        pagination.users.total = data.data.total || 0;
        
        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px;">暂无数据</td></tr>';
        } else {
            tbody.innerHTML = users.map(user => `
                <tr>
                    <td>${user.id.substring(0, 8)}...</td>
                    <td>${user.username}</td>
                    <td>${user.email || '-'}</td>
                    <td>${formatDate(user.created_at)}</td>
                    <td>${formatDate(user.last_active)}</td>
                    <td><span class="status-badge ${user.is_active ? 'active' : 'inactive'}">${user.is_active ? '活跃' : '禁用'}</span></td>
                    <td class="actions">
                        <button class="btn-action edit" onclick="editUser('${user.id}', '${user.username}', '${user.email || ''}', ${user.is_active})">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-action delete" onclick="deleteUser('${user.id}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `).join('');
        }
        
        updatePagination('user', skip, limit, pagination.users.total);
    } else {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px;">加载失败</td></tr>';
    }
}

function updatePagination(type, skip, limit, total) {
    const pageNum = Math.floor(skip / limit) + 1;
    const totalPages = Math.ceil(total / limit) || 1;
    
    document.getElementById(`${type}-page-info`).textContent = `第 ${pageNum} 页 / 共 ${totalPages} 页`;
    document.getElementById(`${type}-prev`).disabled = skip === 0;
    document.getElementById(`${type}-next`).disabled = skip + limit >= total;
}

function editUser(id, username, email, isActive) {
    document.getElementById('edit-user-id').value = id;
    document.getElementById('edit-username').value = username;
    document.getElementById('edit-email').value = email;
    document.getElementById('edit-status').value = isActive ? '1' : '0';
    document.getElementById('edit-user-modal').classList.add('active');
}

async function saveUser() {
    const id = document.getElementById('edit-user-id').value;
    const email = document.getElementById('edit-email').value;
    const isActive = document.getElementById('edit-status').value === '1';
    
    const data = await apiRequest(`${API_BASE_URL}/admin/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ email, is_active: isActive })
    });
    
    if (data && (data.success || data.status === 'success')) {
        closeModal();
        loadUsers();
    } else {
        alert(data?.message || '保存失败');
    }
}

async function deleteUser(id) {
    if (!confirm('确定要删除该用户吗？')) return;
    
    const data = await apiRequest(`${API_BASE_URL}/admin/users/${id}`, {
        method: 'DELETE'
    });
    
    if (data && (data.success || data.status === 'success')) {
        loadUsers();
    } else {
        alert(data?.message || '删除失败');
    }
}

function closeModal() {
    document.getElementById('edit-user-modal').classList.remove('active');
}

// 9大领域中文映射
const CATEGORY_NAMES = {
    'amorphous_glass': '非晶玻璃',
    'composite_multiphase': '复合多相材料',
    'solid_state_ionic': '固态离子材料',
    'optical_optoelectronic': '光学/光电材料',
    'alloy_metallic': '合金/金属材料',
    'ceramic_structural': '结构陶瓷',
    'nanomaterials_lowdim': '低维纳米材料',
    'polymer_soft_matter': '高分子/软物质',
    'surface_thin_film': '表面/薄膜材料'
};

// ==================== PDF文献管理 ====================
async function loadPDFs() {
    const { skip, limit } = pagination.pdfs;
    const category = document.getElementById('pdf-category')?.value || '';
    const search = document.getElementById('pdf-search')?.value || '';
    
    let url = `${API_BASE_URL}/admin/pdfs?skip=${skip}&limit=${limit}`;
    if (category) url += `&category=${encodeURIComponent(category)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    
    const data = await apiRequest(url);
    const tbody = document.getElementById('pdfs-table-body');
    
    if (data && (data.success || data.status === 'success')) {
        const pdfs = data.data.pdfs || [];
        pagination.pdfs.total = data.data.total || 0;
        
        if (pdfs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px;">暂无数据</td></tr>';
        } else {
            tbody.innerHTML = pdfs.map(pdf => `
                <tr>
                    <td>${pdf.id.substring(0, 8)}...</td>
                    <td><a href="https://doi.org/${pdf.doi}" target="_blank" class="doi-link">${pdf.doi || '-'}</a></td>
                    <td>${pdf.title || pdf.material_name || '-'}</td>
                    <td>${pdf.material_name || '-'}</td>
                    <td>${CATEGORY_NAMES[pdf.category] || pdf.category || '-'}</td>
                    <td>${pdf.publish_year || '-'}</td>
                    <td class="actions">
                        <button class="btn-action view" onclick="viewPDFDetail('${pdf.id}')">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="btn-action delete" onclick="deletePDF('${pdf.id}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `).join('');
        }
        
        updatePagination('pdf', skip, limit, pagination.pdfs.total);
    } else {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px;">加载失败</td></tr>';
    }
}

async function processPDF(id) {
    const data = await apiRequest(`${API_BASE_URL}/admin/pdfs/${id}/process`, {
        method: 'POST'
    });
    
    if (data && (data.success || data.status === 'success')) {
        loadPDFs();
    } else {
        alert(data?.message || '处理失败');
    }
}

async function deletePDF(id) {
    if (!confirm('确定要删除该PDF文献吗？')) return;
    
    const data = await apiRequest(`${API_BASE_URL}/admin/pdfs/${id}`, {
        method: 'DELETE'
    });
    
    if (data && (data.success || data.status === 'success')) {
        loadPDFs();
    } else {
        alert(data?.message || '删除失败');
    }
}

function viewPDF(id) {
    alert('查看PDF功能开发中...');
}

async function viewPDFDetail(id) {
    const data = await apiRequest(`${API_BASE_URL}/admin/pdfs/${id}`);
    if (data && (data.success || data.status === 'success')) {
        const pdf = data.data;
        let detailHtml = `
            <div style="max-width: 600px; max-height: 80vh; overflow-y: auto; padding: 20px;">
                <h3>${pdf.title || pdf.material_name || '无标题'}</h3>
                <p><strong>DOI:</strong> <a href="https://doi.org/${pdf.doi}" target="_blank">${pdf.doi || '-'}</a></p>
                <p><strong>领域:</strong> ${CATEGORY_NAMES[pdf.category] || pdf.category || '-'}</p>
                <p><strong>年份:</strong> ${pdf.publish_year || '-'}</p>
                <hr style="margin: 15px 0;">
                <h4>材料信息</h4>
                <p><strong>材料名称:</strong> ${pdf.material_name || '-'}</p>
                <p><strong>对称相:</strong> ${pdf.symmetry_phase || '-'}</p>
                <p><strong>结构描述符:</strong> ${pdf.structure_descriptor || '-'}</p>
                <p><strong>属性:</strong> ${pdf.properties || '-'}</p>
                <p><strong>应用:</strong> ${pdf.applications || '-'}</p>
                <p><strong>合成方法:</strong> ${pdf.synthesis_method || '-'}</p>
                <p><strong>表征方法:</strong> ${pdf.characterization_method || '-'}</p>
                <p><strong>质检:</strong> ${pdf.quality_control || '-'}</p>
                <p><strong>第一作者:</strong> ${pdf.first_author || '-'}</p>
                <p><strong>通讯作者:</strong> ${pdf.corresponding_author || '-'}</p>
            </div>
        `;
        
        // 创建模态框显示详情
        const modal = document.createElement('div');
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 700px;">
                <div class="modal-header">
                    <h3><i class="fas fa-info-circle"></i> 文献详情</h3>
                    <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    ${detailHtml}
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="this.closest('.modal').remove()">关闭</button>
                    <a href="https://doi.org/${pdf.doi}" target="_blank" class="btn-primary">
                        <i class="fas fa-external-link-alt"></i> 查看原文
                    </a>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
}

// ==================== DOI管理 ====================
async function loadDOIs() {
    const { skip, limit } = pagination.dois;
    const search = document.getElementById('doi-search')?.value || '';
    
    let url = `${API_BASE_URL}/admin/dois?skip=${skip}&limit=${limit}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    
    const data = await apiRequest(url);
    const tbody = document.getElementById('doi-table-body');
    
    if (data && (data.success || data.status === 'success')) {
        const dois = data.data.dois || [];
        pagination.dois.total = data.data.total || 0;
        
        if (dois.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px;">暂无数据</td></tr>';
        } else {
            tbody.innerHTML = dois.map(doi => `
                <tr>
                    <td>${doi.id}</td>
                    <td><a href="https://doi.org/${doi.doi}" target="_blank" class="doi-link">${doi.doi || '-'}</a></td>
                    <td>${doi.title || '-'}</td>
                    <td>${doi.authors || '-'}</td>
                    <td>${doi.journal || '-'}</td>
                    <td>${doi.year || '-'}</td>
                    <td class="actions">
                        <button class="btn-action view" onclick="viewDOIDetails(${doi.id})">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button class="btn-action delete" onclick="deleteDOI(${doi.id})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `).join('');
        }
        
        updatePagination('doi', skip, limit, pagination.dois.total);
    } else {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px;">加载失败</td></tr>';
    }
}

async function viewDOIDetails(id) {
    const data = await apiRequest(`${API_BASE_URL}/admin/dois/${id}`);
    if (data && (data.success || data.status === 'success')) {
        const doi = data.data;
        
        // 创建模态框显示详情
        const modal = document.createElement('div');
        modal.className = 'modal active';
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 700px;">
                <div class="modal-header">
                    <h3><i class="fas fa-info-circle"></i> DOI详情</h3>
                    <button class="btn-close" onclick="this.closest('.modal').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <div style="max-height: 70vh; overflow-y: auto; padding: 10px;">
                        <h4>${doi.title || '无标题'}</h4>
                        <p><strong>DOI:</strong> <a href="https://doi.org/${doi.doi}" target="_blank">${doi.doi || '-'}</a></p>
                        <p><strong>作者:</strong> ${doi.authors || '-'}</p>
                        <p><strong>期刊:</strong> ${doi.journal || '-'}</p>
                        <p><strong>年份:</strong> ${doi.year || '-'}</p>
                        <p><strong>发表日期:</strong> ${doi.publish_date || '-'}</p>
                        <p><strong>URL:</strong> <a href="${doi.url}" target="_blank">${doi.url || '-'}</a></p>
                        <p><strong>导入时间:</strong> ${doi.imported_at || '-'}</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn-secondary" onclick="this.closest('.modal').remove()">关闭</button>
                    <a href="https://doi.org/${doi.doi}" target="_blank" class="btn-primary">
                        <i class="fas fa-external-link-alt"></i> 查看原文
                    </a>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
}

async function deleteDOI(id) {
    if (!confirm('确定要删除该DOI记录吗？')) return;
    
    const data = await apiRequest(`${API_BASE_URL}/admin/dois/${id}`, {
        method: 'DELETE'
    });
    
    if (data && (data.success || data.status === 'success')) {
        loadDOIs();
    } else {
        alert(data?.message || '删除失败');
    }
}

// 上传DOI模态框
function showUploadDOIModal() {
    document.getElementById('upload-doi-modal').classList.add('active');
}

function closeUploadDOIModal() {
    document.getElementById('upload-doi-modal').classList.remove('active');
    document.getElementById('doi-file').value = '';
    document.getElementById('doi-text').value = '';
    document.getElementById('upload-doi-status').innerHTML = '';
}

async function handleDOIFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        const text = e.target.result;
        document.getElementById('doi-text').value = text;
    };
    reader.readAsText(file);
}

async function uploadDOI() {
    const text = document.getElementById('doi-text').value.trim();
    if (!text) {
        showError('请输入DOI数据');
        return;
    }
    
    const lines = text.split('\n').filter(line => line.trim());
    const dois = lines.map(line => {
        const parts = line.split(',');
        return {
            doi: parts[0].trim(),
            title: parts[1] ? parts[1].trim() : ''
        };
    }).filter(item => item.doi);
    
    const statusDiv = document.getElementById('upload-doi-status');
    statusDiv.innerHTML = '<div class="loading"><div class="spinner"></div> 正在上传...</div>';
    
    const data = await apiRequest(`${API_BASE_URL}/admin/pdfs/batch`, {
        method: 'POST',
        body: JSON.stringify({ dois })
    });
    
    if (data && (data.success || data.status === 'success')) {
        statusDiv.innerHTML = `<div class="success-message">✅ 成功上传 ${data.data.imported || 0} 条DOI</div>`;
        setTimeout(() => {
            closeUploadDOIModal();
            loadDOIs();
        }, 1500);
    } else {
        statusDiv.innerHTML = `<div class="error-message">❌ 上传失败: ${data?.message || '未知错误'}</div>`;
    }
}

// ==================== 日志监控 ====================
async function loadLogs(type) {
    const container = document.getElementById('log-content');
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    
    let data;
    if (type === 'system') {
        data = await apiRequest(`${API_BASE_URL}/admin/logs/system?lines=100`);
    } else if (type === 'error') {
        data = await apiRequest(`${API_BASE_URL}/admin/logs/errors?lines=100`);
    } else if (type === 'searches') {
        data = await apiRequest(`${API_BASE_URL}/admin/logs/searches?skip=0&limit=50`);
    }
    
    if (data && (data.success || data.status === 'success')) {
        if (type === 'searches') {
            const logs = data.data.logs || [];
            if (logs.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #999;">暂无搜索日志</p>';
            } else {
                container.innerHTML = logs.map(log => `
                    <div class="log-line info">
                        [${formatDate(log.created_at)}] ${log.username || '匿名'}: ${log.query} (${log.results_count}条结果)
                    </div>
                `).join('');
            }
        } else {
            const logs = data.data.logs || [];
            if (logs.length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #999;">暂无日志</p>';
            } else {
                container.innerHTML = logs.map(log => {
                    let className = 'info';
                    if (log.includes('ERROR')) className = 'error';
                    else if (log.includes('WARNING')) className = 'warning';
                    return `<div class="log-line ${className}">${escapeHtml(log)}</div>`;
                }).join('');
            }
        }
    } else {
        container.innerHTML = '<p style="text-align: center; color: #999;">加载失败</p>';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== 系统配置 ====================
async function loadConfig() {
    const data = await apiRequest(`${API_BASE_URL}/admin/config`);
    
    if (data && (data.success || data.status === 'success')) {
        const config = data.data;
        
        document.getElementById('config-basic').innerHTML = `
            <div class="config-item"><label>应用名称</label><span>${config.app_name}</span></div>
            <div class="config-item"><label>版本</label><span>${config.app_version}</span></div>
            <div class="config-item"><label>调试模式</label><span>${config.debug ? '开启' : '关闭'}</span></div>
        `;
        
        document.getElementById('config-database').innerHTML = `
            <div class="config-item"><label>数据库</label><span>${config.database}</span></div>
        `;
        
        document.getElementById('config-search').innerHTML = `
            <div class="config-item"><label>最大搜索结果</label><span>${config.max_search_results}</span></div>
            <div class="config-item"><label>搜索超时</label><span>${config.search_timeout}秒</span></div>
        `;
        
        document.getElementById('config-security').innerHTML = `
            <div class="config-item"><label>日志级别</label><span>${config.log_level}</span></div>
        `;
    }
}

// ==================== 事件监听 ====================
document.addEventListener('DOMContentLoaded', function() {
    // 检查是否已登录
    if (currentToken) {
        showAdminPage();
    } else {
        showLoginPage();
    }
    
    // 登录表单
    document.getElementById('login-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        
        const btn = this.querySelector('.btn-login');
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 登录中...';
        btn.disabled = true;
        
        const success = await login(username, password);
        
        btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 登录';
        btn.disabled = false;
    });
    
    // 退出登录
    document.getElementById('logout-btn').addEventListener('click', function(e) {
        e.preventDefault();
        logout();
    });
    
    // 侧边栏切换
    document.getElementById('toggle-sidebar').addEventListener('click', function() {
        document.querySelector('.sidebar').classList.toggle('collapsed');
    });
    
    // 导航菜单
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            const page = this.dataset.page;
            showPage(page);
        });
    });
    
    // 用户搜索
    document.getElementById('user-search')?.addEventListener('input', debounce(function() {
        pagination.users.skip = 0;
        loadUsers();
    }, 300));
    
    // 用户筛选
    document.getElementById('user-filter')?.addEventListener('change', function() {
        pagination.users.skip = 0;
        loadUsers();
    });
    
    // 用户分页
    document.getElementById('user-prev')?.addEventListener('click', function() {
        if (pagination.users.skip >= pagination.users.limit) {
            pagination.users.skip -= pagination.users.limit;
            loadUsers();
        }
    });
    
    document.getElementById('user-next')?.addEventListener('click', function() {
        pagination.users.skip += pagination.users.limit;
        loadUsers();
    });
    
    // PDF领域筛选
    document.getElementById('pdf-category')?.addEventListener('change', function() {
        pagination.pdfs.skip = 0;
        loadPDFs();
    });
    
    // PDF搜索
    document.getElementById('pdf-search')?.addEventListener('input', debounce(function() {
        pagination.pdfs.skip = 0;
        loadPDFs();
    }, 300));
    
    // PDF分页
    document.getElementById('pdf-prev')?.addEventListener('click', function() {
        if (pagination.pdfs.skip >= pagination.pdfs.limit) {
            pagination.pdfs.skip -= pagination.pdfs.limit;
            loadPDFs();
        }
    });
    
    document.getElementById('pdf-next')?.addEventListener('click', function() {
        pagination.pdfs.skip += pagination.pdfs.limit;
        loadPDFs();
    });
    
    // DOI搜索
    document.getElementById('doi-search')?.addEventListener('input', debounce(function() {
        pagination.dois.skip = 0;
        loadDOIs();
    }, 300));
    
    // DOI分页
    document.getElementById('doi-prev')?.addEventListener('click', function() {
        if (pagination.dois.skip >= pagination.dois.limit) {
            pagination.dois.skip -= pagination.dois.limit;
            loadDOIs();
        }
    });
    
    document.getElementById('doi-next')?.addEventListener('click', function() {
        pagination.dois.skip += pagination.dois.limit;
        loadDOIs();
    });
    
    // 日志筛选
    document.querySelectorAll('.log-filters button').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.log-filters button').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            loadLogs(this.dataset.log);
        });
    });
    
    // 模态框
    document.querySelector('.modal-close')?.addEventListener('click', closeModal);
    document.querySelector('.btn-cancel')?.addEventListener('click', closeModal);
    
    document.getElementById('edit-user-form')?.addEventListener('submit', function(e) {
        e.preventDefault();
        saveUser();
    });
    
    // 点击模态框外部关闭
    document.getElementById('edit-user-modal')?.addEventListener('click', function(e) {
        if (e.target === this) closeModal();
    });
});

// 防抖函数
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}
