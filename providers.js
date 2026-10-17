/** Only these fixed official endpoints can receive credentials. */
export const PROVIDERS = Object.freeze({
    openrouter: { name: 'OpenRouter', short: 'OR', label: '账户余额', transport: 'direct', url: 'https://openrouter.ai/api/v1/credits' },
    commandcode: { name: 'Command Code', short: 'CC', label: 'GOAT 订阅', transport: 'direct', url: 'https://api.commandcode.ai/alpha/billing/credits', subscriptionUrl: 'https://api.commandcode.ai/alpha/billing/subscriptions' },
    opencodeGo: { name: 'OpenCode Go', short: 'GO', label: '订阅用量', transport: 'proxy', url: 'https://opencode.ai/zen/go/v1/usage' },
});

export class UsageError extends Error {
    constructor(message, code = 'request') {
        super(message);
        this.name = 'UsageError';
        this.code = code;
    }
}

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function resetTime(value) {
    if (typeof value === 'number') return value > 0 && Number.isFinite(new Date(value).getTime()) ? value : null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) && time > 0 ? time : null;
}

const remainingPercent = (used, cap) => cap > 0 ? Math.max(0, Math.min(100, (cap - used) / cap * 100)) : null;

export function normalizeOpenRouter(payload) {
    const total = number(payload?.data?.total_credits);
    const used = number(payload?.data?.total_usage);
    if (total === null || used === null) throw new UsageError('余额响应缺少有效的充值或用量字段。', 'schema');
    return { kind: 'balance', balance: total - used, total, used, windows: [], warnings: [] };
}

export function normalizeCommandCode(payload, subscriptionPayload = null) {
    const credits = payload?.credits;
    if (!credits || typeof credits !== 'object') throw new UsageError('额度响应格式发生变化，未找到 credits。', 'schema');
    const limits = payload.windowLimits;
    const windows = [['fiveHour', '5 小时'], ['weekly', '每周']].map(([id, label]) => {
        const window = limits?.[id];
        const used = number(window?.used);
        const cap = number(window?.cap);
        const available = used !== null && cap !== null && cap > 0 && limits?.limited !== false;
        return {
            id, label, unit: 'credits', used, cap,
            remaining: available ? Math.max(0, cap - used) : null,
            percent: available ? (window.exceeded === true ? 0 : remainingPercent(used, cap)) : null,
            resetAt: resetTime(window?.resetAt),
            exceeded: window?.exceeded === true,
        };
    });
    const sub = subscriptionPayload?.success === false ? null : subscriptionPayload?.data;
    const monthly = number(credits.monthlyCredits);
    if (monthly === null && !windows.some(w => w.remaining !== null)) throw new UsageError('额度响应没有可用的余额或周期用量。', 'schema');
    // The monthly cap is not in this API. Never infer it from a hardcoded plan price.
    windows.push({ id: 'monthly', label: '本账期', unit: 'credits', remaining: monthly, percent: null, cap: null, resetAt: resetTime(sub?.currentPeriodEnd), periodEnd: true });
    return {
        kind: 'quota', windows,
        purchased: number(credits.purchasedCredits), free: number(credits.freeCredits),
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd === true,
        warnings: sub ? [] : ['账期信息暂不可用，周期额度仍可查看。'],
    };
}

export function normalizeOpenCode(payload) {
    if (!payload?.usage || typeof payload.usage !== 'object') throw new UsageError('用量响应格式发生变化，未找到 usage。', 'schema');
    const windows = [['rolling', '5 小时'], ['weekly', '每周'], ['monthly', '每月']].map(([id, label]) => {
        const window = payload.usage[id];
        const used = number(window?.percent);
        if (used === null) return { id, label, percent: null, remaining: null, unit: 'percent', resetAt: null };
        const exceeded = window.status === 'rate-limited';
        const percent = exceeded ? 0 : Math.max(0, Math.min(100, 100 - used));
        return { id, label, percent, remaining: percent, unit: 'percent', resetAt: resetTime(window.resetsAt), exceeded };
    });
    if (windows.every(w => w.remaining === null)) throw new UsageError('响应中没有有效的周期百分比。', 'schema');
    return { kind: 'quota', windows, warnings: [] };
}

export function httpError(status, proxy = false, retryAfter = null) {
    if (status === 401) return new UsageError(proxy ? '认证失败：检查 API Key；若酒馆启用了 Basic Auth，也可能被酒馆认证拦截。' : '认证失败，请检查 API Key 是否有效。', 'auth');
    if (status === 403) return new UsageError('当前 Key 或账户没有查询权限，请检查订阅与密钥权限。', 'permission');
    if (status === 404 && proxy) return new UsageError('酒馆代理不可用。请在 config.yaml 设置 enableCorsProxy: true，并重启酒馆。', 'proxy-disabled');
    if (status === 404) return new UsageError('查询接口不存在，服务地址可能发生变化。', 'not-found');
    if (status === 429) return new UsageError(`请求过于频繁，请稍后刷新${retryAfter ? '（服务端要求等待）' : ''}。`, 'rate-limit');
    return new UsageError(`查询失败（HTTP ${status}），请稍后重试。`, 'http');
}

export async function queryProvider(id, key, transport, options = {}) {
    const provider = PROVIDERS[id];
    if (!provider) throw new UsageError('未知服务。', 'config');
    if (!key?.trim()) throw new UsageError('请先填写 API Key。', 'config');
    const proxy = transport === 'proxy';
    const fetcher = options.fetchImpl || globalThis.fetch;
    async function request(url) {
        // Never use SillyTavern's CSRF headers or cookies for a direct cross-origin fetch.
        const headers = { Accept: 'application/json', Authorization: `Bearer ${key.trim()}` };
        if (proxy) {
            const hostHeaders = options.getRequestHeaders?.() || {};
            for (const [name, value] of Object.entries(hostHeaders)) {
                if (name.toLowerCase() === 'x-csrf-token') headers[name] = value;
            }
        }
        let response;
        try {
            response = await fetcher(proxy ? `/proxy/${url}` : url, {
                method: 'GET', headers, credentials: proxy ? 'same-origin' : 'omit',
                signal: options.signal, redirect: 'error', cache: 'no-store',
            });
        } catch (error) {
            if (options.signal?.aborted) throw error;
            throw new UsageError(proxy ? '无法连接酒馆代理，请检查酒馆网络连接。' : '网络或跨域请求失败。请检查当前设备联网情况，或改用酒馆代理。', 'network');
        }
        if (!response.ok) throw httpError(response.status, proxy, response.headers.get('retry-after'));
        try { return await response.json(); }
        catch { throw new UsageError('接口没有返回有效 JSON，可能被登录页面或网络验证页面拦截。', 'schema'); }
    }
    if (id === 'openrouter') return normalizeOpenRouter(await request(provider.url));
    if (id === 'opencodeGo') return normalizeOpenCode(await request(provider.url));
    const [credits, subscription] = await Promise.allSettled([request(provider.url), request(provider.subscriptionUrl)]);
    if (credits.status === 'rejected') throw credits.reason;
    // An aborted query must not update the page with partially completed data.
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return normalizeCommandCode(credits.value, subscription.status === 'fulfilled' ? subscription.value : null);
}
