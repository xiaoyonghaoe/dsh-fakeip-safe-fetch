import { lookup } from 'node:dns/promises'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { FakeIpSafeFetchProvider } from '../lib/index.js'
import { defaults } from '../lib/config.js'
import { isFakeIp, parseCidrs } from '../lib/ip-policy.js'

const url = new URL(process.env.DSH_TUN_TEST_URL ?? 'https://example.com/')
// Probe readiness against the shipped pools, or against DSH_TUN_FAKEIP_CIDRS for custom ones.
const pools = (process.env.DSH_TUN_FAKEIP_CIDRS ?? defaults.fakeIpCidrs.join(',')).split(',').map(value => value.trim()).filter(Boolean)
const cidrs = parseCidrs(pools)
const results = []
const providers = []
const create = (config = {}) => {
  const provider = new FakeIpSafeFetchProvider(config)
  providers.push(provider)
  return provider
}
const run = async (name, test) => {
  try { results.push({ name, status: 'passed', detail: await test() }) }
  catch (error) { results.push({ name, status: 'failed', detail: String(error), code: error.code }); process.exitCode = 1 }
}
let addresses = []
let tunReady = false
try {
  addresses = await lookup(url.hostname, { all: true, order: 'verbatim' })
  tunReady = addresses.length > 0 && addresses.every(entry => isFakeIp(entry.address, cidrs))
} catch (error) { results.push({ name: 'system DNS', status: 'failed', detail: String(error) }); process.exitCode = 1 }

const provider = create()
for (const target of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://198.18.0.1/', 'http://[::1]/']) {
  await run(`block ${target}`, async () => {
    try { await provider.fetch({ url: target }) } catch (error) {
      if (error.code === 'WEB_BLOCKED_URL') return error.code
      throw error
    }
    throw new Error('unsafe destination was accepted')
  })
}
if (tunReady) {
  await run('fetch public content through current TUN fake-IP', async () => {
    const result = await provider.fetch({ url: url.href })
    if (result.statusCode < 200 || result.statusCode >= 300 || !result.body.content) throw new Error(`unexpected HTTP ${result.statusCode}`)
    return { url: result.url, statusCode: result.statusCode, chars: result.body.content.length }
  })
  await run('fail closed when DoH is unavailable', async () => {
    const offline = create({ dohUrl: 'https://dns.google:1/dns-query', dohTimeoutMs: 500, timeoutMs: 3000 })
    try { await offline.fetch({ url: url.href }) } catch (error) {
      if (error.code === 'WEB_PROVIDER_ERROR') return error.code
      throw error
    }
    throw new Error('fetch succeeded despite unavailable DoH')
  })
} else {
  results.push({ name: 'TUN public fetch and unavailable DoH', status: 'unverified', detail: `System DNS does not currently return only fake-IPs from ${pools.join(', ')}. Enable TUN fake-IP, or set DSH_TUN_FAKEIP_CIDRS to your proxy's pools, and rerun explicitly.` })
}
for (const item of providers) item.dispose()
const report = { time: new Date().toISOString(), url: url.href, pools, addresses, tunReady, results }
const directory = fileURLToPath(new URL('../artifacts/', import.meta.url))
await mkdir(directory, { recursive: true })
await writeFile(`${directory}/tun-report.json`, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
