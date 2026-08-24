/**
 * API 服务层 - 统一管理后端通信
 */

const API_CONFIG = {
    baseURL: `${window.location.origin}/api/v1`,
    timeout: 10000,
    retries: 2
};

// 请求拦截器
class ApiClient {
    constructor() {
        this.baseURL = API_CONFIG.baseURL;
        this.token = localStorage.getItem('admin_token');
    }

    getHeaders() {
        const headers = {
            'Content-Type': 'application/json'
        };
        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        return headers;
    }

    updateToken(token) {
        this.token = token;
        if (token) {
            localStorage.setItem('admin_token', token);
        } else {
            localStorage.removeItem('admin_token');
        }
    }

    clearToken() {
        this.token = null;
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_username');
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.timeout);

        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...this.getHeaders(),
                    ...options.headers
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // 处理401未授权
            if (response.status === 401 || response.status === 403) {
                if (response.status === 403) {
                    this.clearToken();
                    window.dispatchEvent(new CustomEvent('auth:logout', {
                        detail: { reason: 'admin_forbidden' }
                    }));
                    throw new Error('该账号没有管理员权限');
                }
                this.clearToken();
                window.dispatchEvent(new CustomEvent('auth:logout', { 
                    detail: { reason: 'token_expired' }
                }));
                throw new Error('登录已过期，请重新登录');
            }

            // 处理其他错误
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `请求失败: ${response.status}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (error.name === 'AbortError') {
                throw new Error('请求超时，请检查网络连接');
            }
            
            throw error;
        }
    }

    // 登录
    async login(username, password) {
        const data = await this.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });

        // 适配后端返回格式
        if (data.token && data.user) {
            if (data.user.isAdmin !== true) {
                this.clearToken();
                throw new Error('该账号没有管理员权限');
            }
            this.updateToken(data.token);
            return {
                success: true,
                token: data.token,
                user: data.user
            };
        } else if (data.success && data.data) {
            this.updateToken(data.data.access_token);
            return {
                success: true,
                token: data.data.access_token,
                user: data.data
            };
        }

        throw new Error(data.message || '登录失败');
    }

    // 仪表盘数据
    async getDashboard() {
        const data = await this.request('/admin/dashboard');
        return data.data || data;
    }

    // 用户列表
    async getUsers(params = {}) {
        const query = new URLSearchParams(params).toString();
        const data = await this.request(`/admin/users?${query}`);
        return data.data || data;
    }

    // 更新用户
    async updateUser(userId, userData) {
        const data = await this.request(`/admin/users/${userId}`, {
            method: 'PUT',
            body: JSON.stringify(userData)
        });
        return data.data || data;
    }

    // 删除用户
    async deleteUser(userId) {
        const data = await this.request(`/admin/users/${userId}`, {
            method: 'DELETE'
        });
        return data.data || data;
    }

    // 积分账户列表和平台统计
    async getPointUsers(params = {}) {
        const query = new URLSearchParams(params).toString();
        const data = await this.request(`/admin/points/users?${query}`);
        return data.data || data;
    }

    // 积分流水
    async getPointLedger(params = {}) {
        const query = new URLSearchParams(params).toString();
        const data = await this.request(`/admin/points/ledger?${query}`);
        return data.data || data;
    }

    // 管理员调整用户积分
    async adjustUserPoints(payload) {
        const data = await this.request('/admin/points/adjust', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        return data.data || data;
    }

    // PDF列表
    async getPDFs(params = {}) {
        const query = new URLSearchParams(params).toString();
        const data = await this.request(`/admin/pdfs?${query}`);
        return data.data || data;
    }

    // 获取单个PDF详情
    async getPDF(id) {
        const data = await this.request(`/admin/pdfs/${id}`);
        return data.data || data;
    }

    // 删除PDF
    async deletePDF(id) {
        const data = await this.request(`/admin/pdfs/${id}`, {
            method: 'DELETE'
        });
        return data.data || data;
    }

    // DOI列表
    async getDOIs(params = {}) {
        const query = new URLSearchParams(params).toString();
        const data = await this.request(`/admin/dois?${query}`);
        return data.data || data;
    }

    // 获取单个DOI详情
    async getDOI(id) {
        const data = await this.request(`/admin/dois/${id}`);
        return data.data || data;
    }

    // 删除DOI
    async deleteDOI(id) {
        const data = await this.request(`/admin/dois/${id}`, {
            method: 'DELETE'
        });
        return data.data || data;
    }

    // 上传DOI
    async uploadDOIs(dois) {
        const data = await this.request('/admin/dois/batch', {
            method: 'POST',
            body: JSON.stringify({ dois })
        });
        return data.data || data;
    }

    // 搜索日志
    async getSearchLogs(params = {}) {
        const query = new URLSearchParams(params).toString();
        const data = await this.request(`/admin/logs/searches?${query}`);
        return data.data || data;
    }

    // 系统配置
    async getConfig() {
        const data = await this.request('/admin/config');
        return data.data || data;
    }

    // 更新配置
    async updateConfig(config) {
        const data = await this.request('/admin/config', {
            method: 'PUT',
            body: JSON.stringify(config)
        });
        return data.data || data;
    }
}

// 导出单例
export const api = new ApiClient();
export default api;
