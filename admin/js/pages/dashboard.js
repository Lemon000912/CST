/**
 * 仪表盘页面组件
 */
import { api } from '../api.js';
import { store } from '../store.js';

export class DashboardPage {
    constructor() {
        this.container = document.getElementById('page-dashboard');
        this.charts = {};
    }

    async mount() {
        await this.loadData();
    }

    async loadData() {
        try {
            this.setLoading(true);
            const data = await api.getDashboard();
            
            // 更新统计数据
            this.updateStats(data);
            
            // 更新图表
            this.renderSearchTrend(data.weekly_trend);
            this.renderPaperSource(data.papers);
            
            // 保存到store
            store.updateStats(data);
        } catch (error) {
            console.error('加载仪表盘数据失败:', error);
            this.showError('加载数据失败');
        } finally {
            this.setLoading(false);
        }
    }

    setLoading(loading) {
        const stats = ['stat-users', 'stat-active', 'stat-papers', 'stat-searches'];
        stats.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = loading ? '-' : el.textContent;
            }
        });
    }

    updateStats(stats) {
        const usersEl = document.getElementById('stat-users');
        const activeEl = document.getElementById('stat-active');
        const papersEl = document.getElementById('stat-papers');
        const searchesEl = document.getElementById('stat-searches');

        if (usersEl) usersEl.textContent = stats.users?.total || 0;
        if (activeEl) activeEl.textContent = stats.users?.active || 0;
        if (papersEl) papersEl.textContent = (stats.papers?.total || 0).toLocaleString();
        if (searchesEl) searchesEl.textContent = stats.today_searches || 0;
    }

    renderSearchTrend(trendData) {
        const loading = document.getElementById('trend-loading');
        const canvas = document.getElementById('trendCanvas');
        
        if (!trendData || trendData.length === 0) {
            if (loading) loading.innerHTML = '<p style="text-align: center; color: #999;">暂无数据</p>';
            return;
        }
        
        if (loading) loading.style.display = 'none';
        if (canvas) canvas.style.display = 'block';
        
        const ctx = canvas.getContext('2d');
        const labels = trendData.map(d => d.date);
        const values = trendData.map(d => d.count);
        
        const width = canvas.width = canvas.offsetWidth || 400;
        const height = canvas.height = canvas.offsetHeight || 200;
        const padding = 40;
        const barWidth = (width - padding * 2) / labels.length - 10;
        const maxValue = Math.max(...values, 1);
        
        ctx.clearRect(0, 0, width, height);
        
        // 绘制坐标轴
        ctx.strokeStyle = '#ddd';
        ctx.beginPath();
        ctx.moveTo(padding, padding);
        ctx.lineTo(padding, height - padding);
        ctx.lineTo(width - padding, height - padding);
        ctx.stroke();
        
        // 绘制柱状图
        values.forEach((value, index) => {
            const x = padding + index * (barWidth + 10) + 5;
            const barHeight = (value / maxValue) * (height - padding * 2);
            const y = height - padding - barHeight;
            
            ctx.fillStyle = '#4a90e2';
            ctx.fillRect(x, y, barWidth, barHeight);
            
            // 数值标签
            ctx.fillStyle = '#333';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(value.toString(), x + barWidth / 2, y - 5);
            
            // 日期标签
            ctx.save();
            ctx.translate(x + barWidth / 2, height - padding + 15);
            ctx.rotate(-Math.PI / 4);
            ctx.fillText(labels[index], 0, 0);
            ctx.restore();
        });
    }

    renderPaperSource(paperStats) {
        const loading = document.getElementById('source-loading');
        const info = document.getElementById('source-info');

        if (!paperStats) {
            if (loading) loading.innerHTML = '<p style="text-align: center; color: #999;">暂无数据</p>';
            return;
        }

        if (loading) loading.style.display = 'none';
        if (info) info.style.display = 'block';

        const doiEl = document.getElementById('source-doi');
        const journalEl = document.getElementById('source-journal');

        if (doiEl) doiEl.textContent = paperStats.doi_count || 0;
        if (journalEl) journalEl.textContent = paperStats.journal_papers || 0;
    }

    showError(message) {
        // 可以在这里添加错误提示UI
        console.error(message);
    }

    unmount() {
        // 清理资源
    }
}
