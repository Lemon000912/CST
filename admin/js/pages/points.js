import { api } from '../api.js';

const PAGE_SIZE = 10;

export class PointsPage {
    constructor() {
        this.currentPage = 1;
        this.total = 0;
        this.users = [];
        this.searchQuery = '';
        this.status = '';
        this.ledgerUserId = '';
        this.ledgerUsername = '';
        this.selectedUser = null;
        this.searchTimer = null;
        this.listeners = [];
    }

    async mount() {
        this.bindEvents();
        await Promise.all([this.loadUsers(), this.loadLedger()]);
    }

    listen(element, event, handler) {
        if (!element) return;
        element.addEventListener(event, handler);
        this.listeners.push(() => element.removeEventListener(event, handler));
    }

    bindEvents() {
        const byId = (id) => document.getElementById(id);
        this.listen(byId('points-search'), 'input', (event) => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => {
                this.searchQuery = event.target.value.trim();
                this.currentPage = 1;
                this.loadUsers();
            }, 300);
        });
        this.listen(byId('points-status-filter'), 'change', (event) => {
            this.status = event.target.value;
            this.currentPage = 1;
            this.loadUsers();
        });
        this.listen(byId('points-prev'), 'click', () => {
            if (this.currentPage > 1) {
                this.currentPage -= 1;
                this.loadUsers();
            }
        });
        this.listen(byId('points-next'), 'click', () => {
            if (this.currentPage < this.totalPages) {
                this.currentPage += 1;
                this.loadUsers();
            }
        });
        this.listen(byId('points-refresh'), 'click', async () => {
            await Promise.all([this.loadUsers(), this.loadLedger()]);
            this.showToast('积分数据已刷新');
        });
        this.listen(byId('points-users-body'), 'click', (event) => {
            const adjustButton = event.target.closest('[data-points-adjust]');
            const ledgerButton = event.target.closest('[data-points-ledger]');
            if (adjustButton) this.openAdjustModal(adjustButton.dataset.pointsAdjust);
            if (ledgerButton) this.showUserLedger(ledgerButton.dataset.pointsLedger);
        });
        this.listen(byId('points-ledger-clear'), 'click', () => {
            this.ledgerUserId = '';
            this.ledgerUsername = '';
            this.loadLedger();
        });
        this.listen(byId('points-modal-close'), 'click', () => this.closeAdjustModal());
        this.listen(byId('points-modal-cancel'), 'click', () => this.closeAdjustModal());
        this.listen(byId('points-adjust-modal'), 'click', (event) => {
            if (event.target.id === 'points-adjust-modal') this.closeAdjustModal();
        });
        this.listen(byId('points-mode-switch'), 'click', (event) => {
            const button = event.target.closest('[data-mode]');
            if (!button) return;
            byId('points-adjust-mode').value = button.dataset.mode;
            byId('points-mode-switch').querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
            const amountInput = byId('points-adjust-amount');
            amountInput.min = button.dataset.mode === 'set' ? '0' : '0.05';
            this.updatePreview();
        });
        this.listen(byId('points-quick-values'), 'click', (event) => {
            const button = event.target.closest('[data-value]');
            if (!button) return;
            byId('points-adjust-amount').value = button.dataset.value;
            this.updatePreview();
        });
        this.listen(byId('points-adjust-amount'), 'input', () => this.updatePreview());
        this.listen(byId('points-adjust-form'), 'submit', (event) => this.submitAdjustment(event));
    }

    get totalPages() {
        return Math.max(1, Math.ceil(this.total / PAGE_SIZE));
    }

    async loadUsers() {
        const body = document.getElementById('points-users-body');
        if (body) body.innerHTML = '<tr><td colspan="6" class="loading"><div class="spinner"></div></td></tr>';
        try {
            const data = await api.getPointUsers({
                skip: (this.currentPage - 1) * PAGE_SIZE,
                limit: PAGE_SIZE,
                search: this.searchQuery,
                status: this.status
            });
            this.users = data.users || [];
            this.total = Number(data.total || 0);
            if (this.currentPage > this.totalPages) {
                this.currentPage = this.totalPages;
                return this.loadUsers();
            }
            this.renderSummary(data.summary || {});
            this.renderUsers();
            this.renderPagination();
        } catch (error) {
            if (body) body.innerHTML = `<tr><td colspan="6" class="points-empty"><i class="fas fa-circle-exclamation"></i><span>${this.escapeHtml(error.message || '加载积分账户失败')}</span></td></tr>`;
        }
    }

    renderSummary(summary) {
        document.getElementById('points-total-balance').textContent = this.formatPoints(summary.totalBalance);
        document.getElementById('points-today-credit').textContent = `+${this.formatPoints(summary.todayCredited)}`;
        document.getElementById('points-today-debit').textContent = `-${this.formatPoints(summary.todayDebited)}`;
        document.getElementById('points-attention-count').textContent = Number(summary.attentionCount || 0).toLocaleString('zh-CN');
    }

    renderUsers() {
        const body = document.getElementById('points-users-body');
        if (!body) return;
        document.getElementById('points-user-count').textContent = `${this.total.toLocaleString('zh-CN')} 个账户`;
        if (!this.users.length) {
            body.innerHTML = '<tr><td colspan="6" class="points-empty"><i class="fas fa-inbox"></i><span>没有找到符合条件的积分账户</span></td></tr>';
            return;
        }
        body.innerHTML = this.users.map((user) => {
            const balanceNumber = Number(user.balance || 0);
            const balanceClass = balanceNumber <= 0 ? 'empty' : balanceNumber <= 100 ? 'low' : 'healthy';
            return `<tr>
                <td><div class="points-user-cell"><span class="points-avatar small">${this.escapeHtml(this.initial(user.username))}</span><div><strong>${this.escapeHtml(user.username)}</strong><small>ID: ${this.escapeHtml(user.id)}</small></div></div></td>
                <td><span class="points-balance ${balanceClass}">${this.formatPoints(user.balance)}</span></td>
                <td class="points-credit-text">+${this.formatPoints(user.credited)}</td>
                <td class="points-debit-text">-${this.formatPoints(user.debited)}</td>
                <td><span class="points-date">${this.formatDate(user.lastChangedAt)}</span></td>
                <td><div class="points-actions"><button type="button" data-points-adjust="${this.escapeHtml(user.id)}" class="points-adjust-button"><i class="fas fa-sliders"></i> 调整</button><button type="button" data-points-ledger="${this.escapeHtml(user.id)}" class="points-ledger-button" title="查看该用户流水"><i class="fas fa-clock-rotate-left"></i></button></div></td>
            </tr>`;
        }).join('');
    }

    renderPagination() {
        document.getElementById('points-page-info').textContent = `第 ${this.currentPage} 页 / 共 ${this.totalPages} 页`;
        document.getElementById('points-prev').disabled = this.currentPage <= 1;
        document.getElementById('points-next').disabled = this.currentPage >= this.totalPages;
    }

    async showUserLedger(userId) {
        const user = this.users.find((item) => item.id === userId);
        this.ledgerUserId = userId;
        this.ledgerUsername = user?.username || userId;
        await this.loadLedger();
    }

    async loadLedger() {
        const list = document.getElementById('points-ledger-list');
        if (!list) return;
        list.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        const subtitle = document.getElementById('points-ledger-subtitle');
        const clearButton = document.getElementById('points-ledger-clear');
        subtitle.textContent = this.ledgerUserId ? `${this.ledgerUsername} 的最近变动` : '展示全平台最近变动';
        clearButton.hidden = !this.ledgerUserId;
        try {
            const data = await api.getPointLedger({ userId: this.ledgerUserId, limit: 20 });
            this.renderLedger(data.entries || []);
        } catch (error) {
            list.innerHTML = `<div class="points-empty"><i class="fas fa-circle-exclamation"></i><span>${this.escapeHtml(error.message || '加载积分流水失败')}</span></div>`;
        }
    }

    renderLedger(entries) {
        const list = document.getElementById('points-ledger-list');
        if (!entries.length) {
            list.innerHTML = '<div class="points-empty"><i class="fas fa-receipt"></i><span>暂无积分流水</span></div>';
            return;
        }
        list.innerHTML = entries.map((entry) => {
            const positive = Number(entry.deltaUnits) > 0;
            return `<article class="points-ledger-item">
                <div class="points-ledger-dot ${positive ? 'positive' : 'negative'}"><i class="fas ${positive ? 'fa-plus' : 'fa-minus'}"></i></div>
                <div class="points-ledger-main"><div><strong>${this.escapeHtml(entry.username)}</strong><span class="points-ledger-amount ${positive ? 'positive' : 'negative'}">${positive ? '+' : ''}${this.formatPoints(entry.delta)}</span></div><p>${this.escapeHtml(entry.reason)}</p><small>${this.formatDate(entry.createdAt)} · ${this.escapeHtml(entry.operator)}</small></div>
            </article>`;
        }).join('');
    }

    openAdjustModal(userId) {
        const user = this.users.find((item) => item.id === userId);
        if (!user) return;
        this.selectedUser = user;
        const byId = (id) => document.getElementById(id);
        byId('points-adjust-user-id').value = user.id;
        byId('points-adjust-username').textContent = user.username;
        byId('points-adjust-user-code').textContent = `用户 ID：${user.id}`;
        byId('points-adjust-avatar').textContent = this.initial(user.username);
        byId('points-adjust-current').textContent = this.formatPoints(user.balance);
        byId('points-adjust-amount').value = '';
        byId('points-adjust-reason').value = '';
        byId('points-adjust-error').textContent = '';
        byId('points-adjust-mode').value = 'add';
        byId('points-mode-switch').querySelectorAll('button').forEach((button) => button.classList.toggle('active', button.dataset.mode === 'add'));
        this.updatePreview();
        byId('points-adjust-modal').classList.add('active');
        setTimeout(() => byId('points-adjust-amount').focus(), 50);
    }

    closeAdjustModal() {
        document.getElementById('points-adjust-modal')?.classList.remove('active');
        this.selectedUser = null;
    }

    updatePreview() {
        const preview = document.querySelector('#points-adjust-preview strong');
        if (!preview || !this.selectedUser) return;
        const amount = Number(document.getElementById('points-adjust-amount').value);
        const current = Number(this.selectedUser.balance || 0);
        const mode = document.getElementById('points-adjust-mode').value;
        if (!Number.isFinite(amount)) {
            preview.textContent = '--';
            preview.className = '';
            return;
        }
        const next = mode === 'add' ? current + amount : mode === 'deduct' ? current - amount : amount;
        preview.textContent = this.formatPoints(next);
        preview.className = next < 0 ? 'negative' : '';
    }

    async submitAdjustment(event) {
        event.preventDefault();
        if (!this.selectedUser) return;
        const submit = document.getElementById('points-adjust-submit');
        const errorBox = document.getElementById('points-adjust-error');
        const mode = document.getElementById('points-adjust-mode').value;
        const amount = document.getElementById('points-adjust-amount').value.trim();
        const reason = document.getElementById('points-adjust-reason').value.trim();
        errorBox.textContent = '';
        submit.disabled = true;
        submit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在处理';
        try {
            const idempotencyKey = globalThis.crypto?.randomUUID?.() || `points-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const data = await api.adjustUserPoints({ userId: this.selectedUser.id, mode, amount, reason, idempotencyKey });
            const actionText = mode === 'add' ? '增加' : mode === 'deduct' ? '扣减' : '设定';
            this.closeAdjustModal();
            this.showToast(`已为 ${data.user.username} ${actionText}积分，当前余额 ${this.formatPoints(data.entry.balanceAfter)}`);
            await Promise.all([this.loadUsers(), this.loadLedger()]);
        } catch (error) {
            errorBox.textContent = error.message || '积分调整失败，请稍后重试';
        } finally {
            submit.disabled = false;
            submit.innerHTML = '<i class="fas fa-check"></i> 确认调整';
        }
    }

    showToast(message) {
        document.querySelector('.points-toast')?.remove();
        const toast = document.createElement('div');
        toast.className = 'points-toast';
        toast.innerHTML = `<i class="fas fa-circle-check"></i><span>${this.escapeHtml(message)}</span>`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 250);
        }, 2800);
    }

    formatPoints(value) {
        const number = Number(value || 0);
        return Number.isFinite(number) ? number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00';
    }

    formatDate(value) {
        if (!value) return '暂无变动';
        const date = new Date(Number(value));
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    initial(value) {
        return String(value || 'U').trim().charAt(0).toUpperCase();
    }

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
    }

    unmount() {
        clearTimeout(this.searchTimer);
        this.listeners.forEach((remove) => remove());
        this.listeners = [];
        this.closeAdjustModal();
    }
}
