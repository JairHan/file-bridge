const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { networkKey } = require('../discovery');

test('network grouping uses actual subnet and normalizes IPv4', () => {
  const interfaces = { en0: [{ internal: false, cidr: '192.168.4.10/23' }] };
  assert.equal(networkKey('192.168.5.20', interfaces), networkKey('192.168.4.30', interfaces));
  assert.notEqual(networkKey('192.168.6.20', interfaces), networkKey('192.168.4.30', interfaces));
  assert.equal(networkKey('::ffff:203.0.113.1', {}), networkKey('203.0.113.1', {}));
  assert.equal(networkKey('invalid', {}), null);
});

test('authenticated discovery, isolation, pairing and transfers', { timeout: 15000 }, async (t) => {
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'bridge-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['-e', `const {LoginGuard}=require('./login-guard');const issue=LoginGuard.prototype.issue;LoginGuard.prototype.issue=function(...args){const result=issue.apply(this,args);process.send(this.challenges.get(result.id).code);return result;};require('./server');`], {
    cwd: require('path').resolve(__dirname, '..'), env: { ...process.env, PORT: '0', ROOM_TTL_MS: '2000', AUTH_STATE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const clients = [];
  t.after(() => { clients.forEach(s => s.disconnect()); child.kill(); });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/0\.0\.0\.0:(\d+)/); if (match) resolve(match[1]); });
    child.on('exit', () => reject(new Error('test server exited')));
  });
  const url = `http://127.0.0.1:${port}`;
  const issued = once(child, 'message');
  const captcha = await fetch(`${url}/api/captcha`);
  const code = (await issued)[0];
  const challengeCookie = captcha.headers.get('set-cookie').split(';')[0];
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: challengeCookie }, body: JSON.stringify({ password: code }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function connect(ip, authenticated = true) {
    const s = io(url, { autoConnect: false, transports: ['websocket'], extraHeaders: { 'X-Forwarded-For': ip, ...(authenticated ? { Cookie: cookie } : {}) } });
    clients.push(s);
    const ready = once(s, authenticated ? 'connect' : 'connect_error');
    s.connect(); await ready;
    return s;
  }
  const a = await connect('203.0.113.10');
  const listing = new Promise(resolve => a.on('nearby-devices', data => { if (data.devices.length) resolve([data]); }));
  const b = await connect('203.0.113.10');
  assert.equal((await listing)[0].devices[0].id, b.id);
  const c = await connect('198.51.100.20');
  assert.equal((await c.emitWithAck('connect-nearby', a.id)).ok, false);
  const unauth = await connect('203.0.113.10', false);
  assert.equal(unauth.connected, false);
  const pairedA = once(a, 'nearby-connected');
  const pairedB = once(b, 'nearby-connected');
  assert.equal((await a.emitWithAck('connect-nearby', b.id)).ok, true);
  assert.equal((await pairedA)[0].code, (await pairedB)[0].code);
  assert.equal((await c.emitWithAck('connect-nearby', a.id)).ok, false);
  assert.match((await c.emitWithAck('file-packet', { kind: 'begin', size: 1 })).error, /尚未连接/);
  const signal = once(b, 'rtc-signal');
  a.emit('rtc-signal', { description: { type: 'offer', sdp: 'test-signal' } });
  assert.equal((await signal)[0].description.sdp, 'test-signal');
  b.on('file-packet', (packet, ack) => ack({ bytes: packet.data?.length || 0 }));
  assert.equal((await a.emitWithAck('file-packet', { kind: 'data', data: Buffer.alloc(256 * 1024) })).bytes, 256 * 1024);
  assert.match((await a.emitWithAck('file-packet', { kind: 'data', data: Buffer.alloc(256 * 1024 + 1) })).error, /分块过大/);
  assert.match((await a.emitWithAck('file-packet', { kind: 'begin', size: 1024 ** 3 })).error, /大小限制/);
  const text = once(b, 'text-message');
  assert.equal((await a.emitWithAck('send-text', { text: 'hello LAN' })).ok, true);
  assert.equal((await text)[0].text, 'hello LAN');
  const file = once(a, 'file-message');
  assert.equal((await b.emitWithAck('send-file', { name: 'test.txt', size: 3, data: Buffer.from('abc') })).ok, true);
  assert.equal(Buffer.from((await file)[0].data).toString(), 'abc');
  const left = once(a, 'peer-status');
  b.emit('leave-room');
  assert.equal((await left)[0].connected, false);
  assert.equal((await a.emitWithAck('send-text', { text: 'blocked' })).ok, false);
  const room = await b.emitWithAck('create-room');
  assert.match(room.code, /^\d{4}$/);
  const joined = await c.emitWithAck('join-room', room.code);
  assert.equal(joined.ok, true);
  assert.equal((await c.emitWithAck('join-room', room.code)).ok, false);
  b.disconnect();
  c.disconnect();
  const restoredB = await connect('203.0.113.10');
  const restoredC = await connect('198.51.100.20');
  assert.equal((await restoredB.emitWithAck('resume-room', { code: room.code, resumeToken: 'invalid' })).ok, false);
  assert.equal((await restoredB.emitWithAck('resume-room', room)).ok, true);
  assert.equal((await restoredC.emitWithAck('resume-room', joined)).connected, true);
  const restoredText = once(restoredC, 'text-message');
  assert.equal((await restoredB.emitWithAck('send-text', { text: 'after refresh' })).ok, true);
  assert.equal((await restoredText)[0].text, 'after refresh');
  await restoredB.emitWithAck('leave-room');
  assert.equal((await restoredB.emitWithAck('resume-room', room)).ok, false);
  restoredC.disconnect();
  await new Promise(resolve => setTimeout(resolve, 2100));
  const expired = await connect('198.51.100.20');
  assert.equal((await expired.emitWithAck('resume-room', joined)).ok, false);
});
