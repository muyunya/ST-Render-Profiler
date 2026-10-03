# 渲染性能实测报告（2026-10-04）

对「该用户的聊天」聊天（94 条消息 / 249,252 字符）在**无头浏览器**里做了两轮独立测量：
LoAF（浏览器 long-animation-frame API）+ V8/CDP 函数级采样。结论如下。

## 一、先纠正一个误导

LoAF 的 `scripts[].sourceURL` 只给到**文件级**，而且会严重偏离：

| 来源 | LoAF 归因 | V8 函数级采样实测 |
|---|---|---|
| `public/lib.js`（酒馆自带的库包） | **5616 ms（最大头）** | **0.6%** ✗ |

`lib.js` 是「webpack 包 + ES 模块」双身份，业务代码 `import { lodash, css, … } from '../lib.js'`，
LoAF 会把时间算到这个**最后加载的大文件**上，而真正执行的代码在别处。
**任何基于 LoAF 文件归因的优化决策都可能是错的。**

## 二、被证伪的优化方向（别再试）

| 假设 | 实测 | 结论 |
|---|---|---|
| markdown 转换（showdown）是瓶颈 | 0.689 ms/条 × 50 条 = 34.5 ms | 占总渲染 **0.9%**，用 WASM 替换最多省 0.3% |
| DOMPurify 消毒是瓶颈 | 123 次 / 138.8 ms | **2.3%**；其中 `css.parse` 仅 23.7 ms |
| Handlebars 模板编译是瓶颈 | **0 次调用** | 无关 |
| hljs 代码高亮是瓶颈 | 47 次 / 26.5 ms | 无关（该聊天无代码块） |
| `lib.js` 里的库是瓶颈 | 21 项探针合计 **201 ms** | 无关（详见第一节） |
| 那条 `<tableEdit>` 正则有回溯风险 | 94 条消息合计 **0.4 ms** | **不是问题**；且改写会**改变行为**（见下） |

### 关于 `<tableEdit>` 正则：不要改写

原写法 `/<tableEdit>((?:(?!<tableEdit>).)*?)<\/tableEdit>/gs` 的「温和贪婪记号」
**不允许跨越另一个 `<tableEdit>`**。实测有一条消息 `<tableEdit>` 出现 2 次、
`</tableEdit>` 只有 1 次，此时原写法从第 2 个标签开始匹配（1764 字符），
而看似等价的 `/<tableEdit>([\s\S]*?)<\/tableEdit>/gs` 会从第 1 个开始（5030 字符）——
**行为不同**。它又只花 0.4 ms，没有优化价值。

## 三、真正的时间去哪了

V8/CDP 函数级采样显示，开销集中在**每条消息都要做的扩展侧工作**，而不是核心渲染：

| 来源 | 实测 | 说明 |
|---|---|---|
| 消息内嵌 HTML 的 iframe 执行 | `about:srcdoc` 733.8 ms / 15 s 窗口 | 酒馆助手把每条消息渲染进 iframe 并执行其中的脚本（如 `startRainSound`） |
| `(inline)` 动态脚本 | 582–1017 ms | 两个 JS Runner 扩展（酒馆助手 + JS runner）都会动态插脚本 |
| `blob:… measureAndPost` | 82–617 ms | 酒馆助手的 iframe 高度测量 |
| `st-memory-enhancement` 表格重渲染 | LoAF 归因 2346–3262 ms | 该归因同样存疑，但它确实每条消息都在重建 DOM |
| 预设生成的解析正则 | 187 采样（2.5%） | 由 `.oai_settings.预设中的某一项` 的 `<自定义格式标签>` 规范动态生成，对**每条消息**做失败匹配 |
| `st-pretext-height-profiler` | 81 + 19 ms | 第三方高度测量扩展 |
| `tokenizers.js countTokensOpenAIAsync` | 81 ms | 分词 |
| V8 GC | 448.8 ms | 大量字符串/正则工作造成的分配压力 |

**样式与布局只占 1.5–2.7%** —— 所以 `content-visibility` 这类优化上限很低，
真正的大头在**扩展对每条消息做的脚本级处理**。

## 四、可执行的建议

按收益排序，全部是配置层、可随时回退：

1. **两个 JS Runner 只留一个**。`JS-Slash-Runner`（酒馆助手 v4.11.2）与
   `SillyTavernExtension-JsRunner`（v1.0.0）职责重叠，两者都会对每条消息执行脚本。
   保留你卡片依赖的那个即可。
2. **`st-pretext-height-profiler` 与 `st-memory-enhancement` 二选一或都关**，
   它们都在每条消息上做 DOM 测量/重建。关掉后刷新页面即可对比。
3. **`lib.js` / markdown / DOMPurify 都不必动** —— 实测合计不到 4%。

## 五、复现方式（不需要人工点按钮）

```bash
bash tools/profile-page.sh 60          # 无头浏览器加载酒馆并采集 V8 采样
node tools/v8-analyze.mjs <日志>        # 输出「谁在烧 CPU」排名

python3 tools/cdp-profile.py profile "<聊天文件名>" "<角色名>" 15   # CDP 精确定位
node tools/analyze-cdp-profile.mjs /tmp/cdp-profile.json
```

`tools/profile-page.sh` 需要酒馆运行在 `127.0.0.1:8000`；CDP 方式会自动打开指定角色的聊天。
