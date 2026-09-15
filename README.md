# dsh-fakeip-safe-fetch

让 DeepSeek Harness 的 `web_fetch` 在 Clash/Mihomo TUN fake-IP 模式下继续工作，同时保留非公网目标拦截。

```text
每次系统 DNS 查询 → 全公网：验证后交给官方连接 pinning
                 → 全 fake-IP：独立 DoH 验证 A/AAAA → 使用本次 fake-IP 连接
                 → 混合、私网或非法结果：拒绝
```

## 兼容与安装

- Node.js 24 或更高版本；开发使用 pnpm 11.19.0。
- 兼容基线：DSH **0.1.5-rc.2**。依赖固定在该版本；旧的 npm `latest` 缺少所需 Resolver 接口，不能使用。
- Clash/Mihomo 已启用 TUN 和 fake-IP；默认地址池为 `198.18.0.0/15`。
- 仅支持 DSH 对目标使用直连路由的 TUN 场景。目标走显式 HTTP 代理时拒绝；应在启动 DSH 前移除相应代理配置并重启。插件不会修改系统代理或全局 dispatcher。运行过程中重新安装进程代理策略不受支持。

从源码生成安装包：

```sh
pnpm install --frozen-lockfile
pnpm check
mkdir -p artifacts
pnpm pack --pack-destination artifacts
```

使用 **0.1.5-rc.2** 的 DSH 命令安装到需要使用的 Profile：

```sh
dsh plugin --profile web add /absolute/path/dsh-fakeip-safe-fetch-0.1.0.tgz
dsh --profile web --dump-config
```

`dsh plugin` 会通过包内 `dsh.bundle.patch` 元数据自动加入配置层，加载 Provider，将 `web.fetchProvider` 设为 `fakeip-safe`，并启用 `tool-web.fetch`。无需手填默认配置。直接执行普通 `npm install` / `pnpm add` 不会触发 DSH 的 bundle 注册步骤。

默认补丁同时设置 `searchProvider: deepseek-official`、`search: true`。使用其他搜索提供方的用户应在上层 Profile 中保留自己的完整 `web` 配置。插件面向已有 `web` 与 `tool-web` 配置行的标准 DSH Profile；自定义精简 Profile 需先加载对应服务与工具。

卸载：

```sh
dsh plugin --profile web remove dsh-fakeip-safe-fetch
```

DSH 将移除本包的配置层；若用户自己的覆盖层仍指定 `fakeip-safe`，也需移除该覆盖。

## 配置

所有配置项均可省略。插件安装后的默认值：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `fakeIpCidrs` | `[198.18.0.0/15]` | 进入 DoH 验证流程的地址池，支持 IPv4/IPv6；不是直接放行名单 |
| `dohUrl` | `https://dns.google/dns-query` | RFC 8484 HTTPS 二进制 DoH 地址 |
| `dohTimeoutMs` | `5000` | 每次 DoH HTTP 查询及响应读取超时（毫秒） |
| `maxValidationTtlMs` | `300000` | 成功验证缓存的 TTL 上限；`0` 禁用缓存 |
| `maxResponseBytes` | `5000000` | 官方 Provider 的响应字节上限 |
| `maxBodyChars` | `100000` | 正文字符上限 |
| `timeoutMs` | `30000` | 包括 DNS、DoH、重定向和正文的完整抓取超时 |
| `maxRedirects` | `5` | 最大同源重定向次数；`0` 禁止跟随 |
| `debug` | `false` | 输出 DNS 分类、DoH 验证和缓存日志 |

示例：在自己的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: web-fetch-fakeip-safe
  name: dsh-fakeip-safe-fetch
  config:
    fakeIpCidrs:
      - 198.18.0.0/16
      - fd00:6152::/32
    dohUrl: https://cloudflare-dns.com/dns-query
    dohTimeoutMs: 8000
    maxValidationTtlMs: 60000
    maxResponseBytes: 10000000
    maxBodyChars: 200000
    timeoutMs: 45000
    maxRedirects: 3
    debug: true
```

DSH Patch **整体替换目标行的 `config`**，缺失字段由本插件的 Schema 默认值补齐；此前层中的自定义值不会自动保留。覆盖 `web` 时，需同时填写希望保留的 `searchProvider` 与 `fetchProvider`。`tool-web.fetchTimeoutMs` 是外层工具预算；只增大本插件 `timeoutMs` 不会延长该外层预算。

配置重载通过 Cordis 重新创建实例，终止旧实例请求并清空缓存。`debug` 输出走 Cordis logger；如宿主日志级别过滤 debug，还需调整宿主日志级别。

## 安全行为

- 每次请求及每次同源重定向都重新查询系统 DNS，使用该次验证后的完整地址集合建立专用连接，保留原 URL 的 Host 与 TLS SNI。
- IP 字面量不使用 DoH 补救；私网、回环、链路本地、云元数据、保留地址、fake-IP 字面量均拒绝。
- 保留 IPv4 映射 IPv6 与 NAT64 检查。出现 IPv6 时用系统 DNS 查询 `ipv4only.arpa` 发现自定义 DNS64 前缀；发现失败时拒绝。
- DoH 通过 Node HTTPS 独立请求受配置控制的端点，验证 TLS 证书；连接端点本身可以经 TUN 的 fake-IP 到达，不会递归调用本插件 Resolver。插件不关闭 TLS 验证，也不改写 DNS 全局配置。
- A/AAAA 都必须成功完成；允许其中一族有效无记录。合并结果必须非空，响应中所有 A/AAAA（含附加记录）均须公网。失败、超时、截断、报文不匹配、CNAME 循环或超过 8 跳均拒绝。
- DoH HTTP 重定向拒绝，响应限制 65,535 字节。CNAME、地址记录和 SOA 无记录证明共同约束 TTL，并扣除 HTTP `Age`；缺少 TTL 证明时仅供本次使用。
- 缓存仅含域名验证结论和过期时间，最多 1,024 项，按最近使用淘汰。缓存命中也不会省略系统 DNS 查询。失败结果不缓存。
- URL 协议/凭据检查、重定向、响应与字符上限、内容类型及字符集处理复用官方 `HttpFetchProvider`。声明长度超限拒绝；流式超限按官方行为截断。

**DoH 的解析结果无法证明 Clash 最终连接到完全相同的 IP。** 本插件属于安全预检查；严格环境仍必须在代理出口阻止内网和云元数据访问。DoH 端点配置和机器的 TLS 信任库属于受信任的部署配置。

错误沿用 DSH `WebError`：安全策略拒绝为 `WEB_BLOCKED_URL`，DoH/系统解析错误为 `WEB_PROVIDER_ERROR`，抓取总超时为 `WEB_FETCH_TIMEOUT`，取消或卸载为 `WEB_ABORTED`；其他 URL、重定向和正文错误由官方 Provider 返回。

## 开发与验收

```sh
pnpm typecheck
pnpm test                # 构建后执行测试；真实 HTTPS 测试需要 openssl
pnpm build
pnpm test:profile        # 先打包；在 .test-profile/ 下创建全新隔离 DSH 安装
pnpm test:tun            # 显式运行当前机器上的 TUN 实机测试
```

`test:profile` 会下载官方 DSH 0.1.5-rc.2，在独立 `DSH_HOME` 中验证 CLI 安装、补丁合成、配置覆盖、已安装包的 Cordis 注册和卸载。报告写入 `artifacts/profile-report.json`，不会修改日常 Profile；隔离目录保留以便排查。

`test:tun` 默认抓取 `https://example.com/`，可用 `DSH_TUN_TEST_URL` 指定测试网页。先检查系统 DNS 是否全部来自默认 fake-IP 池，再验证公网抓取、非公网字面量阻断、DoH 不可用时拒绝；未启用对应 TUN 环境的检查标记为 `unverified`，不会伪报通过。报告写入 `artifacts/tun-report.json`。更换 IPv6/其他 fake-IP 池后需对应调整实机测试脚本中的地址池。

本地打包不等同于发布 npm；本项目不包含自动发布或修改 Clash 配置的脚本。
