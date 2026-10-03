/**
 * 解析 V8 --prof 采样日志，给出「谁在烧 CPU」的真实排名。
 *
 * 为什么需要它：LoAF 只能给到「文件级」归因，而且会误导 ——
 * 实测酒馆的 lib.js 被 LoAF 归了 5616 ms，V8 采样里它只占 0.6%；
 * 真正的热点是某个扩展的 dist/index.js（14.1%）。
 *
 * 用法：node tools/v8-analyze.mjs <v8日志文件>
 * 日志用 tools/profile-page.sh 生成。
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('用法: node tools/v8-analyze.mjs <v8日志文件>');
    process.exit(1);
}
const lines = readFileSync(file, 'utf8').split('\n');

// ① 代码对象表：地址区间 → 名称。必须按事件顺序应用 code-move，
//    否则 GC 搬移过的对象会全部失配（实测未归属率会飙到 66%）。
const objects = new Map();
for (const line of lines) {
    if (line.startsWith('code-creation,')) {
        const p = line.split(',');
        const addr = parseInt(p[4], 16);
        const size = parseInt(p[5], 10);
        const name = p.slice(6).join(',').trim();
        if (Number.isFinite(addr) && Number.isFinite(size) && name) objects.set(addr, { size, name });
    } else if (line.startsWith('code-move,')) {
        const p = line.split(',');
        const from = parseInt(p[1], 16);
        const to = parseInt(p[2], 16);
        const entry = objects.get(from);
        if (entry) { objects.delete(from); objects.set(to, entry); }
    }
}
const ranges = [...objects.entries()]
    .map(([start, v]) => ({ start, end: start + v.size, name: v.name }))
    .sort((a, b) => a.start - b.start);
const starts = ranges.map((r) => r.start);

function lookup(pc) {
    let lo = 0, hi = starts.length - 1, best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= pc) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    for (let i = best; i >= 0 && i > best - 10; i--) {
        if (pc >= ranges[i].start && pc < ranges[i].end) return ranges[i].name;
    }
    return null;
}

// ② 把函数名归类到「来源文件」
function toSource(name) {
    const url = name.match(/https?:\/\/127\.0\.0\.1:\d+\/([^\s:]+?)(?::\d+:\d+)?(?:,|$)/);
    if (url) return url[1];
    if (/^\(\?|^\^|^\\|^\[|\\s\\S|\(\?[:=!]/.test(name)) return '（正则表达式）';
    if (/^(Load|Store|Keyed|String|Call|Find|Strict|Record|RegExp|Interpreter|Get|Set|Create|Array|Fast|Builtin|Deoptimization|BytecodeHandler|Construct|New|Instance|Has|Define|Allocate|Clone|Extend|Resume|Generator|Promise|Async)/.test(name)) return '（V8 运行时/IC/GC）';
    return '（其它）';
}

// ③ 统计
const bySource = new Map(), byFunc = new Map(), byRegex = new Map();
let ticks = 0, mapped = 0;
for (const line of lines) {
    if (!line.startsWith('tick,')) continue;
    ticks++;
    const name = lookup(parseInt(line.split(',')[1], 16));
    if (!name) continue;
    mapped++;
    const src = toSource(name);
    bySource.set(src, (bySource.get(src) || 0) + 1);
    const short = name.length > 96 ? name.slice(0, 96) + '…' : name;
    byFunc.set(short, (byFunc.get(short) || 0) + 1);
    if (src === '（正则表达式）') byRegex.set(short, (byRegex.get(short) || 0) + 1);
}

const pct = (n, d) => ((n / d) * 100).toFixed(2).padStart(6) + '%';
console.log(`  采样总数 ${ticks}（已归属 ${mapped}，${((mapped / ticks) * 100).toFixed(1)}%）\n`);
console.log('  ── 按来源文件 ──');
for (const [src, c] of [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`  ${String(c).padStart(6)}  ${pct(c, ticks)}  ${src.padEnd(52)} ${'█'.repeat(Math.round((c / ticks) * 45))}`);
}
console.log('\n  ── 最烧的函数（前 16）──');
for (const [n, c] of [...byFunc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) {
    console.log(`  ${String(c).padStart(6)}  ${pct(c, ticks)}  ${n}`);
}
if (byRegex.size) {
    console.log('\n  ── 最烧的正则（前 6）──');
    for (const [n, c] of [...byRegex.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
        console.log(`  ${String(c).padStart(6)}  ${pct(c, ticks)}  ${n}`);
    }
}
