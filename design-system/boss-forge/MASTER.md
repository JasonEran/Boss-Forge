# Boss-Forge 前端设计系统

> 对账文件：`apps/web/app/globals.css` 与 `apps/web/components/ui/*`
>
> 最后更新：2026-09-01

## 1. 产品界面原则

Boss-Forge 是高密度招聘运营 Dashboard，不是营销落地页。设计优先级依次为：状态可读、证据可核对、操作安全、键盘可用、响应式。

- 使用清晰分区和紧凑表格，不使用大面积 Hero。
- 高风险操作必须在 Dialog 中显示目标和后果。
- 筛选条件必须可见，不把关键过滤器藏入二级菜单。
- 状态同时使用文字和颜色，不能只依赖颜色。
- 外部副作用按钮必须准确写“预览”“创建 Fake 联系”等实际行为。

## 2. 技术基础

- Tailwind CSS 4。
- shadcn 组件与 Base UI primitives。
- Lucide React 图标。
- Vinext/React 19。
- 不加载 Google Fonts；使用系统字体栈。

字体：

```css
--font-sans-ui: Inter, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
--font-mono-ui: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
```

## 3. 当前颜色 Token

| Token | Light 值 | 用途 |
|---|---|---|
| `--background` | `#f5f9fc` | 页面背景 |
| `--foreground` | `#102a3a` | 主文字 |
| `--card` | `#ffffff` | 卡片、Header、Dialog |
| `--primary` | `#0369a1` | 主按钮、选中状态、品牌 |
| `--primary-foreground` | `#ffffff` | 主色上的文字 |
| `--secondary` | `#e0f2fe` | 次要状态背景 |
| `--secondary-foreground` | `#075985` | 次要状态文字 |
| `--muted` | `#eaf1f5` | 弱背景 |
| `--muted-foreground` | `#536674` | 辅助文字 |
| `--accent` | `#dcfce7` | 成功/正向强调背景 |
| `--accent-foreground` | `#166534` | 正向强调文字 |
| `--destructive` | `#dc2626` | 删除、失败、高风险 |
| `--border` / `--input` | `#cfe2ec` | 边框和输入框 |
| `--ring` | `#0369a1` | 键盘焦点 |
| `--success` | `#15803d` | 成功状态 |
| `--warning` | `#d97706` | 歧义、等待和提醒 |

图表色为蓝、绿、橙、紫、红五色。圆角基准 `--radius: 0.7rem`。

Dark Token 已存在于 CSS，但当前没有用户可操作的主题切换；不得把 Dark Mode 写成已交付功能。

## 4. 页面结构

所有页面共享：

- 64px sticky Header。
- 桌面左侧导航，移动端顶部横向导航。
- 页面标题、说明、岗位选择和主要动作。
- 内容区使用 Card、Table、Tabs、Badge 和 Dialog。
- `body` 最小宽度 320px。

六个固定入口：总览、岗位、任务、审核、联系、审计。新增页面前先判断是否应成为现有页面的 Tab 或 Dialog。

## 5. 组件规范

### 5.1 Button

- 主动作每个区域最多一个 primary。
- 次要动作使用 outline/secondary。
- 图标来自 Lucide，图标和文字同时存在时保持统一间距。
- 异步提交期间 disabled，并显示 Loader。
- 真实副作用不得只用模糊的“确认”文案。

### 5.2 Card 与 Table

- 指标用 Card；批量候选人、任务和审计用 Table。
- 卡片默认白底、细边框和轻阴影，不使用大幅悬浮位移。
- 表格行需要明确的状态 Badge 和可点击目标。
- 超过 25 个候选人显示分页；未来服务端分页后沿用同一页大小语义。

### 5.3 Form

- Label 与输入字段保持可访问关联。
- 必填、默认值、单位和缺失策略必须可见。
- 规则表单保存的是新版本，按钮应写“保存新版本”或等价文案。
- 多值关键词用逗号/换行约定时必须提供示例。
- 验证错误显示在 Dialog 内，并保留用户输入。

### 5.4 Dialog

- 用于新建岗位/规则、计划、审核和消息预览。
- 标题描述对象和动作，正文展示不可逆影响。
- 长表单可滚动，底部动作保持可发现。
- 关闭不应静默提交。

### 5.5 Badge

- 成功：符合、已通过、已精筛、模拟完成。
- 警告：歧义、信息不足、待审核、等待 Worker。
- 破坏性：失败、拒绝、不符合。
- 中性：未安排、已取消、关闭。

Badge 文案以业务语言为主，不直接显示数据库枚举。

## 6. 交互与动效

- 默认过渡 150–250ms。
- 不使用 GSAP 或滚动揭示；当前应用没有这些依赖。
- Hover 不得改变布局尺寸。
- `prefers-reduced-motion: reduce` 时动画和过渡缩短到近乎即时。
- 轮询刷新不能打断正在编辑的 Dialog 或重置输入。

## 7. 响应式与可访问性

- 验证宽度：320、375、768、1024、1440px。
- 移动端表格可以转换为卡片或受控横向滚动，不能截断主要动作。
- 所有图标按钮有可读名称。
- 键盘焦点使用 `--ring`，不得移除 outline 而不提供替代。
- 正文对比度至少 4.5:1。
- 颜色不是唯一状态提示。
- Sticky Header/导航不能遮住内容或 Dialog。

## 8. 禁止项

- Emoji 代替功能图标。
- 隐藏关键筛选条件。
- 把 Fake 联系写成“已发送”。
- 把未实现的自动联系开关画成可用状态。
- 在前端展示 OCR 密钥、完整环境变量或敏感 stdout。
- 无目标确认的批量审核/联系。
- 低对比度文本、不可见焦点和布局跳动 Hover。

## 9. 交付检查

- [ ] 与当前六页信息架构一致。
- [ ] 桌面和移动导航可用。
- [ ] 所有异步动作有 loading、disabled 和错误状态。
- [ ] 状态文案与数据库行为一致。
- [ ] Fake/Real、预览/发送的边界明确。
- [ ] 320–1440px 无主要内容遮挡。
- [ ] 键盘焦点和 Dialog 焦点管理正常。
- [ ] `prefers-reduced-motion` 生效。
- [ ] `pnpm lint:web`、`pnpm typecheck` 和 `pnpm web:build` 通过。
