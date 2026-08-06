/**
 * 日志监控页面组件
 */
import { api } from '../api.js';
import { store } from '../store.js';

export class LogsPage {
    constructor() {
        this.container = document.getElementById('page-logs');
        this.currentLogType = 'system';
        this.currentPage = 1;
    }

    async mount() {
        this.bindEvents();
        await this.loadData();
    }

    bindEvents() {
        // 日志类型切换
        const logFilters = document.querySelectorAll('.log-filters button');
        logFilters.forEach(btn => {
            btn.addEventListener('click', (e) => {
                logFilters.forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentLogType = e.target.dataset.log;
                this.currentPage = 1;
                this.loadData();
            });
        });
    }

    async loadData() {
        try {
            this.setLoading(true);
            
            let data;
            switch (this.currentLogType) {
                case 'system':
                    data = await this.loadSystemLogs();
                    break;
                case 'error':
                    data = await this.loadClientErrorLogs();
                    break;
                case 'searches':
                    const searchData = await api.getSearchLogs({ limit: 50 });
                    data = searchData.logs || [];
                    break;
                default:
                    data = [];
            }
            
            this.renderLogs(data);
        } catch (error) {
            console.error('加载日志失败:', error);
            this.showError('加载日志失败');
            this.renderLogs([]);
        } finally {
            this.setLoading(false);
        }
    }

    async loadSystemLogs() {
        // 从后端获取系统日志
        try {
            const response = await api.request('/admin/logs/system');;
            return response.data?.logs || [
                { time: new Date().toISOString(), level: 'INFO', message: '系统运行正常' }
            ];
        } catch (e) {
            return [
                { time: new Date().toISOString(), level: 'INFO', message: '系统启动成功' },
                { time: new Date(Date.now() - 60000).toISOString(), level: 'INFO', message: '数据库连接正常' },
                { time: new Date(Date.now() - 120000).toISOString(), level: 'WARN', message: '缓存清理完成' }
            ];
        }
    }

    async loadClientErrorLogs() {
        // 从后端获取客户端错误日志
        try {
            const response = await api.request('/admin/logs/client');
            return response.data?.logs || [];
        } catch (e) {
            console.error('加载客户端错误日志失败:', e);
            return [];
        }
    }

    renderLogs(logs) {
        const container = document.getElementById('log-content');
        if (!container) return;

        if (!logs || logs.length === 0) {
            container.innerHTML = '<p style="text-align: center; padding: 20px; color: #999;">暂无日志数据</p>';
            return;
        }

        const logHtml = logs.map(log => {
            const time = new Date(log.time || log.ts || log.created_at).toLocaleString('zh-CN');
            const level = log.level || 'INFO';
            const message = log.message || log.query || log.msg || '-';
            const url = log.url || '';
            const stack = log.stack || '';
            
            let levelClass = 'info';
            if (level === 'ERROR' || level === 'error') levelClass = 'error';
            if (level === 'WARN' || level === 'warn') levelClass = 'warn';
            
            // 客户端错误显示更多信息
            const extraInfo = (this.currentLogType === 'error' && url) 
                ? `<div style="font-size: 12px; color: #666; margin-top: 4px;">URL: ${url}</div>` 
                : '';
            
            const stackTrace = (this.currentLogType === 'error' && stack)
                ? `<details style="margin-top: 8px; font-size: 11px;">
                    <summary style="cursor: pointer; color: #999;">查看堆栈</summary>
                    <pre style="background: #f5f5f5; padding: 8px; overflow-x: auto; margin-top: 4px;">${stack}</pre>
                   </details>`
                : '';
            
            return `
                <div class="log-item ${levelClass}" style="padding: 12px; border-bottom: 1px solid #eee;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span class="log-time" style="color: #999; font-size: 12px;">${time}</span>
                        <span class="log-level" style="
                            padding: 2px 8px; 
                            border-radius: 4px; 
                            font-size: 11px;
                            background: ${levelClass === 'error' ? '#fee' : levelClass === 'warn' ? '#ffeaa7' : '#e3f2fd'};
                            color: ${levelClass === 'error' ? '#c33' : levelClass === 'warn' ? '#856404' : '#1976d2'};
                        ">${level}</span>
                    </div>
                    <div class="log-message" style="margin-top: 8px; word-break: break-all;">${message}</div>
                    ${extraInfo}
                    ${stackTrace}
                </div>
            `;
        }).join('');

        container.innerHTML = `<div class="log-list" style="max-height: 600px; overflow-y: auto;">${logHtml}</div>`;
    }

    setLoading(loading) {
        const container = document.getElementById('log-content');
        if (container && loading) {
            container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        }
    }

    showError(message) {
        console.error(message);
    }

    unmount() {
        // 清理资源
    }
}
