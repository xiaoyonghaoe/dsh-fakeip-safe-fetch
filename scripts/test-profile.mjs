import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../', import.meta.url))
const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const tarball = resolve(process.argv[2] ?? join(root, `artifacts/${name}-${version}.tgz`))
await mkdir(join(root, '.test-profile'), { recursive: true })
const work = await mkdtemp(join(root, '.test-profile/run-'))
const runtime = join(work, 'runtime')
const profile = join(work, 'home/profiles/smoke')
await mkdir(runtime, { recursive: true })
await mkdir(profile, { recursive: true })
const env = { ...process.env, DSH_HOME: join(work, 'home') }
for (const key of Object.keys(env)) if (key.startsWith('DSH_') && key !== 'DSH_HOME') delete env[key]
const report = { time: new Date().toISOString(), node: process.version, dsh: '0.1.5-rc.2', work, tarball, checks: [] }

function run(command, args, cwd = runtime, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] })
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} exited ${code}`)))
  })
}
try {
  report.sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'isolated-dsh-runtime', private: true, type: 'module', dependencies: { '@deepseek-ai/dsh': '0.1.5-rc.2' } }, null, 2))
  await writeFile(join(runtime, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n')
  await run('pnpm', ['install', '--ignore-scripts'])
  const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const dsh = (...args) => run(process.execPath, [cli, ...args])
  // Keep DSH expressions as inert strings; config dumps must not execute !!js.
  const dump = async () => parse(await run(process.execPath, [cli, '--profile', 'smoke', '--dump-config'], runtime, true), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  // A lower bundle explicitly disables fetch, so this proves installation re-enables it.
  const fixture = join(profile, 'defaults')
  await mkdir(fixture, { recursive: true })
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'smoke-defaults', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(fixture, 'cordis.patch.yml'), '- id: tool-web\n  config:\n    search: true\n    fetch: false\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-smoke', private: true, dependencies: { 'smoke-defaults': 'file:./defaults' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'smoke-defaults'], patchReload: 'startup' } } }, null, 2))
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await dsh('plugin', '--profile', 'smoke', 'add', tarball, '--ignore-scripts')
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert(manifest.dsh.profile.bundles.includes('dsh-fakeip-safe-fetch'))
  report.checks.push('CLI automatically adds dsh.bundle to the profile')
  function rows(tree) {
    if (!Array.isArray(tree)) return []
    return tree.flatMap(row => [row, ...rows(row.config), ...rows(row.children)])
  }
  const loaded = rows(await dump())
  assert.equal(loaded.find(row => row.id === 'web')?.config.fetchProvider, 'fakeip-safe')
  assert.equal(loaded.find(row => row.id === 'tool-web')?.config.fetch, true)
  assert.equal(loaded.filter(row => row.id === 'web-fetch-fakeip-safe').length, 1)
  report.checks.push('merged profile selects fakeip-safe and enables web_fetch')
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: web-fetch-fakeip-safe\n  config:\n    maxValidationTtlMs: 0\n')
  const overridden = rows(await dump()).find(row => row.id === 'web-fetch-fakeip-safe')
  assert.deepEqual(overridden.config, { maxValidationTtlMs: 0 })
  report.checks.push('profile override replaces config rather than deep-merging')
  // Load the installed tarball with the real Cordis service, without launching model/UI services.
  const runtimeCheck = `import { Context } from '@deepseek-ai/cordis';
    import { WebRuntime } from '@deepseek-ai/dsh-web';
    import * as plugin from 'dsh-fakeip-safe-fetch';
    import assert from 'node:assert/strict';
    const ctx = new Context();
    await ctx.plugin(WebRuntime, { fetchProvider: 'fakeip-safe' });
    const fiber = await ctx.plugin(plugin, { maxValidationTtlMs: 0 });
    await assert.rejects(ctx.web.fetch({ url: 'http://127.0.0.1/' }), { code: 'WEB_BLOCKED_URL' });
    await fiber.dispose();
    await assert.rejects(ctx.web.fetch({ url: 'https://example.com/' }), { code: 'WEB_PROVIDER_CONFIGURED_MISSING' });
    await ctx.fiber.dispose();`
  await writeFile(join(profile, 'check.mjs'), runtimeCheck)
  await run(process.execPath, ['check.mjs'], profile)
  report.checks.push('installed package registers, fills defaults and disposes in real Cordis')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await dsh('plugin', '--profile', 'smoke', 'remove', 'dsh-fakeip-safe-fetch')
  const removed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert(!removed.dsh.profile.bundles.includes('dsh-fakeip-safe-fetch'))
  const uninstalled = rows(await dump())
  assert(!uninstalled.some(row => row.id === 'web-fetch-fakeip-safe'))
  assert.equal(uninstalled.find(row => row.id === 'tool-web')?.config.fetch, false)
  report.checks.push('CLI uninstall removes the bundle and provider row')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  process.exitCode = 1
} finally {
  await mkdir(join(root, 'artifacts'), { recursive: true })
  await writeFile(join(root, 'artifacts/profile-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
