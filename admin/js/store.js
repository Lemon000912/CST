/**
 * 状态管理 - 集中管理应用状态
 */

class Store {
    constructor() {
        this.state = {
            user: null,
            token: localStorage.getItem('admin_token'),
            currentPage: 'dashboard',
            loading: false,
            stats: {
                users: { total: 0, active: 0 },
                papers: { total: 0, doi_count: 0, journal_papers: 0 },
                today_searches: 0,
                weekly_trend: []
            },
            users: {
                list: [],
                pagination: { skip: 0, limit: 10, total: 0 }
            },
            pdfs: {
                list: [],
                pagination: { skip: 0, limit: 10, total: 0 }
            },
            dois: {
                list: [],
                pagination: { skip: 0, limit: 10, total: 0 }
            },
            logs: [],
            config: null
        };
        this.listeners = new Map();
    }

    // 订阅状态变化
    subscribe(key, callback) {
        if (!this.listeners.has(key)) {
            this.listeners.set(key, new Set());
        }
        this.listeners.get(key).add(callback);
        
        // 返回取消订阅函数
        return () => {
            this.listeners.get(key).delete(callback);
        };
    }

    // 通知订阅者
    notify(key, value) {
        if (this.listeners.has(key)) {
            this.listeners.get(key).forEach(callback => {
                try {
                    callback(value);
                } catch (e) {
                    console.error('Store listener error:', e);
                }
            });
        }
    }

    // 获取状态
    get(key) {
        if (key) {
            return key.split('.').reduce((obj, k) => obj?.[k], this.state);
        }
        return this.state;
    }

    // 设置状态
    set(key, value) {
        const keys = key.split('.');
        let current = this.state;
        
        for (let i = 0; i < keys.length - 1; i++) {
            if (!(keys[i] in current)) {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }
        
        current[keys[keys.length - 1]] = value;
        this.notify(key, value);
    }

    // 更新用户状态
    setUser(user) {
        this.state.user = user;
        if (user) {
            localStorage.setItem('admin_username', user.username);
        }
        this.notify('user', user);
    }

    // 清除用户状态
    clearUser() {
        this.state.user = null;
        this.state.token = null;
        localStorage.removeItem('admin_token');
        localStorage.removeItem('admin_username');
        this.notify('user', null);
    }

    // 设置加载状态
    setLoading(loading) {
        this.state.loading = loading;
        this.notify('loading', loading);
    }

    // 更新统计数据
    updateStats(stats) {
        this.state.stats = { ...this.state.stats, ...stats };
        this.notify('stats', this.state.stats);
    }

    // 更新列表数据
    updateList(type, data, pagination) {
        this.state[type] = {
            list: data,
            pagination: pagination || this.state[type].pagination
        };
        this.notify(type, this.state[type]);
    }

    // 检查是否已登录
    isAuthenticated() {
        return !!this.state.token;
    }
}

// 导出单例
export const store = new Store();
export default store;
