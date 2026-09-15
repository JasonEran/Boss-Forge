# BOSS 微信小程序扫码登录

用户要求扫码改为 BOSS 原生「微信注册/登录」入口中的小程序二维码。2026-09-09 实际检查确认入口为 `a.wx-login-btn[ka="wx_signin"]`，目标组件为 `ScanMiniapp`，二维码为 `.scan-wx-wrapper .mini-app-login img.mini-qrcode`（原图 280 px）。BOSS 页面标题为“微信扫码 安全登录”，不是 BOSS App 扫码，也不是公众号二维码。

实现：进入登录页后，如果停在 App 二维码，先点击 `.btn-sign-switch.phone-switch` 返回登录方式选择，再点击微信入口；已经在微信模式则保留有效二维码。过期时点击 BOSS 原生 `refresh_miniapp_sao_qrcode`；有效二维码的手动刷新通过返回验证码页再进入微信生成一次新码，不刷新回 App 模式。发布图片前检查微信二维码可见、加载完成、没有过期遮罩；刷新时还检查图片来源已改变。已登录页和安全验证页不切换登录方式。

平台登录页标题、图片说明、扫码步骤和服务状态消息同步改为“微信扫一扫 → BOSS 直聘小程序 → 手机确认登录”。保留已保存的登录状态检查与扫码后的真实登录核验；不因二维码已显示就启动 Worker，也不自动重发历史联系任务。

验证：807 项单元测试、TypeScript、Linux amd64 前端构建通过；隔离 Chromium 九个流程通过，覆盖 App/SMS/微信初始页、过期刷新、有效码手动刷新、跳转已登录、保留验证页。生产冷启动显示微信小程序二维码，加载完成且无 App 二维码；API 手动刷新返回 202，图片更新时间改变，二维码 GET 返回 200/有效 PNG，runtimeConsistent=true。当前等待用户在微信小程序确认，未把扫码完成验证写为已通过。

发布：`boss-wechat-login-20260909-1435cst`，数据库 migration 034，无数据库迁移。联系仍为 5 cancelled、6 历史 failed、1 uncertain，ready/processing 为 0。备份 `/opt/boss-forge/backups/wechat-login-20260909/`；本地证据 `artifacts/wechat-login-20260909/`。
