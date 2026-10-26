import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

// Verify the packed plugin against the DSH runtimes it declares support for.
// Each runtime is installed into its own throwaway consumer project, so the
// plugin's peer imports resolve to that runtime's packages (not the repo's
// devDependencies). DSH 0.2.0 checks peers; 0.2.1 checks engines.dsh.
const root = fileURLToPath(new URL('../', import.meta.url))
const { name, version, peerDependencies, dependencies, engines } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const tarball = resolve(process.argv[2] ?? join(root, `artifacts/${name}-${version}.tgz`))

const runtimes = [
  { dsh: '0.2.0-rc.2', cordis: '4.0.4' },
  { dsh: '0.2.1-rc.2', cordis: '4.0.5' },
  { dsh: '0.2.1-rc.3', cordis: '4.0.5' },
]

const dshRange = '>=0.2.0-rc.2 <=0.2.1 || 0.2.1-rc.2 || 0.2.1-rc.3'
assert.equal(engines?.dsh, dshRange, 'engines.dsh must explicitly include tested 0.2.1 prereleases')
for (const [name, range] of Object.entries(peerDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, dshRange, name + ' must match engines.dsh')
}
assert(peerDependencies['@deepseek-ai/dsh-web-fetch-http'], 'dsh-web-fetch-http must be a peer so the host supplies it')
assert(!dependencies?.['@deepseek-ai/dsh-web-fetch-http'], 'dsh-web-fetch-http must not be a bundled dependency')

function run(command, args, cwd, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)))
  })
}

const checkSource = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import { WebError, WebRuntime } from '@deepseek-ai/dsh-web'
import * as plugin from 'dsh-fakeip-safe-fetch'

const require = createRequire(import.meta.url)
const versionOf = name => require(name + '/package.json').version
const expected = JSON.parse(process.env.COMPAT_RUNTIME)
for (const name of Object.keys(expected)) {
  assert.equal(versionOf(name), expected[name], name + ' must resolve to the host runtime copy')
}
assert.equal(require('dsh-fakeip-safe-fetch/package.json').dependencies?.['@deepseek-ai/dsh-web-fetch-http'], undefined)

const ctx = new Context()
await ctx.plugin(WebRuntime, { fetchProvider: 'fakeip-safe' })
const fiber = await ctx.plugin(plugin, { maxValidationTtlMs: 0 })
const blocked = await ctx.web.fetch({ url: 'http://127.0.0.1/' }).then(() => undefined, error => error)
assert(blocked instanceof WebError, 'the provider must throw the host runtime WebError class')
assert.equal(blocked.code, 'WEB_BLOCKED_URL')
await fiber.dispose()
await assert.rejects(ctx.web.fetch({ url: 'https://example.com/' }), { code: 'WEB_PROVIDER_CONFIGURED_MISSING' })
await ctx.fiber.dispose()
console.log('runtime check passed')
`

await mkdir(join(root, 'artifacts'), { recursive: true })
const report = { time: new Date().toISOString(), node: process.version, tarball, runtimes: [] }
try {
  for (const runtime of runtimes) {
    const dir = join(root, '.test-profile', `compat-${runtime.dsh}`)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const deps = {
      [name]: `file:${tarball}`,
      '@deepseek-ai/cordis': runtime.cordis,
      '@deepseek-ai/dsh-llm': runtime.dsh,
      '@deepseek-ai/dsh-web': runtime.dsh,
      '@deepseek-ai/dsh-http-proxy': runtime.dsh,
      '@deepseek-ai/dsh-timeout': runtime.dsh,
      '@deepseek-ai/dsh-web-fetch-http': runtime.dsh,
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `compat-${runtime.dsh}`, private: true, type: 'module', dependencies: deps }, null, 2))
    await writeFile(join(dir, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n')
    await run('pnpm', ['install', '--ignore-scripts', '--strict-peer-dependencies'], dir)
    await writeFile(join(dir, 'check.mjs'), checkSource)
    const expected = {
      '@deepseek-ai/cordis': runtime.cordis,
      '@deepseek-ai/dsh-web': runtime.dsh,
      '@deepseek-ai/dsh-web-fetch-http': runtime.dsh,
      '@deepseek-ai/dsh-http-proxy': runtime.dsh,
      '@deepseek-ai/dsh-timeout': runtime.dsh,
    }
    await run(process.execPath, ['check.mjs'], dir, { COMPAT_RUNTIME: JSON.stringify(expected) })
    report.runtimes.push({ ...runtime, status: 'passed' })
    console.log(`✓ ${runtime.dsh} (cordis ${runtime.cordis})`)
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  process.exitCode = 1
} finally {
  await writeFile(join(root, 'artifacts/compat-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
