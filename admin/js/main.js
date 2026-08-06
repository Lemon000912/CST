/**
 * 犀材 - 管理端主应用
 * 模块化架构：API层 + 状态层 + 页面组件
 */

import { api } from './api.js';
import { store } from './store.js';
import { DashboardPage } from './pages/dashboard.js';
import { UsersPage } from './pages/users.js';
import { PDFsPage } from './pages/pdfs.js';
import { DOIsPage } from './pages/dois.js';
import { LogsPage } from './pages/logs.js';
import { ConfigPage } from './pages/config.js';

// 页面组件映射
const pages = {
    dashboard: DashboardPage,
    users: UsersPage,
    pdfs: PDFsPage,
    doi: DOIsPage,
    logs: LogsPage,
    config: ConfigPage
};

// 当前页面实例
let currentPageInstance = null;

// ==================== 初始化 ====================
async function init() {
    console.log('[Admin] 初始化管理端...');
    
    // 检查登录状态
    if (!store.isAuthenticated()) {
        showLoginPage();
    } else {
        // 验证token是否有效
        try {
            await api.getDashboard();
            showAdminPage();
        } catch (error) {
            console.log('[Admin] Token已过期，需要重新登录');
            store.clearUser();
            showLoginPage();
        }
    }
    
    // 绑定全局事件
    bindGlobalEvents();
}

// ==================== 页面切换 ====================
function showLoginPage() {
    const loginPage = document.getElementById('login-page');
    const adminPage = document.getElementById('admin-page');
    
    if (loginPage) loginPage.style.display = 'flex';
    if (adminPage) adminPage.style.display = 'none';
}

function showAdminPage() {
    const loginPage = document.getElementById('login-page');
    const adminPage = document.getElementById('admin-page');
    
    if (loginPage) loginPage.style.display = 'none';
    if (adminPage) adminPage.style.display = 'flex';
    
    // 更新用户名显示
    const usernameEl = document.getElementById('admin-username');
    if (usernameEl) {
        const username = store.get('user')?.username || localStorage.getItem('admin_username') || 'admin';
        usernameEl.innerHTML = `<i class="fas fa-user-circle"></i> ${username}`;
    }
    
    // 加载默认页面
    showPage('dashboard');
}

async function showPage(pageName) {
    // 卸载当前页面
    if (currentPageInstance) {
        currentPageInstance.unmount();
        currentPageInstance = null;
    }
    
    // 更新导航状态
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === pageName) {
            item.classList.add('active');
        }
    });
    
    // 切换页面显示
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    
    const targetPage = document.getElementById(`page-${pageName}`);
    if (targetPage) {
        targetPage.classList.add('active');
    }
    
    store.set('currentPage', pageName);
    
    // 加载页面组件
    const PageClass = pages[pageName];
    if (PageClass) {
        currentPageInstance = new PageClass();
        await currentPageInstance.mount();
    }
}

// ==================== 事件绑定 ====================
function bindGlobalEvents() {
    // 登录表单
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    }
    
    // 登出按钮
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
    
    // 侧边栏切换
    const toggleSidebar = document.getElementById('toggle-sidebar');
    if (toggleSidebar) {
        toggleSidebar.addEventListener('click', () => {
            document.body.classList.toggle('sidebar-collapsed');
        });
    }
    
    // 导航菜单
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const page = item.dataset.page;
            if (page) {
                showPage(page);
            }
        });
    });
    
    // 监听认证过期事件
    window.addEventListener('auth:logout', (e) => {
        console.log('[Admin] 认证过期:', e.detail.reason);
        store.clearUser();
        showLoginPage();
        showError('登录已过期，请重新登录');
    });
}

// ==================== 登录/登出处理 ====================
async function handleLogin(e) {
    e.preventDefault();
    
    const username = document.getElementById('username')?.value.trim();
    const password = document.getElementById('password')?.value;
    
    if (!username || !password) {
        showError('请输入用户名和密码');
        return;
    }
    
    try {
        const result = await api.login(username, password);
        
        if (result.success) {
            store.setUser(result.user);
            showAdminPage();
        }
    } catch (error) {
        showError(error.message || '登录失败');
    }
}

function handleLogout(e) {
    e.preventDefault();
    
    api.clearToken();
    store.clearUser();
    showLoginPage();
}

// ==================== 工具函数 ====================
function showError(message) {
    const errorDiv = document.getElementById('login-error');
    if (errorDiv) {
        errorDiv.textContent = message;
        setTimeout(() => {
            errorDiv.textContent = '';
        }, 3000);
    }
}

// ==================== 启动应用 ====================
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
