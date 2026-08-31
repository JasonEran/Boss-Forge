# Boss-Forge

内网 HR 智能简历筛选与候选人联络 Dashboard。

当前文档：

- [HR Dashboard 产品需求文档](docs/HR_DASHBOARD_PRD.md)
- [系统架构设计](docs/SYSTEM_ARCHITECTURE.md)
- [M0 技术验证运行手册](docs/M0_RUNBOOK.md)
- [boss-cli 能力复用清单](docs/BOSS_CLI_REUSE_MATRIX.md)
- [HR Dashboard 需求思维导图](docs/HR_DASHBOARD_MINDMAP.md)

## M0 快速验证

```bash
pnpm install
pnpm m0:install-browser
pnpm typecheck
pnpm test
pnpm m0:doctor
pnpm m0 -- login
```

登录需要在打开的 Chrome 中人工完成。登录后可执行：

```bash
pnpm m0 -- live positions
```

简历预览和真实打招呼分别要求显式传入 `--approve-preview` 与 `--approve-greet`，详见 [M0 技术验证运行手册](docs/M0_RUNBOOK.md)。
