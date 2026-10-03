/**
 * ST-Render-Profiler · 渲染体检
 * ---------------------------------------------------------------
 * 目的：用真实浏览器数据回答一个问题——
 *   「聊天变卡，是 JS 计算（markdown/净化/分词）造成的，
 *     还是浏览器样式计算 + 布局 + 绘制造成的？」
 *
 * 这决定了优化方向：
 *   · JS 占大头  → 可以用 Rust/WASM 加速（wasm 能替 JS 计算）
 *   · 样式/布局占大头 → Rust 完全帮不上，只能靠 content-visibility / 虚拟化
 *
 * 关键手段：Long Animation Frames (LoAF) API
 *   Chromium 123+ 提供 long-animation-frame 性能条目，能直接拆分每一帧里
 *   「脚本耗时」与「样式/布局耗时」，并给出脚本来源（哪个文件、哪个函数）。
 *   不支持时自动回退到 longtask + 帧间隔统计。
 *
 * 本扩展只做【测量】，不改动酒馆的任何行为，可随时禁用/删除。
 */

import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
// lib.js 是酒馆的库集合模块（webpack 打包 + ES 模块导出）。
// 业务代码 import { lodash, css, ... } from '../lib.js' 拿到的就是这里的同一份实例，
// 所以包住这些对象的方法，就能测到真实渲染路径上的调用 —— 而 LoAF 只能告诉我们
// 「代码在 lib.js 里」，那里面有 24 个库，靠猜是浪费时间。
// 用动态 import 而不是静态 import：静态导入一旦失败（路径变化、被拦截），
// 整个扩展模块都会加载不了 —— 测量工具不该有这种风险。失败时降级为只包
// window 上暴露的那几个库，功能少一点，但绝不会把面板搞没。
let STLib = {};
(async () => {
    try {
        STLib = await import('/lib.js');
    } catch (error) {
        console.warn('[ST-Render-Profiler] 无法导入 /lib.js，探针降级为只覆盖 window 上的库', error);
    }
})();
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_NAME = 'ST-Render-Profiler';
const CV_OFF_STYLE_ID = 'st-render-profiler-cv-off';
const CTX = getContext();

const defaultSettings = {
    includeScroll: true,
    includeToken: false,
    reloadBeforeMeasure: true,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- 库调用探针
//
// LoAF 只能告诉我们「哪个文件」，而 webpack 打出来的 lib.js 里全是 (anonymous)，
// 光看文件名分不清是 DOMPurify、Handlebars 还是 hljs —— 这三者的优化方向完全不同
// （前者要缓存结果，后者要减少调用）。所以这里把这些库函数包一层，
// 统计**真实渲染路径**上的调用次数与耗时，让数据直接说出是谁。
//
// 包装是幂等的；测量之外只多一次函数调用，对结果的影响远小于它要解释的那几千毫秒。
const probeStats = new Map();
let probesActive = false;
let probesInstalled = false;

function recordProbe(name, ms) {
    if (!probesActive) return;
    const cur = probeStats.get(name) || { calls: 0, totalMs: 0 };
    cur.calls += 1;
    cur.totalMs += ms;
    probeStats.set(name, cur);
}

function wrapMethod(target, key, name, { wrapResult = false } = {}) {
    const original = target?.[key];
    if (typeof original !== 'function') return false;
    target[key] = function (...args) {
        if (!probesActive) return original.apply(this, args);
        const t0 = performance.now();
        let result;
        try {
            result = original.apply(this, args);
        } finally {
            recordProbe(name, performance.now() - t0);
        }
        if (wrapResult && typeof result === 'function') {
            const inner = result;
            const wrapped = function (...innerArgs) {
                if (!probesActive) return inner.apply(this, innerArgs);
                const t1 = performance.now();
                try {
                    return inner.apply(this, innerArgs);
                } finally {
                    recordProbe(`${name} → 渲染`, performance.now() - t1);
                }
            };
            Object.assign(wrapped, inner);
            return wrapped;
        }
        return result;
    };
    return true;
}

    // 候选清单：覆盖 lib.js 里所有可能出现在「每条消息」路径上的库操作。
    // 每一项都是 [显示名, () => 承载对象, 方法名] —— 取对象用函数是为了容忍
    // 某些导出在某些版本里不存在（拿不到就跳过，不报错）。
const PROBE_TARGETS = [
        ['DOMPurify.sanitize', () => STLib.DOMPurify, 'sanitize'],
        ['css.parse（样式解析）', () => STLib.css, 'parse'],
        ['showdown.makeHtml', () => STLib.showdown?.Converter?.prototype, 'makeHtml'],
        ['lodash.cloneDeep', () => STLib.lodash, 'cloneDeep'],
        ['lodash.isEqual', () => STLib.lodash, 'isEqual'],
        ['lodash.merge', () => STLib.lodash, 'merge'],
        ['lodash.clone', () => STLib.lodash, 'clone'],
        ['lodash.get', () => STLib.lodash, 'get'],
        ['lodash.set', () => STLib.lodash, 'set'],
        ['lodash.debounce', () => STLib.lodash, 'debounce'],
        ['lodash.uniqBy', () => STLib.lodash, 'uniqBy'],
        ['lodash.sortBy', () => STLib.lodash, 'sortBy'],
        ['lodash.throttle', () => STLib.lodash, 'throttle'],
        ['sha256.array', () => STLib.sha256, 'array'],
        ['localforage.getItem', () => STLib.localforage, 'getItem'],
        ['localforage.setItem', () => STLib.localforage, 'setItem'],
        ['Fuse.search', () => STLib.Fuse?.prototype, 'search'],
        ['DiffMatchPatch.diff_main', () => STLib.DiffMatchPatch?.prototype, 'diff_main'],
        ['SVGInject', () => window, 'SVGInject'],
        ['hljs.highlightElement', () => window.hljs, 'highlightElement'],
        ['Handlebars.compile', () => window.Handlebars, 'compile'],
    ];

function installLibraryProbes() {
    if (probesInstalled) return true;

    const targets = PROBE_TARGETS;
    let installed = 0;
    for (const [name, getTarget, key] of targets) {
        try {
            if (wrapMethod(getTarget(), key, name)) installed += 1;
        } catch {
            // 某个库拿不到就跳过，不影响其它探针
        }
    }
    // 只有全部装上才算完成：动态 import 可能比首次安装晚一步就绪，
    // 未装全就安排一次重试，避免「探针静默少测几项」。
    probesInstalled = installed >= PROBE_TARGETS.length;
    if (!probesInstalled) {
        setTimeout(() => { probesInstalled = false; installLibraryProbes(); }, 1500);
    }
    return probesInstalled;
}

function startProbes() {
    // 探针只是附加观测，任何异常都不该影响测量本身，更不该影响酒馆
    try { installLibraryProbes(); } catch (error) { console.warn('[ST-Render-Profiler] 探针安装失败（已忽略）', error); }
    probeStats.clear();
    probesActive = true;
}

function stopProbes() {
    probesActive = false;
    return [...probeStats.entries()]
        .map(([name, v]) => ({
            name,
            calls: v.calls,
            totalMs: +v.totalMs.toFixed(1),
            perCallMs: +(v.totalMs / Math.max(1, v.calls)).toFixed(3),
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
}

/** 统计一棵子树里的元素节点数（含自身） */
function countNodes(root) {
    if (!root) return 0;
    let n = 1;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) n += 1;
    return n;
}

function domStats() {
    const chat = document.getElementById('chat');
    const messages = chat ? chat.querySelectorAll('.mes').length : 0;
    return {
        messages,
        chatNodes: chat ? countNodes(chat) : 0,
        documentNodes: countNodes(document.body),
    };
}

/**
 * 临时关闭 / 恢复「屏外楼层跳过渲染」。
 * 用于 A/B 对比：关掉它就能量化 content-visibility 到底省了多少。
 */
function setContentVisibilitySuppressed(suppress) {
    const existing = document.getElementById(CV_OFF_STYLE_ID);
    if (suppress) {
        if (existing) return;
        const style = document.createElement('style');
        style.id = CV_OFF_STYLE_ID;
        style.textContent = '.mes{content-visibility:visible !important;contain-intrinsic-size:none !important;}';
        document.head.append(style);
    } else {
        existing?.remove();
    }
}

/** 性能条目采集器：优先 LoAF，回退 longtask */
function createCollector() {
    const state = { loaf: [], longtask: [], supported: { loaf: false, longtask: false } };
    let loafObserver = null;
    let longtaskObserver = null;

    return {
        state,
        start() {
            try {
                loafObserver = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) state.loaf.push(entry);
                });
                loafObserver.observe({ type: 'long-animation-frame', buffered: false });
                state.supported.loaf = true;
            } catch {
                state.supported.loaf = false;
            }
            try {
                longtaskObserver = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        state.longtask.push({ start: entry.startTime, duration: entry.duration });
                    }
                });
                longtaskObserver.observe({ type: 'longtask', buffered: false });
                state.supported.longtask = true;
            } catch {
                state.supported.longtask = false;
            }
        },
        stop() {
            try { loafObserver?.disconnect(); } catch { /* noop */ }
            try { longtaskObserver?.disconnect(); } catch { /* noop */ }
        },
    };
}

/** 把 LoAF 条目汇总成「脚本 vs 样式布局」的占比 */
function summarizeLoaf(entries) {
    let frameTotal = 0;
    let scriptTotal = 0;
    let styleLayoutTotal = 0;
    let blockingTotal = 0;
    let forcedLayout = 0;
    const bySource = new Map();
    const byPosition = new Map();

    for (const entry of entries) {
        frameTotal += entry.duration || 0;
        blockingTotal += entry.blockingDuration || 0;
        if (entry.styleAndLayoutStart > 0) {
            styleLayoutTotal += Math.max(0, (entry.startTime + (entry.duration || 0)) - entry.styleAndLayoutStart);
        }
        for (const script of entry.scripts || []) {
            const dur = script.duration || 0;
            scriptTotal += dur;
            forcedLayout += script.forcedStyleAndLayoutDuration || 0;
            // 只显示文件名会分不清「酒馆自带的 lib.js」和「某个扩展打包出来的 lib.js」，
            // 这里保留末三级路径，便于直接看出归属。
            const url = String(script.sourceURL || '(inline)');
            const segs = url.split('/').filter(Boolean);
            const file = segs.length > 3 ? '…/' + segs.slice(-3).join('/') : (segs.join('/') || '(inline)');
            const fn = script.sourceFunctionName || '(anonymous)';
            const key = `${file} → ${fn}`;
            bySource.set(key, (bySource.get(key) || 0) + dur);
            // 记下字符偏移：压缩包里的代码只有靠它才能定位到具体模块
            if (typeof script.sourceCharPosition === 'number') {
                const list = byPosition.get(key) || [];
                list.push({ url, position: script.sourceCharPosition, ms: dur });
                byPosition.set(key, list);
            }
        }
    }

    const top = [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([name, ms]) => ({ name, ms: +ms.toFixed(1) }));

    const denom = scriptTotal + styleLayoutTotal;
    return {
        frames: entries.length,
        frameTotalMs: +frameTotal.toFixed(1),
        scriptMs: +scriptTotal.toFixed(1),
        styleLayoutMs: +styleLayoutTotal.toFixed(1),
        blockingMs: +blockingTotal.toFixed(1),
        forcedStyleAndLayoutMs: +forcedLayout.toFixed(1),
        scriptShare: denom > 0 ? +(scriptTotal / denom * 100).toFixed(1) : null,
        styleLayoutShare: denom > 0 ? +(styleLayoutTotal / denom * 100).toFixed(1) : null,
        topScripts: top,
        // 每个热点的「代码位置样本」，供后续解析成模块片段（异步补上）
        positionSamples: [...byPosition.entries()]
            .sort((a, b) => b[1].reduce((x, y) => x + y.ms, 0) - a[1].reduce((x, y) => x + y.ms, 0))
            .slice(0, 4)
            .map(([key, list]) => ({ key, samples: list.slice(0, 3) })),
    };
}

// ---------------------------------------------------------------- 压缩包定位
//
// 酒馆的 /lib.js 是 1.9MB 的 webpack 压缩包（没有 source map），
// 但 LoAF 会给出 sourceCharPosition —— 脚本内的字符偏移。
// webpack 压缩后每个模块仍有边界（形如 `,6893(e){`），
// 于是可以据此反查「这段代码属于哪个模块」，并把模块开头一段代码取出来 ——
// 比在 24 个库里挨个猜快得多。
const scriptCache = new Map();

function fetchScriptText(url) {
    if (!scriptCache.has(url)) {
        scriptCache.set(url, fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => ''));
    }
    return scriptCache.get(url);
}

async function describePosition(url, position) {
    if (!url || typeof position !== 'number' || position < 0) return null;
    const source = await fetchScriptText(url);
    if (!source) return null;
    const before = source.slice(0, position);
    const headerRe = /[,{;]\s*(\d{2,6})\s*[:(]/g;
    let last = null;
    let match;
    while ((match = headerRe.exec(before)) !== null) last = match;
    if (!last) return null;
    const snippet = source.slice(last.index, last.index + 180).replace(/\s+/g, ' ');
    return {
        moduleId: last[1],
        offsetInModule: position - last.index,
        snippet,
    };
}

/** 给报告里的热点补上「模块片段」，让压缩代码也能被认出来 */
async function enrichWithModuleHints(loafSummary) {
    const hints = [];
    for (const item of loafSummary.positionSamples || []) {
        for (const sample of item.samples) {
            try {
                const hint = await describePosition(sample.url, sample.position);
                if (hint) {
                    hints.push({ key: item.key, ms: +sample.ms.toFixed(1), ...hint });
                    break;
                }
            } catch { /* 单个样本解析失败不影响其它 */ }
        }
    }
    return hints;
}

/**
 * 渲染事件名（酒馆没有统一的 MESSAGE_RENDERED，
 * 而是把用户消息与角色消息分成两个事件）
 */
function renderEventNames() {
    return [
        CTX.eventTypes.USER_MESSAGE_RENDERED,
        CTX.eventTypes.CHARACTER_MESSAGE_RENDERED,
    ].filter(Boolean);
}

/** 重新加载聊天，并统计渲染过程 */
async function measureChatRender({ reload }) {
    const started = performance.now();
    let renderedCount = 0;
    let reloadMs = null;
    let chatLoadedMs = null;
    const events = renderEventNames();

    const onRendered = () => { renderedCount += 1; };
    const onChatLoaded = () => { chatLoadedMs = +(performance.now() - started).toFixed(1); };

    for (const name of events) {
        try { CTX.eventSource.on(name, onRendered); } catch { /* 单个事件不可用不影响其它测量 */ }
    }
    try { CTX.eventSource.on(CTX.eventTypes.CHAT_LOADED, onChatLoaded); } catch { /* noop */ }

    try {
        if (reload && typeof CTX.reloadCurrentChat === 'function') {
            const t = performance.now();
            await CTX.reloadCurrentChat();
            reloadMs = +(performance.now() - t).toFixed(1);
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] 重载聊天失败：`, err);
    }

    // 结束判据：CHAT_LOADED 已到达且随后 800ms 无新渲染；或连续 1200ms 无新渲染
    const deadline = performance.now() + 25_000;
    let lastChange = performance.now();
    let lastSeen = -1;
    while (performance.now() < deadline) {
        await sleep(200);
        const quietFor = performance.now() - lastChange;
        if (renderedCount !== lastSeen) {
            lastSeen = renderedCount;
            lastChange = performance.now();
        } else if ((chatLoadedMs !== null && quietFor > 800) || quietFor > 1200) {
            break;
        }
    }

    for (const name of events) {
        try { CTX.eventSource.removeListener(name, onRendered); } catch { /* noop */ }
    }
    try { CTX.eventSource.removeListener(CTX.eventTypes.CHAT_LOADED, onChatLoaded); } catch { /* noop */ }

    const totalMs = +(performance.now() - started).toFixed(1);
    return {
        totalMs,
        reloadMs,
        chatLoadedMs,
        renderedMessages: renderedCount,
        perMessageMs: renderedCount > 0 ? +(totalMs / renderedCount).toFixed(2) : null,
    };
}

/** 程序化来回滚动聊天区，采样真实帧间隔 */
async function measureScrollFps(durationMs = 3000) {
    const chat = document.getElementById('chat');
    if (!chat) return null;

    const frames = [];
    let running = true;
    let last = performance.now();
    let rafId = 0;

    const tick = (now) => {
        frames.push(now - last);
        last = now;
        if (running) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const started = performance.now();
    const maxScroll = Math.max(1, chat.scrollHeight - chat.clientHeight);
    const prevBehavior = chat.style.scrollBehavior;
    chat.style.scrollBehavior = 'auto';

    try {
        while (performance.now() - started < durationMs) {
            const p = (performance.now() - started) / durationMs;
            chat.scrollTop = maxScroll * (0.5 - 0.5 * Math.cos(p * Math.PI * 4));
            await sleep(16);
        }
    } finally {
        chat.style.scrollBehavior = prevBehavior;
        running = false;
        cancelAnimationFrame(rafId);
    }

    const deltas = frames.slice(1).filter((d) => d > 0 && d < 5000);
    if (!deltas.length) return null;

    const sum = deltas.reduce((a, b) => a + b, 0);
    const avg = sum / deltas.length;
    const sorted = [...deltas].sort((a, b) => a - b);

    return {
        sampleFrames: deltas.length,
        avgFps: +(1000 / avg).toFixed(1),
        medianFrameMs: +sorted[Math.floor(sorted.length / 2)].toFixed(1),
        p95FrameMs: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(1),
        worstFrameMs: +Math.max(...deltas).toFixed(1),
        droppedFrames: deltas.filter((d) => d > 33.4).length,
    };
}

/** 分词成本微基准（默认关闭，可能较慢） */
async function measureTokenCost(limit = 30) {
    if (typeof CTX.getTokenCountAsync !== 'function') return null;
    const chat = Array.isArray(CTX.chat) ? CTX.chat : [];
    const texts = chat.slice(-limit).map((m) => String(m.mes || '')).filter(Boolean);
    if (!texts.length) return null;

    const started = performance.now();
    for (const text of texts) {
        try { await CTX.getTokenCountAsync(text); } catch { /* 忽略单条失败 */ }
    }
    const totalMs = performance.now() - started;

    return {
        messages: texts.length,
        totalChars: texts.reduce((a, t) => a + t.length, 0),
        totalMs: +totalMs.toFixed(1),
        avgMs: +(totalMs / texts.length).toFixed(2),
    };
}

// ---------------------------------------------------------------- 发送路径测量

/**
 * 测量「发送一条消息」时的开销 —— 这才是随楼层数增长的那部分。
 *
 * 为什么单独测：重载聊天是「全部楼层重渲染」（一次性），
 * 而正常玩时只有新楼层渲染，真正随楼层增长的是**发送前的提示词组装**
 * （上下文拼接、世界书扫描、正则脚本、分词），它发生在酒馆内部，
 * 无法直接挂钩函数，但可以用事件把它切成几段分别计时。
 *
 * 事件顺序：
 *   GENERATE_BEFORE_COMBINE_PROMPTS → 组装上下文的起点
 *   GENERATE_AFTER_COMBINE_PROMPTS  → 上下文拼装完成（随楼层增长的那段）
 *   GENERATE_AFTER_DATA             → 请求数据就绪（宏/正则/分词多在这一段）
 *   GENERATION_STARTED / ENDED      → 请求发出 / 结束
 */
async function measureGenerationPath(timeoutMs = 180_000) {
    const E = CTX.eventTypes;
    const marks = {};
    const t0 = performance.now();
    const collector = createCollector();
    collector.start();

    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    const stamp = (key, after) => () => {
        if (marks[key] === undefined) marks[key] = +(performance.now() - t0).toFixed(1);
        after?.();
    };
    const handlers = [
        [E.GENERATE_BEFORE_COMBINE_PROMPTS, stamp('contextStart')],
        [E.GENERATE_AFTER_COMBINE_PROMPTS, stamp('contextDone')],
        [E.GENERATE_AFTER_DATA, stamp('requestReady')],
        [E.GENERATION_STARTED, stamp('generationStarted')],
        [E.GENERATION_ENDED, stamp('generationEnded', () => resolveDone())],
    ];
    for (const [ev, fn] of handlers) {
        try { CTX.eventSource.on(ev, fn); } catch { /* 单个事件不可用不影响其它 */ }
    }

    setStatus(`监听中：现在去发送任意一条消息（最多等 ${Math.round(timeoutMs / 1000)} 秒）…`);
    const finished = await Promise.race([
        done.then(() => true),
        sleep(timeoutMs).then(() => false),
    ]);

    for (const [ev, fn] of handlers) {
        try { CTX.eventSource.removeListener(ev, fn); } catch { /* noop */ }
    }
    await sleep(300);
    collector.stop();

    const span = (a, b) => (marks[a] !== undefined && marks[b] !== undefined)
        ? +(marks[b] - marks[a]).toFixed(1) : null;

    return {
        label: '发送路径测量',
        finished,
        marks,
        contextBuildMs: span('contextStart', 'contextDone'),      // ← 随楼层增长
        postProcessMs: span('contextDone', 'requestReady'),
        dispatchMs: span('requestReady', 'generationStarted'),
        generationMs: span('generationStarted', 'generationEnded'),
        totalMs: marks.generationEnded ?? null,
        loaf: summarizeLoaf(collector.state.loaf),
        longtask: {
            count: collector.state.longtask.length,
            totalMs: +collector.state.longtask.reduce((a, t) => a + t.duration, 0).toFixed(1),
        },
        supported: collector.state.supported,
        env: {
            ua: navigator.userAgent,
            viewport: `${window.innerWidth}×${window.innerHeight}`,
        },
    };
}

function formatGeneration(g) {
    const L = g.loaf;
    const lines = [];
    lines.push('── 发送路径测量 ──');
    if (!g.finished) {
        lines.push('  ⚠ 超时未捕获到完整生成流程（是否取消了发送？）');
    }
    lines.push(`  上下文组装    : ${g.contextBuildMs ?? 'n/a'} ms   ← 随楼层数增长的就是这一段`);
    lines.push(`  后处理(宏/正则/分词): ${g.postProcessMs ?? 'n/a'} ms`);
    lines.push(`  请求派发      : ${g.dispatchMs ?? 'n/a'} ms`);
    lines.push(`  等待模型返回  : ${g.generationMs ?? 'n/a'} ms   （这段时间在等 API，不是本地开销）`);
    lines.push(`  从点击到返回  : ${g.totalMs ?? 'n/a'} ms`);
    if (L.frames > 0) {
        lines.push(`  期间长帧      : ${L.frames} 个（总 ${L.frameTotalMs} ms，阻塞 ${L.blockingMs} ms）`);
        lines.push(`  脚本 ${L.scriptMs} ms (${L.scriptShare ?? '?'}%)   样式+布局 ${L.styleLayoutMs} ms (${L.styleLayoutShare ?? '?'}%)`);
        for (const t of (L.topScripts || []).slice(0, 6)) {
            lines.push(`      ${pad(t.ms + ' ms', 10)} ${t.name}`);
        }
    }
    lines.push('');
    return lines.join('\n');
}

/** 跑一整轮测量 */
async function runSession({ label, suppressContentVisibility, includeScroll, includeToken, reload }) {
    setStatus(`测量中：${label} …`);

    setContentVisibilitySuppressed(suppressContentVisibility);
    await sleep(400);

    const collector = createCollector();
    const domBefore = domStats();
    startProbes();
    collector.start();

    const render = await measureChatRender({ reload });
    const scroll = includeScroll ? await measureScrollFps(3000) : null;
    const token = includeToken ? await measureTokenCost(30) : null;

    await sleep(400);
    collector.stop();
    setContentVisibilitySuppressed(false);

    const probes = stopProbes();
    const loafSummary = summarizeLoaf(collector.state.loaf);
    let moduleHints = [];
    try { moduleHints = await enrichWithModuleHints(loafSummary); } catch { /* noop */ }
    const longtasks = collector.state.longtask;
    const longtaskSummary = {
        count: longtasks.length,
        totalMs: +longtasks.reduce((a, t) => a + t.duration, 0).toFixed(1),
        worstMs: longtasks.length ? +Math.max(...longtasks.map((t) => t.duration)).toFixed(1) : 0,
    };

    return {
        label,
        contentVisibility: suppressContentVisibility ? '关（全量渲染）' : '开（屏外跳过）',
        dom: domBefore,
        render,
        scroll,
        token,
        probes,
        probeTargets: PROBE_TARGETS.map(([name]) => name),
        loaf: summarizeLoaf(collector.state.loaf),
        longtask: longtaskSummary,
        supported: collector.state.supported,
        env: {
            ua: navigator.userAgent,
            dpr: window.devicePixelRatio,
            viewport: `${window.innerWidth}×${window.innerHeight}`,
            hardwareConcurrency: navigator.hardwareConcurrency,
        },
    };
}

// ---------------------------------------------------------------- 报告输出

function pad(text, width) {
    const s = String(text);
    const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
    return s + ' '.repeat(Math.max(0, width - w));
}

function formatSession(s) {
    const lines = [];
    const L = s.loaf;
    lines.push(`── ${s.label} ──`);
    lines.push(`  屏外跳过(content-visibility): ${s.contentVisibility}`);
    lines.push(`  楼层数        : ${s.dom.messages}      聊天区节点: ${s.dom.chatNodes}      全文档节点: ${s.dom.documentNodes}`);
    lines.push(`  整轮渲染      : ${s.render.totalMs} ms   重载: ${s.render.reloadMs ?? 'n/a'} ms   CHAT_LOADED: ${s.render.chatLoadedMs ?? 'n/a'} ms   触发渲染楼层: ${s.render.renderedMessages}   每层约: ${s.render.perMessageMs ?? 'n/a'} ms`);

    // 库调用探针：LoAF 只能给到文件名，lib.js 里全是 (anonymous)，
    // 这一段直接给出「谁被调了多少次、共花了多少毫秒」
    if (Array.isArray(s.moduleHints) && s.moduleHints.length) {
        lines.push('');
        lines.push('  压缩包定位（lib.js 里的模块片段）:');
        for (const hint of s.moduleHints) {
            lines.push(`    ${hint.key}  ${hint.ms} ms  → 模块 ${hint.moduleId}（+${hint.offsetInModule}）`);
            lines.push(`      ${hint.snippet.slice(0, 110)}`);
        }
    }

    if (Array.isArray(s.probes) && s.probes.length) {
        lines.push('');
        lines.push('  库调用探针（真实渲染路径）:');
        for (const probe of s.probes) {
            lines.push(`    ${pad(probe.name, 34)} ${pad(`${probe.calls} 次`, 10)} ${pad(`${probe.totalMs} ms`, 12)} 每次 ${probe.perCallMs} ms`);
        }
        const silent = (s.probeTargets || [])
            .filter((name) => !s.probes.some((probe) => probe.name === name));
        if (silent.length) {
            lines.push(`    未触发: ${silent.join('、')}（说明不是瓶颈）`);
        }
    }

    if (L.frames > 0) {
        lines.push(`  长帧数量      : ${L.frames} 个（总 ${L.frameTotalMs} ms，其中阻塞 ${L.blockingMs} ms）`);
        lines.push(`  脚本耗时      : ${L.scriptMs} ms   (${L.scriptShare ?? '?'}%)`);
        lines.push(`  样式+布局耗时 : ${L.styleLayoutMs} ms   (${L.styleLayoutShare ?? '?'}%)   ← 这部分 Rust 无法优化`);
        lines.push(`  其中强制重排  : ${L.forcedStyleAndLayoutMs} ms`);
        if (L.topScripts?.length) {
            lines.push('  脚本耗时归因 Top:');
            for (const t of L.topScripts.slice(0, 6)) {
                lines.push(`      ${pad(t.ms + ' ms', 10)} ${t.name}`);
            }
        }
    } else {
        lines.push('  长帧数量      : 0（本次未捕获到长帧；LoAF 支持: ' + (s.supported.loaf ? '是' : '否') + '）');
        lines.push('  长任务数量    : ' + s.longtask.count + '  总 ' + s.longtask.totalMs + ' ms  最长 ' + s.longtask.worstMs + ' ms');
    }

    if (s.scroll) {
        lines.push(`  滚动帧率      : 平均 ${s.scroll.avgFps} FPS   中位帧 ${s.scroll.medianFrameMs} ms   P95 ${s.scroll.p95FrameMs} ms   最差 ${s.scroll.worstFrameMs} ms   掉帧 ${s.scroll.droppedFrames}/${s.scroll.sampleFrames}`);
    }
    if (s.token) {
        lines.push(`  分词成本      : ${s.token.messages} 条 / ${s.token.totalChars} 字 → ${s.token.totalMs} ms（每条 ${s.token.avgMs} ms）`);
    }
    lines.push('');
    return lines.join('\n');
}

function verdict(sessions) {
    const withLoaf = sessions.find((s) => s.loaf.frames > 0 && s.loaf.scriptShare !== null);
    if (!withLoaf) {
        return '未捕获到长帧数据（可能本次渲染很快，或浏览器不支持 LoAF）。把楼层玩多一些再测一次。\n';
    }
    const script = withLoaf.loaf.scriptShare;
    const style = withLoaf.loaf.styleLayoutShare;
    const out = [];
    out.push(`结论：脚本 ${script}%  vs  样式+布局 ${style}%`);
    if (style >= 60) {
        out.push('→ 瓶颈在浏览器的样式计算/布局/绘制。Rust/WASM 帮不上，应走 content-visibility / 虚拟化路线。');
    } else if (script >= 60) {
        out.push('→ 瓶颈在 JS 计算。这里是 Rust/WASM 的用武之地，可以做 WASM 化加速。');
    } else {
        out.push('→ 两侧各占一半。先上 content-visibility（零成本），再看剩余脚本开销是否值得 WASM 化。');
    }
    return out.join('\n') + '\n';
}

function formatComparison(a, b) {
    const pick = (x, f) => (x ? f(x) : 'n/a');
    const lines = [];
    lines.push('══════ A/B 对比 ══════');
    lines.push(`                     ${pad('屏外跳过 关', 16)} ${pad('屏外跳过 开', 16)} 变化`);
    const row = (name, va, vb, unit = 'ms', lowerIsBetter = true) => {
        let delta = 'n/a';
        if (typeof va === 'number' && typeof vb === 'number' && va !== 0) {
            const pct = ((vb - va) / va) * 100;
            const good = lowerIsBetter ? pct < 0 : pct > 0;
            delta = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}% ${good ? '✓ 更好' : '✗ 更差'}`;
        }
        lines.push(`  ${pad(name, 18)} ${pad(va ?? 'n/a', 16)} ${pad(vb ?? 'n/a', 16)} ${delta}`);
    };
    row('整轮渲染', a?.render.totalMs, b?.render.totalMs);
    row('长帧总时长', a?.loaf.frameTotalMs, b?.loaf.frameTotalMs);
    row('脚本耗时', a?.loaf.scriptMs, b?.loaf.scriptMs);
    row('样式+布局耗时', a?.loaf.styleLayoutMs, b?.loaf.styleLayoutMs);
    row('滚动平均FPS', a?.scroll?.avgFps, b?.scroll?.avgFps, 'fps', false);
    row('滚动P95帧', a?.scroll?.p95FrameMs, b?.scroll?.p95FrameMs);
    row('掉帧数', a?.scroll?.droppedFrames, b?.scroll?.droppedFrames, 'frames');
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------- UI 绑定

function setStatus(text) {
    const el = document.getElementById('st-rp-status');
    if (el) el.textContent = text;
}

function appendOutput(text) {
    const el = document.getElementById('st-rp-output');
    if (el) {
        el.textContent += text;
        el.scrollTop = el.scrollHeight;
    }
}

function collectOptions() {
    return {
        includeScroll: document.getElementById('st-rp-scroll')?.checked ?? true,
        includeToken: document.getElementById('st-rp-token')?.checked ?? false,
        reload: document.getElementById('st-rp-reload')?.checked ?? true,
    };
}

let lastReport = '';
let busy = false;

async function withLock(fn) {
    if (busy) {
        setStatus('正在测量中，请等这一轮跑完。');
        return;
    }
    busy = true;
    try {
        await fn();
    } catch (err) {
        console.error(`[${MODULE_NAME}]`, err);
        setStatus('出错：' + (err?.message || err));
    } finally {
        busy = false;
    }
}

async function runGeneration() {
    const gen = await measureGenerationPath();
    const text = formatGeneration(gen) + verdict([gen]);
    lastReport = JSON.stringify({ version: 2, sessions: [gen] }, null, 2);
    appendOutput(text);
    setStatus(gen.finished ? '完成。' : '超时结束（可以再点一次）。');
}

async function runSingle() {
    const opts = collectOptions();
    const session = await runSession({ label: '当前设置测量', suppressContentVisibility: false, ...opts });
    const text = formatSession(session) + verdict([session]);
    lastReport = JSON.stringify({ version: 2, sessions: [session] }, null, 2);
    appendOutput(text);
    setStatus('完成。');
}

async function runAb() {
    const opts = collectOptions();
    const off = await runSession({ label: 'A：关闭屏外跳过', suppressContentVisibility: true, ...opts });
    document.getElementById('st-rp-output')?.replaceChildren();
    appendOutput(formatSession(off));
    const on = await runSession({ label: 'B：开启屏外跳过', suppressContentVisibility: false, ...opts });
    appendOutput(formatSession(on));
    appendOutput(formatComparison(off, on));
    appendOutput(verdict([off, on]));
    lastReport = JSON.stringify({ version: 1, sessions: [off, on] }, null, 2);
    setStatus('A/B 完成。点「复制报告」把结果发我，我据此决定 WASM 优化目标。');
}

async function copyReport() {
    if (!lastReport) {
        setStatus('还没有报告，先跑一次测量。');
        return;
    }
    try {
        await navigator.clipboard.writeText(lastReport);
        setStatus('报告（JSON）已复制到剪贴板，直接粘贴给我即可。');
    } catch (err) {
        setStatus('剪贴板被拒绝，请手动从下方文本框复制。');
        appendOutput('\n\n=== 原始 JSON ===\n' + lastReport + '\n');
    }
}

jQuery(async () => {
    try {
        extension_settings[MODULE_NAME] = Object.assign({}, defaultSettings, extension_settings[MODULE_NAME] || {});

        const html = await renderExtensionTemplateAsync('third-party/ST-Render-Profiler', 'settings');
        const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        container?.insertAdjacentHTML('beforeend', html);

        document.getElementById('st-rp-run')?.addEventListener('click', () => withLock(runSingle));
        document.getElementById('st-rp-gen')?.addEventListener('click', () => withLock(runGeneration));
        document.getElementById('st-rp-ab')?.addEventListener('click', () => withLock(runAb));
        document.getElementById('st-rp-copy')?.addEventListener('click', () => withLock(copyReport));
        document.getElementById('st-rp-clear')?.addEventListener('click', () => {
            const out = document.getElementById('st-rp-output');
            if (out) out.textContent = '';
            lastReport = '';
            setStatus('已清空。');
        });

        for (const [id, key] of [['st-rp-scroll', 'includeScroll'], ['st-rp-token', 'includeToken'], ['st-rp-reload', 'reloadBeforeMeasure']]) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.checked = !!extension_settings[MODULE_NAME][key];
            el.addEventListener('change', () => {
                extension_settings[MODULE_NAME][key] = el.checked;
                saveSettingsDebounced();
            });
        }

        console.log(`[${MODULE_NAME}] 已加载，LoAF 支持: ${'PerformanceObserver' in window}`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] 初始化失败：`, err);
    }
});
