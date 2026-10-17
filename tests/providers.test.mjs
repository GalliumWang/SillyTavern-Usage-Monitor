import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenRouter, normalizeCommandCode, normalizeOpenCode, queryProvider, resetTime, UsageError } from '../providers.js';
import { cleanSettings, importedKeys, countdown } from '../core.js';

const cc = {
    credits: { monthlyCredits: 64.25, purchasedCredits: 3, freeCredits: 0 },
    windowLimits: { limited: true, exceeded: null, fiveHour: { used: 0, cap: 14, resetAt: 0, exceeded: false }, weekly: { used: 5.75, cap: 35, resetAt: 1792342432274, exceeded: false } },
};
const oc = { usage: { rolling: { status: 'ok', percent: 3, resetsAt: '2026-10-18T04:00:00Z' }, weekly: { status: 'ok', percent: 25 }, monthly: { status: 'ok', percent: 12 } } };
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('OpenRouter: account balance is credits minus usage, not key budget', () => {
    assert.equal(normalizeOpenRouter({ data: { total_credits: 100, total_usage: 93.25 } }).balance, 6.75);
    assert.throws(() => normalizeOpenRouter({ data: { limit_remaining: 50 } }), UsageError);
    assert.throws(() => normalizeOpenRouter({ data: { total_credits: null, total_usage: 0 } }), UsageError);
});

test('Command Code: limited=true is a configured limit, not an exhausted account', () => {
    const result = normalizeCommandCode(cc, { success: true, data: { currentPeriodEnd: '2026-11-11T16:44:10Z', cancelAtPeriodEnd: true } });
    assert.equal(result.windows[0].remaining, 14);
    assert.equal(result.windows[0].percent, 100);
    assert.equal(result.windows[0].resetAt, null);
    assert.equal(result.windows[1].remaining, 29.25);
    assert.equal(result.windows[1].resetAt, 1792342432274);
    assert.equal(result.windows[2].remaining, 64.25);
    assert.equal(result.windows[2].cap, 70);
    assert.ok(Math.abs(result.windows[2].percent - 64.25 / 70 * 100) < 1e-10);
    assert.equal(result.windows[2].estimatedCap, true);
    assert.equal(result.cancelAtPeriodEnd, true);
});

test('Missing subscription is partial success and does not invent a monthly reset', () => {
    const result = normalizeCommandCode(cc);
    assert.equal(result.windows[2].remaining, 64.25);
    assert.equal(result.windows[2].resetAt, null);
    assert.equal(result.warnings.length, 1);
});

test('Missing window fields are unknown rather than zero or full allowance', () => {
    const result = normalizeCommandCode({ credits: { monthlyCredits: 10 }, windowLimits: { fiveHour: { used: null, cap: 14 } } });
    assert.equal(result.windows[0].remaining, null);
    assert.equal(result.windows[1].percent, null);
    assert.equal(result.windows[2].cap, null);
    assert.equal(result.windows[2].percent, null);
    assert.throws(() => normalizeCommandCode({ credits: {} }), UsageError);
});

test('Monthly allowance uses twice the weekly cap and clamps only the displayed percentage', () => {
    const payload = structuredClone(cc);
    payload.windowLimits.weekly.cap = 50;
    payload.windowLimits.weekly.used = 49;
    payload.credits.monthlyCredits = 80;
    assert.equal(normalizeCommandCode(payload).windows[2].cap, 100);
    assert.equal(normalizeCommandCode(payload).windows[2].percent, 80);
    payload.credits.monthlyCredits = 120;
    assert.equal(normalizeCommandCode(payload).windows[2].remaining, 120);
    assert.equal(normalizeCommandCode(payload).windows[2].percent, 100);
    payload.credits.monthlyCredits = -1;
    assert.equal(normalizeCommandCode(payload).windows[2].percent, 0);
    payload.credits.monthlyCredits = null;
    assert.equal(normalizeCommandCode(payload).windows[2].percent, null);
    for (const cap of [0, -1, null, '35', Number.MAX_VALUE]) {
        payload.windowLimits.weekly.cap = cap;
        assert.equal(normalizeCommandCode(payload).windows[2].cap, null);
    }
    payload.credits.monthlyCredits = 50;
    payload.windowLimits.weekly.cap = 35;
    payload.windowLimits.limited = false;
    assert.equal(normalizeCommandCode(payload).windows[2].cap, null);
});

test('OpenCode: percent means used, rate-limited status overrides rounded percentage', () => {
    assert.deepEqual(normalizeOpenCode(oc).windows.map(w => w.remaining), [97, 75, 88]);
    const exhausted = structuredClone(oc);
    exhausted.usage.rolling = { status: 'rate-limited', percent: 99 };
    assert.equal(normalizeOpenCode(exhausted).windows[0].remaining, 0);
    exhausted.usage.weekly.percent = 101;
    assert.equal(normalizeOpenCode(exhausted).windows[1].remaining, 0);
    assert.throws(() => normalizeOpenCode({ usage: {} }), UsageError);
});

test('Timestamp normalization never renders resetAt=0 as 1970', () => {
    assert.equal(resetTime(0), null);
    assert.equal(resetTime('not a date'), null);
    assert.equal(resetTime('0'), null);
    assert.equal(resetTime('2026-10-18T04:00:00Z'), Date.parse('2026-10-18T04:00:00Z'));
    assert.equal(countdown(1000, 2000), '已到期，等待更新');
    assert.equal(countdown(null), '暂无重置时间');
});

test('Direct requests omit cookies and SillyTavern CSRF headers', async () => {
    const requests = [];
    await queryProvider('openrouter', 'test-key', 'direct', {
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'private-csrf' }),
        fetchImpl: async (url, options) => { requests.push({ url, options }); return jsonResponse({ data: { total_credits: 100, total_usage: 10 } }); },
    });
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/credits');
    assert.equal(requests[0].options.credentials, 'omit');
    assert.deepEqual(Object.keys(requests[0].options.headers).sort(), ['Accept', 'Authorization']);
    assert.equal(requests[0].options.redirect, 'error');
});

test('Proxy uses only the local built-in route and retains required CSRF headers', async () => {
    let request;
    await queryProvider('opencodeGo', 'test-key', 'proxy', {
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf', Authorization: 'unrelated', Cookie: 'private' }),
        fetchImpl: async (url, options) => { request = { url, options }; return jsonResponse(oc); },
    });
    assert.equal(request.url, '/proxy/https://opencode.ai/zen/go/v1/usage');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.headers['X-CSRF-Token'], 'csrf');
    assert.equal(request.options.headers.Authorization, 'Bearer test-key');
    assert.equal(request.options.headers.Cookie, undefined);
});

test('Proxy-disabled HTML, network errors and upstream auth errors never echo a key', async () => {
    await assert.rejects(queryProvider('opencodeGo', 'private-test-key', 'proxy', { fetchImpl: async () => new Response('disabled', { status: 404 }) }), /enableCorsProxy/);
    await assert.rejects(queryProvider('openrouter', 'private-test-key', 'direct', { fetchImpl: async () => jsonResponse({ error: { message: 'private-test-key' } }, 401) }), error => error.code === 'auth' && !error.message.includes('private-test-key'));
    await assert.rejects(queryProvider('openrouter', 'private-test-key', 'direct', { fetchImpl: async () => { throw new Error('private-test-key'); } }), error => error.code === 'network' && !error.message.includes('private-test-key'));
});

test('Command Code returns credits if subscription lookup fails', async () => {
    const result = await queryProvider('commandcode', 'test-key', 'direct', { fetchImpl: async url => url.endsWith('/subscriptions') ? jsonResponse({}, 503) : jsonResponse(cc) });
    assert.equal(result.windows[2].remaining, 64.25);
    assert.equal(result.warnings.length, 1);
});

test('An aborted partial Command Code query cannot deliver a stale snapshot', async () => {
    const controller = new AbortController();
    await assert.rejects(queryProvider('commandcode', 'test-key', 'direct', {
        signal: controller.signal,
        fetchImpl: async url => { if (url.endsWith('/subscriptions')) { controller.abort(); throw new DOMException('abort', 'AbortError'); } return jsonResponse(cc); },
    }), error => error.name === 'AbortError');
});

test('API keys persist in settings only under the whitelisted keys object', () => {
    const safe = cleanSettings({
        apiKey: 'secret',
        keys: { openrouter: ' k1 ', commandcode: 'bad\nkey', opencodeGo: 123 },
        providers: { openrouter: { enabled: false, transport: 'evil', apiKey: 'secret' } },
    });
    assert.equal(safe.keys.openrouter, 'k1');
    assert.equal(safe.keys.commandcode, '');
    assert.equal(safe.keys.opencodeGo, '');
    assert.equal(JSON.stringify(safe).includes('secret'), false);
    assert.equal(safe.providers.openrouter.transport, 'direct');
    assert.equal(safe.providers.openrouter.enabled, false);
    assert.equal(cleanSettings({ refreshSeconds: 1 }).refreshSeconds, 60);
    assert.equal(cleanSettings(null).refreshSeconds, 60);
});

test('Saved keys survive a settings round-trip and unknown key fields are dropped', () => {
    const once = cleanSettings({ keys: { openrouter: 'k1', unknown: 'x' } });
    assert.deepEqual(cleanSettings(once).keys, { openrouter: 'k1', commandcode: '', opencodeGo: '' });
});

test('Import accepts the agreed local config and validates malformed input', () => {
    assert.deepEqual(importedKeys({ openrouter: { apiKey: ' sample ' }, commandcode: { apiKey: '' } }), { openrouter: 'sample' });
    assert.throws(() => importedKeys({ openrouter: { apiKey: 'bad\nkey' } }));
    assert.throws(() => importedKeys([]));
    assert.throws(() => importedKeys({}));
});
