export const SETTINGS_KEY = 'usageMonitor';
export const DEFAULT_SETTINGS = Object.freeze({
    autoRefresh: false,
    refreshSeconds: 60,
    providers: {
        openrouter: { enabled: true, transport: 'direct' },
        commandcode: { enabled: true, transport: 'direct' },
        opencodeGo: { enabled: true, transport: 'proxy' },
    },
});

export function cleanSettings(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    const result = structuredClone(DEFAULT_SETTINGS);
    result.autoRefresh = input.autoRefresh === true;
    if ([60, 120, 300].includes(input.refreshSeconds)) result.refreshSeconds = input.refreshSeconds;
    for (const id of Object.keys(result.providers)) {
        const saved = input.providers?.[id];
        if (typeof saved?.enabled === 'boolean') result.providers[id].enabled = saved.enabled;
        if (['direct', 'proxy'].includes(saved?.transport)) result.providers[id].transport = saved.transport;
    }
    // Only whitelisted preferences are returned; API keys never enter extension settings.
    return result;
}

export function importedKeys(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置必须是 JSON 对象。');
    const result = {};
    for (const id of Object.keys(DEFAULT_SETTINGS.providers)) {
        const key = input[id]?.apiKey;
        if (typeof key === 'string' && key.trim()) {
            if (key.length > 8192 || /[\r\n\0]/.test(key)) throw new Error('Key 格式无效。');
            result[id] = key.trim();
        }
    }
    if (!Object.keys(result).length) throw new Error('没有找到有效的 apiKey；请检查配置格式。');
    return result;
}

export function countdown(resetAt, now = Date.now()) {
    if (!resetAt) return '暂无重置时间';
    const seconds = Math.ceil((resetAt - now) / 1000);
    if (seconds <= 0) return '已到期，等待更新';
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟后`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return `${hours} 小时${rest ? ` ${rest} 分钟` : ''}后`;
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后`;
}

export function formatDate(value) {
    if (!value) return '暂无有效时间';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
}

export function amount(value, digits = 4) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits }) : '—';
}
