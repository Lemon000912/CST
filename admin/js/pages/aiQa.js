import { api } from '../api.js';

export class AiQaPage {
    constructor() {
        this.currentPage = 1;
        this.pageSize = 20;
        this.total = 0;
        this.records = [];
        this.searchQuery = '';
        this.status = '';
        this.from = '';
        this.to = '';
        this.searchTimer = null;
        this.listeners = [];
    }

    async mount() {
        this.bindEvents();
        await this.loadRecords();
    }

    listen(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this.listeners.push(() => element.removeEventListener(event, handler));
    }

    bindEvents() {
        const byId = (id) => document.getElementById(id);
        this.listen(byId('ai-qa-search'), 'input', (event) => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => {
                this.searchQuery = event.target.value.trim();
                this.currentPage = 1;
                this.loadRecords();
            }, 300);
        });
        this.listen(byId('ai-qa-status'), 'change', (event) => {
            this.status = event.target.value;
            this.currentPage = 1;
            this.loadRecords();
        });
        this.listen(byId('ai-qa-from'), 'change', (event) => {
            this.from = event.target.value;
            this.currentPage = 1;
            this.loadRecords();
        });
        this.listen(byId('ai-qa-to'), 'change', (event) => {
            this.to = event.target.value;
            this.currentPage = 1;
            this.loadRecords();
        });
        this.listen(byId('ai-qa-page-size'), 'change', (event) => {
            this.pageSize = Number(event.target.value) || 20;
            this.currentPage = 1;
            this.loadRecords();
        });
        this.listen(byId('ai-qa-prev'), 'click', () => {
            if (this.currentPage <= 1) return;
            this.currentPage -= 1;
            this.loadRecords();
        });
        this.listen(byId('ai-qa-next'), 'click', () => {
            if (this.currentPage >= this.totalPages) return;
            this.currentPage += 1;
            this.loadRecords();
        });
        this.listen(byId('ai-qa-refresh'), 'click', () => this.loadRecords());
        this.listen(byId('ai-qa-reset'), 'click', () => this.resetFilters());
        this.listen(byId('ai-qa-export'), 'click', () => this.exportCsv());
        this.listen(byId('ai-qa-table-body'), 'click', (event) => {
            const button = event.target.closest('[data-ai-qa-detail]');
            if (button) this.openDetail(button.dataset.aiQaDetail);
        });
        this.listen(byId('ai-qa-modal-close'), 'click', () => this.closeDetail());
        this.listen(byId('ai-qa-modal-done'), 'click', () => this.closeDetail());
        this.listen(byId('ai-qa-detail-modal'), 'click', (event) => {
            if (event.target.id === 'ai-qa-detail-modal') this.closeDetail();
        });
    }

    get totalPages() {
        return Math.max(1, Math.ceil(this.total / this.pageSize));
    }

    filterParams() {
        const params = {};
        if (this.searchQuery) params.search = this.searchQuery;
        if (this.status) params.status = this.status;
        if (this.from) params.from = new Date(`${this.from}T00:00:00`).getTime();
        if (this.to) params.to = new Date(`${this.to}T23:59:59.999`).getTime();
        return params;
    }

    async loadRecords() {
        const body = document.getElementById('ai-qa-table-body');
        if (body) body.innerHTML = '<tr><td colspan="6" class="loading"><div class="spinner"></div></td></tr>';
        try {
            const data = await api.getAiQaRecords({
                ...this.filterParams(),
                skip: (this.currentPage - 1) * this.pageSize,
                limit: this.pageSize
            });
            this.records = data.records || [];
            this.total = Number(data.total || 0);
            if (this.currentPage > this.totalPages) {
                this.currentPage = this.totalPages;
                return this.loadRecords();
            }
            this.renderRecords();
            this.renderPagination();
        } catch (error) {
            if (body) body.innerHTML = `<tr><td colspan="6" class="ai-qa-empty"><i class="fas fa-circle-exclamation"></i><span>${this.escapeHtml(error.message || '加载问答记录失败')}</span></td></tr>`;
        }
    }

    renderRecords() {
        const body = document.getElementById('ai-qa-table-body');
        const count = document.getElementById('ai-qa-count');
        if (count) count.textContent = `${this.total.toLocaleString('zh-CN')} 条记录`;
        if (!body) return;
        if (!this.records.length) {
            body.innerHTML = '<tr><td colspan="6" class="ai-qa-empty"><i class="fas fa-inbox"></i><span>没有符合条件的问答记录</span></td></tr>';
            return;
        }
        body.innerHTML = this.records.map((record) => `<tr>
            <td><div class="ai-qa-user"><strong>${this.escapeHtml(record.username)}</strong><small>${this.escapeHtml(record.userId)}</small></div></td>
            <td><button type="button" class="ai-qa-question" data-ai-qa-detail="${this.escapeHtml(record.operationId)}">${this.escapeHtml(record.question || '（无文本问题）')}</button><small class="ai-qa-operation">${this.escapeHtml(record.operationId)}</small></td>
            <td><span class="ai-qa-status ${record.status}">${record.status === 'stopped' ? '已停止' : '成功'}</span></td>
            <td><strong class="ai-qa-cost">-${this.formatPoints(record.cost)}</strong></td>
            <td><span class="ai-qa-date">${this.formatDate(record.completedAt)}</span></td>
            <td><button type="button" class="ai-qa-detail-button" data-ai-qa-detail="${this.escapeHtml(record.operationId)}" title="查看详情"><i class="fas fa-eye"></i></button></td>
        </tr>`).join('');
    }

    renderPagination() {
        const start = this.total ? (this.currentPage - 1) * this.pageSize + 1 : 0;
        const end = Math.min(this.total, this.currentPage * this.pageSize);
        document.getElementById('ai-qa-page-info').textContent = `${start}-${end} / ${this.total.toLocaleString('zh-CN')}`;
        document.getElementById('ai-qa-prev').disabled = this.currentPage <= 1;
        document.getElementById('ai-qa-next').disabled = this.currentPage >= this.totalPages;
    }

    resetFilters() {
        this.searchQuery = '';
        this.status = '';
        this.from = '';
        this.to = '';
        this.currentPage = 1;
        document.getElementById('ai-qa-search').value = '';
        document.getElementById('ai-qa-status').value = '';
        document.getElementById('ai-qa-from').value = '';
        document.getElementById('ai-qa-to').value = '';
        this.loadRecords();
    }

    async openDetail(operationId) {
        const modal = document.getElementById('ai-qa-detail-modal');
        const content = document.getElementById('ai-qa-detail-content');
        modal?.classList.add('active');
        if (content) content.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        try {
            const record = await api.getAiQaRecord(operationId);
            if (!content) return;
            const contacts = [record.email, record.phone].filter(Boolean).map(this.escapeHtml).join(' · ') || '未填写联系方式';
            content.innerHTML = `
                <div class="ai-qa-detail-grid">
                    <div><span>用户</span><strong>${this.escapeHtml(record.username)}</strong><small>${this.escapeHtml(record.userId)}</small></div>
                    <div><span>请求状态</span><strong>${record.status === 'stopped' ? '已停止' : '成功'}</strong><small>${contacts}</small></div>
                    <div><span>消耗积分</span><strong>${this.formatPoints(record.cost)}</strong><small>余额 ${record.balanceAfter == null ? '-' : this.formatPoints(record.balanceAfter)}</small></div>
                    <div><span>完成时间</span><strong>${this.formatDate(record.completedAt)}</strong><small>${this.escapeHtml(record.channel || '-')} · ${this.escapeHtml(record.edition || '-')}</small></div>
                </div>
                <section class="ai-qa-detail-section"><h4>用户问题</h4><pre>${this.escapeHtml(record.question || '（无文本问题）')}</pre></section>
                <section class="ai-qa-detail-section"><h4>AI 回答</h4><pre>${this.escapeHtml(record.answer || '（无普通回答）')}</pre></section>
                ${record.deepAnswer ? `<section class="ai-qa-detail-section"><h4>深度研究回答</h4><pre>${this.escapeHtml(record.deepAnswer)}</pre></section>` : ''}
                <div class="ai-qa-trace"><div><span>计费操作 ID</span><code>${this.escapeHtml(record.operationId)}</code></div><div><span>积分流水 ID</span><code>${this.escapeHtml(record.ledgerId || '-')}</code></div></div>`;
        } catch (error) {
            if (content) content.innerHTML = `<div class="ai-qa-empty"><i class="fas fa-circle-exclamation"></i><span>${this.escapeHtml(error.message || '加载详情失败')}</span></div>`;
        }
    }

    closeDetail() {
        document.getElementById('ai-qa-detail-modal')?.classList.remove('active');
    }

    async exportCsv() {
        const button = document.getElementById('ai-qa-export');
        const original = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 导出中';
        try {
            const blob = await api.downloadAiQaCsv(this.filterParams());
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `ai-qa-records-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            window.alert(error.message || '导出失败');
        } finally {
            button.disabled = false;
            button.innerHTML = original;
        }
    }

    formatPoints(value) {
        const number = Number(value || 0);
        return Number.isFinite(number) ? number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
    }

    formatDate(value) {
        if (!value) return '-';
        const date = new Date(Number(value));
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
    }

    unmount() {
        clearTimeout(this.searchTimer);
        this.listeners.forEach((remove) => remove());
        this.listeners = [];
        this.closeDetail();
    }
}
