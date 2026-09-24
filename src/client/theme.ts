/**
 * @dsh-external/dsh-nautilus — 客户端令牌层：--nt-* 亮暗双主题，跟随 DSH 宿主主题（U1/U2）。
 *
 * **为什么有这个文件**：工作台里 153 处 `var(--nt-*, <浅色值>)` 一直**只有引用、没有定义**
 * （workbench.ts 头部旧注释称「令牌由 index.ts 注入」，实际从未落地）——于是每处都吃自己的回退值，
 * 插件恒为浅色：宿主切暗色对本面板**零影响**。本文件把令牌层补成一张真实注入的样式表。
 *
 * **主题机制**（dsh 0.1.7-rc.1 实测，`@deepseek-ai/dsh-client-ui-layout` theme-presenter）：
 *   · `html{color-scheme}` + **`body[data-ds-dark-theme]`** + body 内联 `--dsw-alias-*` 三者同步投影；
 *   · 亮/暗两套基础 `--dsw-alias-*` 由 `@deepseek-ai/dsh-client-ui-theme` 的样式表按
 *     `body` / `body[data-ds-dark-theme]` 两个选择器给出（用户偏好 light|dark|system 三态）。
 * 故本层**不做任何 JS 监听**：宿主换肤 = 该属性翻转 = 令牌源整块切换，组件树零改动（dev-02 §2.2）。
 *
 * **绑定纪律**（三条，dev-02 §2.2 有完整论证）：
 *   ① 墨 / 线 / 状态 / 交互类**绑定宿主** `var(--dsw-alias-*, S4 兜底)`——宿主亮暗确实区分这些别名，
 *      且复合结果与 S4 定版值几乎重合（`border-l2` 10% 黑压在 #f2f2f0 上 = #d9d9d6 ↔ S4 #d9d9d5）；
 *   ② 三级面（bg / panel / panel2）**自持 S4 定版色**——宿主浅色把 `bg-base/layer-1/2/3` 折叠成同一个
 *      `#fff`（0.1.7-rc.1 实测），绑定即抹平「图纸底 / 白卡片」的 S4 层次（OQ-U7 待裁决）；
 *   ③ 朱红 `--nt-accent` **静态**，不随主题（S4 唯一颜色主张；语义＝需人工注意）。
 *
 * **手动档边界**：浅/深只覆盖 `.nt-wb` 子树里的字面值——不写宿主 body 属性、不调 ctx.theme.setTheme。
 * 观测插件不改宿主状态（AGENTS §0 定位红线：观测，不干预）。侧栏图标与流内对齐按钮在 `.nt-wb` 之外，
 * 属宿主色谱面，永远跟随宿主。
 */
import { createElement, type ReactNode } from 'react'

/** 一条令牌：语义名 + 宿主别名（缺省＝自持）+ 亮/暗定版值 + 用途。 */
export interface NtToken {
  name: string
  /** 宿主 DSH 别名（`--dsw-alias-*`）；缺省＝自持令牌（面层 / 静态强调 / 字体）。 */
  dsh?: string
  /** 浅色定版值（S4 原型 §2.1）。 */
  light: string
  /** 暗色定版值（S4 原型 §2.1 dark 块）。 */
  dark: string
  /** 用途（文档可读性 + 测试断言用）。 */
  use: string
}

/**
 * 令牌表：组件唯一取色处（`src/client/**` 里除本表外零硬编码色，测试守卫）。
 * 数值来源 = docs/2-dev/ui-s4-prototype.html 的 `:root` / `body.dark` 两块（视觉权威参照）。
 */
export const NT_TOKENS: readonly NtToken[] = [
  // ── 面层：S4 签名「图纸底 / 白卡片 / 次级面」，自持不绑宿主（纪律 ②）──
  { name: '--nt-bg', light: '#f2f2f0', dark: '#121314', use: '面板底（图纸）' },
  { name: '--nt-panel', light: '#ffffff', dark: '#1a1b1d', use: '卡片 / 面板面' },
  { name: '--nt-panel2', light: '#f7f7f5', dark: '#232427', use: '次级面（表头 / 条带 / 输入框槽）' },
  // ── 墨与线：绑定宿主（纪律 ①）──
  { name: '--nt-text', dsh: '--dsw-alias-label-primary', light: '#101010', dark: '#f2f2f0', use: '主文本 / 主墨色' },
  { name: '--nt-dim', dsh: '--dsw-alias-label-secondary', light: '#5f5f5c', dark: '#a9a9a4', use: '次文本（说明 / 注记）' },
  { name: '--nt-faint', dsh: '--dsw-alias-label-tertiary', light: '#9a9a95', dark: '#70706b', use: '微标签（字距大写小字）' },
  { name: '--nt-ink', dsh: '--dsw-alias-label-primary', light: '#101010', dark: '#f2f2f0', use: '图表主线（主读数）' },
  { name: '--nt-border', dsh: '--dsw-alias-border-l2', light: '#d9d9d5', dark: '#35363a', use: '发丝线（分隔 / 网格）' },
  { name: '--nt-border2', dsh: '--dsw-alias-border-l4', light: '#c8c8c3', dark: '#4a4b50', use: '加重线（控件边 / 注记左标）' },
  { name: '--nt-ok', dsh: '--dsw-alias-state-success-primary', light: '#1a7f37', dark: '#3fb950', use: '正常 / 成功态（非朱红）' },
  { name: '--nt-hover', dsh: '--dsw-alias-interactive-bg-hover', light: 'rgba(20,20,18,.05)', dark: 'rgba(255,255,255,.08)', use: '悬停底（交互反馈）' },
  { name: '--nt-mask', dsh: '--dsw-alias-bg-mask-1', light: 'rgba(0,0,0,.28)', dark: 'rgba(0,0,0,.5)', use: '抽屉遮罩' },
  { name: '--nt-shadow-color', light: 'rgba(0,0,0,.16)', dark: 'rgba(0,0,0,.55)', use: '浮层投影色（暗色需更重才有分离感）' },
  // ── 静态与自持 ──
  { name: '--nt-accent', light: '#e6321e', dark: '#e6321e', use: '朱红＝需人工注意（静态，不随主题）' },
  { name: '--nt-font', light: "'Helvetica Neue',Helvetica,Arial,'Segoe UI','Microsoft YaHei',sans-serif", dark: "'Helvetica Neue',Helvetica,Arial,'Segoe UI','Microsoft YaHei',sans-serif", use: '字体栈（宿主无 --dsw-font-family 令牌，自持）' },
]

/** 跟随档声明：有宿主别名 → `var(--dsw-alias-*, <S4 兜底>)`；无 → 定版字面值。 */
function followDecl(t: NtToken, mode: 'light' | 'dark'): string {
  const v = mode === 'light' ? t.light : t.dark
  return t.dsh === undefined ? t.name + ':' + v : t.name + ':var(' + t.dsh + ',' + v + ')'
}

/** 覆盖档声明：一律字面值——手动档的语义就是「不听宿主的」。 */
function fixedDecl(t: NtToken, mode: 'light' | 'dark'): string {
  return t.name + ':' + (mode === 'light' ? t.light : t.dark)
}

const block = (sel: string, decls: readonly string[]): string => sel + '{' + decls.join(';') + '}'

/** 令牌层样式表 id（幂等注入的把手，也便于端上核对）。 */
export const NT_THEME_STYLE_ID = 'nt-theme-style'

/**
 * 生成令牌层样式表（**纯函数**：SSR 冒烟与单测直接读它，不碰 DOM）。
 * 四个块缺一不可：亮/暗跟随 + 浅/深覆盖。
 */
export function ntThemeCss(): string {
  return [
    '/* ① 跟随宿主 · 浅色（宿主 --dsw-alias-* 优先，S4 定版值兜底） */',
    block('body', NT_TOKENS.map((t) => followDecl(t, 'light'))),
    '/* ② 跟随宿主 · 暗色（body[data-ds-dark-theme] 由 ui-layout theme-presenter 投影；块序必须在 ① 之后） */',
    block('body[data-ds-dark-theme]', NT_TOKENS.map((t) => followDecl(t, 'dark'))),
    '/* ③ 手动档：只在工作台子树覆盖字面值（不触碰宿主 body / settings） */',
    block('.nt-wb[data-nt-theme="light"]', NT_TOKENS.map((t) => fixedDecl(t, 'light'))),
    block('.nt-wb[data-nt-theme="dark"]', NT_TOKENS.map((t) => fixedDecl(t, 'dark'))),
    // 跟随档的档位标签：浅/暗两版文案由宿主属性切换（纯 CSS，无 JS 监听；也是「跟随生效」的肉眼证据）
    '.nt-sch-d{display:none}',
    'body[data-ds-dark-theme] .nt-sch-l{display:none}',
    'body[data-ds-dark-theme] .nt-sch-d{display:inline}',
    // 档位不换行（顶栏可压缩到 ~400px 中栏）
    '.nt-thseg button{white-space:nowrap}',
  ].join(String.fromCharCode(10))
}

let themeStyleDone = false

/** 注入令牌层（幂等；SSR 无 document 时安全跳过）。 */
export function ensureNautilusTheme(): void {
  // head 可能尚未就绪（本函数在 apply() 就被调用，早于任何渲染）：此时直接返回、不置 done，留给下一次重试。
  // 加载期抛错会拖垮整个浏览器半区插件集（postmortem 0001 形态），故宁可静默跳过。
  if (themeStyleDone || typeof document === 'undefined' || document.head === null) return
  themeStyleDone = true
  const el = document.createElement('style')
  el.id = NT_THEME_STYLE_ID
  el.textContent = ntThemeCss()
  document.head.appendChild(el)
}

// ── 主题档位（跟随宿主 / 强制浅 / 强制深）────────────────────────────────────

/** 主题档位：host＝跟随 DSH 主题（默认），light / dark＝工作台局部强制。 */
export type ThemeMode = 'host' | 'light' | 'dark'

export const THEME_MODES: readonly ThemeMode[] = ['host', 'light', 'dark']

/**
 * 手动档持久化键（插件自有命名空间）。
 * 刻意**不写宿主 ui-theme 设置**——那会改掉整个 GUI 的主题，属「干预」（定位红线）。
 */
export const THEME_STORAGE_KEY = 'dsh-nautilus:theme'

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'host' || v === 'light' || v === 'dark'
}

/** 读手动档：localStorage 不可用（SSR / 隐私模式）或值非法 → host（跟随宿主）。 */
export function readThemeMode(): ThemeMode {
  try {
    const v: unknown = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    return isThemeMode(v) ? v : 'host'
  } catch {
    return 'host'
  }
}

/** 写手动档：写失败只丧失持久化，不影响本次会话的表现（不抛、不打断渲染）。 */
export function writeThemeMode(m: ThemeMode): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, m)
  } catch {
    /* 隐私模式 / 配额：忽略 */
  }
}

/** 档位提示（title 悬停说明；说清「只影响本面板」这条边界）。 */
export const THEME_MODE_TITLE: Record<ThemeMode, string> = {
  host: '跟随 DSH 主题：宿主切亮/暗时本面板同步（默认）',
  light: '强制浅色：仅本面板，不改宿主主题与设置',
  dark: '强制深色：仅本面板，不改宿主主题与设置',
}

function modeLabel(m: ThemeMode): ReactNode {
  if (m === 'light') return '浅色'
  if (m === 'dark') return '深色'
  // 跟随档顺带显示宿主当前亮暗（两个 span 由 ①② 的属性驱动 display，无 JS）
  return createElement('span', null, '跟随',
    createElement('span', { className: 'nt-sch-l' }, '·浅'),
    createElement('span', { className: 'nt-sch-d' }, '·深'),
  )
}

/** 主题档位控件（工作台顶栏）。选中态由调用方持有（持久化见 read/writeThemeMode）。 */
export function ThemeSeg(props: { mode: ThemeMode; onPick: (m: ThemeMode) => void }): ReactNode {
  return createElement('div', { className: 'nt-wb-seg nt-thseg' },
    ...THEME_MODES.map((m) => createElement('button', {
      key: m,
      className: m === props.mode ? 'on' : '',
      title: THEME_MODE_TITLE[m],
      onClick: () => props.onPick(m),
    }, modeLabel(m))),
  )
}
