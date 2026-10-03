/**
 * 解析 CDP 采集的 CPU profile，输出「自耗时」排名（按函数、按文件两种视角）。
 * 用法：node tools/analyze-cdp-profile.mjs /tmp/cdp-profile.json
 */
import { readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(process.argv[2] || '/tmp/cdp-profile.json', 'utf8'));
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const samples = profile.samples || [];
const deltas = profile.timeDeltas || [];
const INTERVAL = 400;   // µs，与采集时设置一致

const byFunc = new Map(), byFile = new Map();
let total = 0;
for (let i = 0; i < samples.length; i++) {
    const node = nodes.get(samples[i]);
    if (!node) continue;
    const us = deltas[i] ?? INTERVAL;
    total += us;
    const cf = node.callFrame || {};
    const url = cf.url || '(原生/无来源)';
    const fn = cf.functionName || '(anonymous)';
    const shortUrl = url.replace(/^https?:\/\/127\.0\.0\.1:\d+\//, '').replace(/^https?:\/\/[^/]+\//, '') || '(原生/无来源)';
    const key = `${shortUrl} → ${fn}${cf.lineNumber >= 0 ? `:${cf.lineNumber + 1}` : ''}`;
    byFunc.set(key, (byFunc.get(key) || 0) + us);
    byFile.set(shortUrl, (byFile.get(shortUrl) || 0) + us);
}

const ms = (us) => (us / 1000).toFixed(1);
const pct = (us) => ((us / total) * 100).toFixed(2).padStart(6) + '%';
console.log(`  总采样时间 ${ms(total)} ms（${samples.length} 个采样）\n`);

console.log('  ── 按文件 ──');
for (const [f, us] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`  ${ms(us).padStart(9)} ms  ${pct(us)}  ${f.padEnd(56)} ${'█'.repeat(Math.round((us / total) * 40))}`);
}
console.log('\n  ── 按函数（自耗时前 20）──');
for (const [k, us] of [...byFunc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${ms(us).padStart(9)} ms  ${pct(us)}  ${k}`);
}
