import { PROVIDERS, UsageError, queryProvider } from './providers.js';
import { SETTINGS_KEY, cleanSettings, importedKeys, countdown, formatDate, amount } from './core.js';

const ids = Object.keys(PROVIDERS);
const state = Object.fromEntries(ids.map(id => [id, { key: '', snapshot: null, error: '', updatedAt: null, busy: false, failures: 0, nextAutoAt: 0, revision: 0, controller: null }]));
let settings;
let dialog;
let timer;
let hostContext;
const cards = {};

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label, className, handler) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
}

function persist() {
    settings = cleanSettings(settings);
    hostContext.extensionSettings[SETTINGS_KEY] = structuredClone(settings);
    hostContext.saveSettingsDebounced();
}

function banner(text) {
    const node = dialog.querySelector('[data-banner]');
    node.textContent = text;
    node.hidden = !text;
}

function invalidate(id) {
    const item = state[id];
    item.revision++;
    item.controller?.abort();
    Object.assign(item, { snapshot: null, error: '', updatedAt: null, busy: false, failures: 0, nextAutoAt: 0, controller: null });
}

function setKey(id, value) {
    if (state[id].key === value.trim()) return;
    invalidate(id);
    state[id].key = value.trim();
    renderCard(id);
}

function buildCard(id) {
    const provider = PROVIDERS[id];
    const card = element('article', 'tum-card');
    card.dataset.provider = id;
    const header = element('div', 'tum-card-header');
    const brand = element('div', 'tum-brand', provider.short);
    brand.dataset.brand = id;
    const names = element('div', 'tum-provider-name');
    names.append(element('h3', '', provider.name), element('span', 'tum-muted', provider.label));
    const status = element('span', 'tum-status', '未配置');
    header.append(brand, names, status);
    const body = element('div', 'tum-card-body');
    const feedback = element('div', 'tum-card-feedback');
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    const footer = element('footer', 'tum-card-footer');
    const freshness = element('span', 'tum-freshness', '尚未查询');
    const refresh = button('刷新', 'tum-button tum-button-small', () => refreshProvider(id));
    refresh.setAttribute('aria-label', `刷新 ${provider.name}`);
    footer.append(freshness, refresh);
    card.append(header, body, feedback, footer);
    cards[id] = { card, body, status, feedback, refresh, freshness };
    return card;
}

function renderWindow(window) {
    const row = element('div', 'tum-window');
    const top = element('div', 'tum-window-title');
    top.append(element('span', '', window.label));
    let summary = '未知';
    if (window.remaining !== null) {
        summary = window.unit === 'percent'
            ? `${amount(window.remaining, 0)}%`
            : `${amount(window.remaining)}${window.cap !== null ? ` / ${amount(window.cap)}` : ''}`;
    }
    const value = element('strong', 'tum-window-value', summary);
    if (window.unit === 'credits' && window.remaining !== null) value.append(element('small', '', ' credits'));
    top.append(value);
    row.append(top);
    if (window.percent !== null) {
        const track = element('div', 'tum-track');
        const fill = element('div', 'tum-fill');
        fill.style.width = `${window.percent}%`;
        track.dataset.level = window.percent <= 10 ? 'low' : window.percent <= 30 ? 'medium' : 'normal';
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-label', `${window.label}剩余`);
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuenow', String(Math.round(window.percent)));
        track.append(fill);
        row.append(track);
    }
    const reset = element('div', 'tum-reset');
    if (window.resetAt) {
        const relative = element('span', '', countdown(window.resetAt));
        relative.dataset.resetAt = String(window.resetAt);
        const absolute = element('time', '', `${window.periodEnd ? '本期结束' : '重置'} ${formatDate(window.resetAt)}`);
        absolute.dateTime = new Date(window.resetAt).toISOString();
        reset.append(relative, absolute);
    } else reset.append(element('span', '', window.periodEnd ? '账期结束时间未知' : '暂无重置时间'));
    row.append(reset);
    return row;
}

function renderCard(id) {
    const item = state[id];
    const ui = cards[id];
    if (!ui) return;
    const enabled = settings.providers[id].enabled;
    ui.card.dataset.disabled = String(!enabled);
    ui.card.dataset.stale = String(Boolean(item.error && item.snapshot));
    ui.card.setAttribute('aria-busy', String(item.busy));
    ui.status.textContent = !enabled ? '已停用' : item.busy ? '查询中' : item.error ? (item.snapshot ? '旧数据' : '查询失败') : item.snapshot ? '已更新' : item.key ? '待查询' : '未配置';
    ui.status.dataset.state = !enabled ? 'idle' : item.error ? 'error' : item.snapshot ? 'ok' : 'idle';
    ui.refresh.disabled = !enabled || !item.key || item.busy;
    ui.refresh.textContent = item.busy ? '查询中…' : '刷新';
    ui.freshness.textContent = item.updatedAt ? `最近成功 ${formatDate(item.updatedAt)}` : '尚未查询';
    ui.body.replaceChildren();
    ui.feedback.replaceChildren();
    if (!item.snapshot) {
        const empty = element('div', 'tum-empty');
        empty.append(element('span', 'tum-empty-number', '—'), element('p', '', !enabled ? '启用后可查看余额与用量' : item.key ? '点击刷新，获取当前账户数据' : '展开下方配置，填写或导入 API Key'));
        ui.body.append(empty);
    } else if (item.snapshot.kind === 'balance') {
        const balance = element('div', 'tum-balance');
        balance.append(element('span', 'tum-muted', '可用余额 · USD'), element('strong', '', `$${amount(item.snapshot.balance)}`));
        const detail = element('div', 'tum-balance-detail');
        detail.append(element('span', '', `累计充值 $${amount(item.snapshot.total)}`), element('span', '', `累计使用 $${amount(item.snapshot.used)}`));
        balance.append(detail);
        ui.body.append(balance);
    } else {
        ui.body.append(element('p', 'tum-remaining-label', '剩余用量'));
        for (const window of item.snapshot.windows) ui.body.append(renderWindow(window));
        if (item.snapshot.purchased > 0 || item.snapshot.free > 0) {
            ui.body.append(element('p', 'tum-extra', `额外额度 ${amount((item.snapshot.purchased || 0) + (item.snapshot.free || 0))} credits · 与订阅额度分开计算`));
        }
        if (item.snapshot.cancelAtPeriodEnd) ui.body.append(element('p', 'tum-note', '已设置期末取消，账期结束不代表自动续期。'));
    }
    if (item.error) ui.feedback.append(element('p', 'tum-error', `${item.error}${item.snapshot ? ' 当前保留上次成功结果。' : ''}`));
    for (const warning of item.snapshot?.warnings || []) ui.feedback.append(element('p', 'tum-note', warning));
}

async function refreshProvider(id) {
    const item = state[id];
    if (!settings.providers[id].enabled || !item.key || item.busy || !dialog.open) return;
    const revision = item.revision;
    const controller = new AbortController();
    item.controller = controller;
    item.busy = true;
    item.error = '';
    const timeout = setTimeout(() => controller.abort('timeout'), 25000);
    renderCard(id);
    try {
        const snapshot = await queryProvider(id, item.key, settings.providers[id].transport, {
            signal: controller.signal,
            getRequestHeaders: () => hostContext.getRequestHeaders?.() || {},
        });
        if (item.revision !== revision || controller.signal.aborted) return;
        item.snapshot = snapshot;
        item.updatedAt = Date.now();
        item.failures = 0;
    } catch (error) {
        if (item.revision !== revision || !dialog.open) return;
        item.failures++;
        item.error = controller.signal.reason === 'timeout' ? '查询超时，请稍后重试。'
            : error instanceof UsageError ? error.message : '查询中断，请重新刷新。';
    } finally {
        clearTimeout(timeout);
        if (item.revision === revision) {
            item.busy = false;
            item.controller = null;
            item.nextAutoAt = Date.now() + Math.min(300, settings.refreshSeconds * (2 ** item.failures)) * 1000;
            renderCard(id);
        }
    }
}

function refreshAll() {
    return Promise.allSettled(ids.map(refreshProvider));
}

function tick() {
    if (!dialog.open || document.hidden) return;
    for (const node of dialog.querySelectorAll('[data-reset-at]')) node.textContent = countdown(Number(node.dataset.resetAt));
    if (settings.autoRefresh) {
        for (const id of ids) if (Date.now() >= state[id].nextAutoAt) void refreshProvider(id);
    }
}

function configureSection() {
    const details = element('details', 'tum-config');
    details.append(element('summary', '', '账户与连接配置'));
    const intro = element('div', 'tum-config-intro');
    intro.append(element('p', '', '密钥仅保留在当前页面内存中；刷新页面后需重新填写或导入。显示偏好会保存在酒馆设置中。'));
    const importButton = button('导入本地配置', 'tum-button', () => file.click());
    const file = element('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    file.setAttribute('aria-label', '导入密钥 JSON 配置');
    file.addEventListener('change', async () => {
        const selected = file.files?.[0];
        if (!selected) return;
        try {
            if (selected.size > 65536) throw new Error('配置文件不能超过 64 KB。');
            const keys = importedKeys(JSON.parse(await selected.text()));
            for (const [id, key] of Object.entries(keys)) {
                setKey(id, key);
                dialog.querySelector(`[data-key="${id}"]`).value = key;
            }
            banner(`已导入 ${Object.keys(keys).length} 个服务的密钥，点击“全部刷新”查询。`);
        } catch { banner('导入失败：请检查 JSON 格式，文件中需包含 openrouter / commandcode / opencodeGo 下的 apiKey。'); }
        finally { file.value = ''; }
    });
    const clear = button('清除全部密钥', 'tum-button tum-button-quiet', () => {
        for (const id of ids) {
            setKey(id, '');
            dialog.querySelector(`[data-key="${id}"]`).value = '';
        }
        banner('已清除当前页面中的密钥与查询结果。');
    });
    const actions = element('div', 'tum-config-actions');
    actions.append(importButton, clear, file);
    intro.append(actions);
    details.append(intro);
    for (const id of ids) {
        const provider = PROVIDERS[id];
        const row = element('div', 'tum-config-row');
        const enableLabel = element('label', 'tum-enable-label');
        const enabled = element('input');
        enabled.type = 'checkbox';
        enabled.checked = settings.providers[id].enabled;
        enabled.dataset.enable = id;
        enabled.addEventListener('change', () => {
            invalidate(id);
            settings.providers[id].enabled = enabled.checked;
            persist(); renderCard(id);
        });
        enableLabel.append(enabled, element('strong', '', provider.name));
        const keyLabel = element('label', 'tum-field');
        keyLabel.append(element('span', '', 'API Key'));
        const key = element('input', 'tum-input');
        key.type = 'password';
        key.autocomplete = 'off';
        key.spellcheck = false;
        key.placeholder = '粘贴查询 Key';
        key.dataset.key = id;
        key.setAttribute('aria-label', `${provider.name} API Key`);
        key.addEventListener('input', () => setKey(id, key.value));
        keyLabel.append(key);
        const modeLabel = element('label', 'tum-field');
        modeLabel.append(element('span', '', '请求方式'));
        const mode = element('select', 'tum-input');
        mode.setAttribute('aria-label', `${provider.name} 请求方式`);
        for (const [value, label] of [['direct', '浏览器直连'], ['proxy', '酒馆内置代理']]) {
            const option = element('option', '', label); option.value = value; mode.append(option);
        }
        mode.value = settings.providers[id].transport;
        mode.addEventListener('change', () => {
            invalidate(id); settings.providers[id].transport = mode.value;
            persist(); renderCard(id);
        });
        modeLabel.append(mode);
        row.append(enableLabel, keyLabel, modeLabel);
        details.append(row);
    }
    const note = element('div', 'tum-proxy-help');
    note.append(element('strong', '', 'OpenCode Go 默认使用酒馆代理'), element('p', '', '在酒馆 config.yaml 中设置 enableCorsProxy: true，然后重启酒馆。前端扩展本身无法修改此配置，也不需要安装服务端插件。'));
    note.append(element('p', '', '直连使用当前浏览器设备的网络；代理使用酒馆服务器的网络。所有查询仅访问三家官方地址，不经过第三方代理。'));
    details.append(note);
    return details;
}

function buildDialog() {
    dialog = element('dialog');
    dialog.id = 'tum-dialog';
    dialog.setAttribute('aria-labelledby', 'tum-title');
    const shell = element('div', 'tum-shell');
    const header = element('header', 'tum-header');
    const titleGroup = element('div');
    titleGroup.append(element('div', 'tum-eyebrow', 'USAGE MONITOR'));
    const title = element('h2', '', '余额与订阅用量');
    title.id = 'tum-title';
    titleGroup.append(title, element('p', 'tum-subtitle', '三个服务，一处查看。'));
    const close = button('×', 'tum-close', () => dialog.close());
    close.setAttribute('aria-label', '关闭用量面板');
    header.append(titleGroup, close);
    const toolbar = element('div', 'tum-toolbar');
    const autoLabel = element('label', 'tum-auto-label');
    const auto = element('input');
    auto.type = 'checkbox'; auto.checked = settings.autoRefresh;
    auto.setAttribute('aria-label', '自动刷新');
    auto.addEventListener('change', () => { settings.autoRefresh = auto.checked; persist(); });
    autoLabel.append(auto, element('span', '', '自动刷新'));
    const interval = element('select', 'tum-input tum-interval');
    interval.setAttribute('aria-label', '自动刷新间隔');
    for (const [value, label] of [[60, '每 1 分钟'], [120, '每 2 分钟'], [300, '每 5 分钟']]) {
        const option = element('option', '', label); option.value = String(value); interval.append(option);
    }
    interval.value = String(settings.refreshSeconds);
    interval.addEventListener('change', () => { settings.refreshSeconds = Number(interval.value); persist(); });
    const refresh = button('全部刷新 ↻', 'tum-button tum-button-primary', () => { banner(''); void refreshAll(); });
    toolbar.append(autoLabel, interval, refresh);
    const notice = element('div', 'tum-banner'); notice.dataset.banner = ''; notice.hidden = true;
    notice.setAttribute('role', 'status');
    const grid = element('div', 'tum-grid');
    for (const id of ids) grid.append(buildCard(id));
    const footnote = element('p', 'tum-footnote', '进度条表示剩余用量 · 时间使用当前设备时区 · 额度以服务端返回为准');
    shell.append(header, toolbar, notice, grid, footnote, configureSection());
    dialog.append(shell);
    dialog.addEventListener('close', () => {
        clearInterval(timer);
        for (const item of Object.values(state)) {
            item.revision++; item.controller?.abort(); item.controller = null; item.busy = false;
        }
    });
    document.body.append(dialog);
    for (const id of ids) renderCard(id);
}

function openPanel() {
    if (!dialog) buildDialog();
    if (dialog.open) return;
    for (const id of ids) renderCard(id);
    dialog.showModal();
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    void refreshAll();
}

function init() {
    if (document.getElementById('tum-launcher')) return;
    hostContext = globalThis.SillyTavern?.getContext?.();
    if (!hostContext?.extensionSettings || !hostContext?.saveSettingsDebounced) {
        console.warn('[Usage Monitor] SillyTavern context is unavailable; extension was not mounted.');
        return;
    }
    settings = cleanSettings(hostContext.extensionSettings[SETTINGS_KEY]);
    const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (target) {
        const launcher = element('div', 'tum-launcher');
        launcher.id = 'tum-launcher';
        launcher.append(element('strong', '', '余额与订阅用量'), element('p', '', 'OpenRouter · Command Code · OpenCode Go'));
        launcher.append(button('打开用量面板', 'menu_button tum-launch-button', openPanel));
        target.append(launcher);
    }
    const menu = document.querySelector('#extensionsMenu');
    if (menu) {
        const entry = element('div', 'list-group-item flex-container flexGap5 interactable');
        entry.id = 'tum-menu-entry'; entry.tabIndex = 0; entry.setAttribute('role', 'button');
        entry.append(element('i', 'fa-solid fa-wallet'), element('span', '', '余额与用量'));
        entry.addEventListener('click', openPanel);
        entry.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPanel(); } });
        menu.append(entry);
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
