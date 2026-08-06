/**
 * 系统配置页面组件
 */
import { api } from '../api.js';
import { store } from '../store.js';

export class ConfigPage {
    constructor() {
        this.container = document.getElementById('page-config');
    }

    async mount() {
        await this.loadData();
    }

    async loadData() {
        try {
            this.setLoading(true);
            
            // 加载系统配置
            const config = await api.getConfig();
            this.renderConfig(config);
        } catch (error) {
            console.error('加载系统配置失败:', error);
            this.showError('加载系统配置失败');
            this.renderConfig({});
        } finally {
            this.setLoading(false);
        }
    }

    renderConfig(config) {
        // 基本信息
        const basicEl = document.getElementById('config-basic');
        if (basicEl) {
            basicEl.innerHTML = `
                <div class="config-item">
                    <label>系统名称</label>
                    <span>QuantumPinnacle（量子巅）</span>
                </div>
                <div class="config-item">
                    <label>版本号</label>
                    <span>${config.app_version || '1.0.0'}</span>
                </div>
                <div class="config-item">
                    <label>运行环境</label>
                    <span>${config.environment || 'development'}</span>
                </div>
                <div class="config-item">
                    <label>启动时间</label>
                    <span>${config.start_time ? new Date().toLocaleString('zh-CN') : '-'}</span>
                </div>
            `;
        }

        // 数据库配置
        const dbEl = document.getElementById('config-database');
        if (dbEl) {
            const db = config.db || {};
            dbEl.innerHTML = `
                <div class="config-item">
                    <label>PostgreSQL</label>
                    <span class="status-badge ${db.postgres ? 'active' : 'inactive'}">
                        ${db.postgres ? '已连接' : '未连接'}
                    </span>
                </div>
                <div class="config-item">
                    <label>SQLite</label>
                    <span class="status-badge ${db.sqlite ? 'active' : 'inactive'}">
                        ${db.sqlite ? '已连接' : '未连接'}
                    </span>
                </div>
                <div class="config-item">
                    <label>DOI记录数</label>
                    <span>${(db.doi_count || 0).toLocaleString()}</span>
                </div>
                <div class="config-item">
                    <label>期刊论文数</label>
                    <span>${(db.journal_count || 0).toLocaleString()}</span>
                </div>
            `;
        }

        // 搜索配置
        const searchEl = document.getElementById('config-search');
        if (searchEl) {
            const search = config.search || {};
            searchEl.innerHTML = `
                <div class="config-item">
                    <label>GStack 图融合</label>
                    <span class="status-badge ${search.gstack ? 'active' : 'inactive'}">
                        ${search.gstack ? '已启用' : '未启用'}
                    </span>
                </div>
                <div class="config-item">
                    <label>GBrain 知识图谱</label>
                    <span class="status-badge ${search.gbrain ? 'active' : 'inactive'}">
                        ${search.gbrain ? '已启用' : '未启用'}
                    </span>
                </div>
                <div class="config-item">
                    <label>默认搜索渠道</label>
                    <span>${search.default_channel || 'database'}</span>
                </div>
                <div class="config-item">
                    <label>最大搜索结果</label>
                    <span>${search.max_results || '80'}</span>
                </div>
            `;
        }

        // 安全配置
        const securityEl = document.getElementById('config-security');
        if (securityEl) {
            const security = config.security || {};
            securityEl.innerHTML = `
                <div class="config-item">
                    <label>JWT认证</label>
                    <span class="status-badge ${security.jwt ? 'active' : 'inactive'}">${security.jwt ? '已启用' : '未启用'}</span>
                </div>
                <div class="config-item">
                    <label>Token有效期</label>
                    <span>${security.token_expiry || '24小时'}</span>
                </div>
                <div class="config-item">
                    <label>密码加密</label>
                    <span class="status-badge active">${security.password_hash || 'bcrypt'}</span>
                </div>
                <div class="config-item">
                    <label>API限流</label>
                    <span class="status-badge ${security.rate_limit ? 'active' : 'inactive'}">
                        ${security.rate_limit ? '已启用' : '未启用'}
                    </span>
                </div>
            `;
        }
    }

    setLoading(loading) {
        const sections = ['config-basic', 'config-database', 'config-search', 'config-security'];
        sections.forEach(id => {
            const el = document.getElementById(id);
            if (el && loading) {
                el.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
            }
        });
    }

    showError(message) {
        console.error(message);
    }

    unmount() {
        // 清理资源
    }
}
