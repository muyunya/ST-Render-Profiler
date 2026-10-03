/**
 * 结构自检 —— 防止「改一处、错一处」这类低级但致命的问题。
 *
 * 起因：给报告加 probes 字段时，锚点字符串在文件里出现了两次，
 * 结果被插进了另一个函数的返回对象里（那里根本没有 probes 变量），
 * 而真正该有的地方反而没有 —— 表现是「报告里少了字段」+「另一个按钮点了就崩」。
 * 这种错误语法检查（node --check）抓不到，只有跑起来才暴露，所以固化成检查。
 *
 * 运行：node tests/structure-check.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'index.js'), 'utf8');
const lines = src.split('\n');

/** 取顶层函数的源码区间（按大括号配平） */
function funcBody(name) {
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`function ${name}(`) || lines[i].startsWith(`async function ${name}(`)) {
            start = i;
            break;
        }
    }
    if (start < 0) throw new Error(`找不到函数 ${name}`);
    let depth = 0;
    let started = false;
    for (let j = start; j < lines.length; j++) {
        depth += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length;
        if (lines[j].includes('{')) started = true;
        if (started && depth === 0) return lines.slice(start, j + 1).join('\n');
    }
    return lines.slice(start).join('\n');
}

const probeModule = src.slice(0, src.indexOf('function pad('));
const runSession = funcBody('runSession');
const formatSession = funcBody('formatSession');
const generationPath = funcBody('measureGenerationPath');

const checks = [
    ['探针模块函数齐全', ['recordProbe', 'installLibraryProbes', 'startProbes', 'stopProbes']
        .every((name) => probeModule.includes(`function ${name}(`))],
    ['runSession 调用了 startProbes()', runSession.includes('startProbes()')],
    ['runSession 调用了 stopProbes()', runSession.includes('stopProbes()')],
    ['runSession 的返回对象含 probes', /^\s+probes,$/m.test(runSession)],
    ['生成路径没有引用未定义的 probes', !/\bprobes\b/.test(generationPath)],
    ['formatSession 会输出探针区块', formatSession.includes('s.probes')],
];

let rest = src;
for (const part of [probeModule, runSession, formatSession]) rest = rest.replace(part, '\n', 1);
const leaks = rest.split('\n').filter((line) => /\bprobes\b/.test(line)).map((line) => line.trim());
checks.push(['没有游离的 probes 引用', leaks.length === 0]);

let failed = 0;
for (const [name, passed] of checks) {
    console.log(`  ${passed ? '✓' : '✗'} ${name}`);
    if (!passed) failed++;
}
if (leaks.length) console.log(`    游离引用: ${leaks.join(' | ')}`);
console.log(failed === 0 ? '\n✅ 结构自检通过' : `\n❌ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
