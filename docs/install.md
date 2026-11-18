# iPhone 安装 · v9.16

需要 **Loon 3.5.1 (983) 或更新版本**。一次只启用一份清单；停用旧版。清单和两个 JS 必须同为 v9.16，尤其不要拿新版的「只读诊断」运行旧的签到脚本。

## 首选：自有 HTTPS 静态目录（手机不需要 Python）

1. 在电脑或 NAS 解压，从项目根目录运行下例。把示例地址换成 **iPhone 能访问且信任证书**的私有目录地址（可在局域网/VPN 上）；不要用带账号、查询串或临时令牌的 URL。生成器只写新文件，不上传。
   ```sh
   python3 tools/manifests.py --base-url https://nas.example.invalid/loon/v9.16 -o hyrz-private.plugin
   ```
2. 让该目录提供 `hyrz-private.plugin`、`hyrz-sniff.js`、`hyrz-sign.js` 三个原文文件，不是仓库预览页或登录页。在手机确认三个地址均能读到正确版本；保留地址供 Loon 后续加载或更新。
3. 在 iPhone 打开生成器输出的 `loon://import?plugin=...`，确认导入。绝对脚本 URL 已写入清单，不依赖相对路径查找。

## 只有压缩包时

- `hyrz-local.plugin` 使用文档允许的固定裸文件名 `script("hyrz-sniff.js", …)` / `script("hyrz-sign.js", …)`。文档**没说相对于哪个目录查找，也没保证「文件」App 导入会带入旁边的 JS**。不要将解压或点开清单当作安装成功，也不要把 `[Script]` 单独贴进主配置（会丢失插件参数作用域）。
- 同机备选：若 iPhone 已有能读解压文件并运行 Python 3 的终端，在一个**只含** `hyrz-localhost.plugin` 和两个 JS 的目录中执行：
  ```sh
  python3 -m http.server 18916 --bind 127.0.0.1
  ```
  在同一台手机用 Safari 检查 `http://127.0.0.1:18916/hyrz-localhost.plugin` 和两份 JS 的同目录 URL，再打开 [本机导入](loon://import?plugin=http%3A%2F%2F127.0.0.1%3A18916%2Fhyrz-localhost.plugin)。这是静态文件服务，不是签到面板。不要绑定到所有网卡。`127.0.0.1` 不是电脑的地址；加载或刷新脚本时服务须可达。iOS 后台挂起或 Loon 不接受本机 HTTP 时，改用上面的私有 HTTPS，勿关闭证书校验。
- `hyrz-checkin.plugin`（GitHub raw `main`）和 `hyrz-checkin-jsdelivr.plugin`（jsDelivr `@main`）是维护者发布用的浮动版；不用于验证未发布的压缩包。等对应源的清单及脚本都更新后再用。

## 启用后核对

按 Loon 指引在自己的设备上启用并信任 MitM 证书。解密范围是 `x8m8.ams.game.qq.com` 与 `ulinkact.game.qq.com` 两个主机；只有各自的 `/ams/ame/amesvr`、`/app/7335/99200e6deafa8a6a/index.php`（可带查询串）进入采集，活动由 JS 过滤。先从 Loon 脚本入口运行 `火影·只读诊断` 确认脚本加载；不要用手动签到或补领来测试安装。

- 手动：`火影·只读诊断`、`火影·手动签到`、`火影·手动补领`、`火影·看日志`。自动：`火影·每日签到`（默认 09:00）。模式按 `$script.name` 精确区分。
- 本地参考只确认五/六段 cron，没确认逗号列表。兜底拆为 `火影·定时补领-12`、`-15`、`-18`、`-21`、`-23`（各小时 :05）；每小时 :02/:12/:22/:32/:42/:52 六条错峰指令共用 `火影·待办检查`。两类均由 `enable=${catchup}` 控制。
- Generic/cron 的 `$argument` 是对象：`{${signFlow},${claimGift},${autoTasks},${catchup},${uploadLog},${logTopic}}`。`signFlow` 默认字符串 `1083576`，四个开关默认关，`logTopic` 默认空；升级可能保留用户以前的值，请核对后再启用。采集脚本只接收 `{${catchup}}`，没有公开网址操作入口。

依据：[Script v2](https://nsloon.app/docs/Script/script_v2/)、[插件参数](https://nsloon.app/docs/Plugin/)、[导入 Scheme](https://nsloon.app/docs/Scheme/)。真机加载、相对路径基准及 iOS 调度仍以设备为准。
