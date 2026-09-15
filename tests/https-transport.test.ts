import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:https'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import packet from 'dns-packet'
import { a, aaaa } from './helpers.js'

let directory: string
let server: Server
let base: string
const hits: string[] = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'fakeip-safe-tls-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
  server = createServer({ key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) }, async (req, res) => {
    hits.push(req.url!)
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    if (req.url === '/redirect') { res.writeHead(302, { location: '/dns-query' }); res.end(); return }
    if (req.url === '/wrong-type') { res.end('json'); return }
    if (req.url === '/oversize') { res.setHeader('content-type', 'application/dns-message'); res.end(Buffer.alloc(65536)); return }
    if (req.url === '/hang') return
    expect(req.method).toBe('POST')
    expect(req.headers['content-type']).toBe('application/dns-message')
    const query = packet.decode(Buffer.concat(chunks))
    const question = query.questions![0]!
    const body = packet.encode({ type: 'response', id: query.id, questions: query.questions, answers: [question.type === 'A' ? a(question.name) : aaaa(question.name)] })
    res.setHeader('content-type', 'application/dns-message')
    res.setHeader('age', '5')
    res.end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  server?.closeAllConnections()
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  if (directory) rmSync(directory, { recursive: true, force: true })
})

async function run(path: string, trusted = true, unsafeAmbientTls = false): Promise<Record<string, unknown>> {
  const moduleUrl = new URL('../lib/doh.js', import.meta.url).href
  const code = `import { DohClient } from ${JSON.stringify(moduleUrl)};
    try {
      const result = await new DohClient({ dohUrl: ${JSON.stringify(base + path)}, dohTimeoutMs: 150 }).validate('example.com', new AbortController().signal);
      console.log(JSON.stringify({ ok: true, addresses: result.addresses }));
    } catch (e) { console.log(JSON.stringify({ ok: false, code: e.code, message: e.message })); }`
  const env = { ...process.env }
  delete env.NODE_TLS_REJECT_UNAUTHORIZED
  delete env.NODE_EXTRA_CA_CERTS
  if (trusted) env.NODE_EXTRA_CA_CERTS = join(directory, 'cert.pem')
  if (unsafeAmbientTls) env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let errors = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { errors += String(chunk) })
  const [exitCode] = await once(child, 'close')
  expect(exitCode, errors).toBe(0)
  return JSON.parse(output)
}

it('performs binary A/AAAA POSTs over a verified TLS connection', async () => {
  const result = await run('/dns-query')
  expect(result.ok).toBe(true)
  expect(result.addresses).toHaveLength(2)
})
it('rejects untrusted TLS certificates', async () => expect((await run('/dns-query', false)).ok).toBe(false))
it('keeps TLS verification even if the ambient environment disables it', async () => expect((await run('/dns-query', false, true)).ok).toBe(false))
it('never follows HTTPS redirects', async () => {
  hits.length = 0
  expect((await run('/redirect')).ok).toBe(false)
  expect(hits).not.toContain('/dns-query')
})
it.each(['/wrong-type', '/oversize', '/hang'])('rejects DoH transport failure %s', async path => expect((await run(path)).ok).toBe(false))
