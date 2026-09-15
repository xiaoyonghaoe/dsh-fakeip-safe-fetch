# dsh-fakeip-safe-fetch 设计文档

## 设计初衷

开发 `dsh-fakeip-safe-fetch`，解决 DSH `web_fetch` 与 Clash/Mihomo TUN fake-IP 模式的冲突。

系统 DNS 返回 `198.18.x.x` 等 fake-IP 时，DSH 会将其识别为非公网地址并触发 SSRF 拦截。本插件不直接关闭安全检查，而是：

```text
识别 fake-IP
→ 通过独立 DoH 获取真实解析结果
→ 验证真实 IP 是否全部为公网地址
→ 验证通过后允许请求当前 fake-IP
→ 由 Clash TUN 恢复域名并转发
```

目标是在兼容 fake-IP 的同时，继续阻止访问本机、局域网和云元数据服务。

## 开发计划

1. 创建独立 DSH `WebFetchProvider` 插件，Provider ID 使用 `fakeip-safe`。
2. 复用官方 `HttpFetchProvider`，通过自定义 `HttpFetchResolver` 接入检测逻辑。
3. 每次请求先通过系统 DNS 获取当前地址。
4. 如果地址全部为公网，沿用官方处理流程。
5. 如果地址全部属于配置的 fake-IP 网段，通过独立 DoH 查询真实 A/AAAA 记录。
6. 验证 DoH 返回的完整地址集合，全部为公网地址才允许请求。
7. 按域名和 DoH TTL 缓存验证结果，但不缓存 fake-IP；每次请求仍获取当前 fake-IP。
8. 保留官方的 URL 校验、同源重定向、连接 pinning、超时、响应大小和内容类型限制。
9. 编写单元测试、模拟 DoH 测试以及 Clash/Mihomo TUN 实机测试。
10. 通过 `fetchProvider: fakeip-safe` 接管 `web_fetch`，无需修改 DSH 核心代码。

### 默认配置与用户覆盖

插件安装后应自动注册并启用 `fakeip-safe` Provider。用户无需手动填写配置即可使用，只有需要更换 DoH、调整 fake-IP 地址池或缓存时间时才覆盖默认值。

默认配置：

```yaml
- id: web-fetch-fakeip-safe
  name: dsh-fakeip-safe-fetch
  config:
    fakeIpCidrs:
      - 198.18.0.0/15
    dohUrl: https://dns.google/dns-query
    dohTimeoutMs: 5000
    maxValidationTtlMs: 300000
    maxResponseBytes: 5000000
    maxBodyChars: 100000
    timeoutMs: 30000
    maxRedirects: 5
    debug: false
```

默认值说明：

- `fakeIpCidrs`：允许进入独立 DoH 验证流程的 fake-IP 地址池；该配置不是直接放行名单。
- `dohUrl`：用于获取真实 A/AAAA 记录的独立 RFC 8484 DoH 服务。
- `dohTimeoutMs`：单次 DoH 查询超时时间，单位为毫秒。
- `maxValidationTtlMs`：域名安全验证结果的最大缓存时间，单位为毫秒；实际缓存时间取 DoH TTL 与该值中的较小值。
- `maxResponseBytes`：允许读取的最大响应字节数。
- `maxBodyChars`：返回给 `web_fetch` 的最大正文字符数。
- `timeoutMs`：完整抓取请求的超时时间，单位为毫秒。
- `maxRedirects`：允许跟随的最大同源重定向次数。
- `debug`：是否输出 DNS 分类、DoH 验证和缓存命中日志；默认关闭。

插件包内置的 `cordis.patch.yml` 应自动加载 Provider，并将 `web_fetch` 路由到它：

```yaml
- insert:
    - id: web-fetch-fakeip-safe
      name: dsh-fakeip-safe-fetch

- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-official
    fetchProvider: fakeip-safe
```

如果目标 Profile 默认未启用 `web_fetch`，安装补丁还应启用该工具：

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: true
    fetch: true
    searchTimeoutMs: 60000
    fetchTimeoutMs: 30000
```

用户可以在自己的 Profile 或设置层中覆盖插件默认值，例如：

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

DSH 的配置 Patch 会整体替换目标行的 `config`，而不是深度合并。因此用户覆盖 `web` 配置时，应同时保留当前的 `searchProvider`；覆盖插件配置时，也应填写希望保留的全部配置项。插件代码中的 Schema 默认值负责补齐缺失字段，但不能依赖 Patch 自动保留上一层的自定义字段。

## 边界判断

- 系统 DNS 全部返回公网 IP：允许，使用原生流程。
- 系统 DNS 全部返回配置的 fake-IP：执行独立 DoH 验证。
- 系统 DNS 出现公网与 fake-IP 混合结果：拒绝。
- 出现不属于 fake-IP 范围的非公网地址：拒绝。
- 直接请求私网、回环、链路本地或云元数据 IP：拒绝。
- IP 字面量不进行 DoH 补救，非公网 IP 直接拒绝。
- DoH 返回空结果、查询失败或超时：拒绝。
- DoH 返回结果中存在任何非公网地址：整组拒绝。
- DoH 验证缓存过期：重新验证。
- 重定向：重新执行地址判断，并继续限制为同源重定向。
- 配置或 DoH 解析策略发生变化：清空验证缓存。
- 独立 DoH 的结果无法证明 Clash 最终使用完全相同的 IP，因此本插件属于安全预检查；严格环境仍需在代理出口层阻止内网和云元数据访问。
