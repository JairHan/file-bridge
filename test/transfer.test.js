const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const sandbox = { window: {}, performance, setTimeout, clearTimeout, ArrayBuffer, Uint8Array, Blob, URL, console };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/transfer.js'), 'utf8'), sandbox);
const Transport = sandbox.window.FileTransport;
function create() {
  return new Transport({ on() {} }, { route() {}, receiveProgress() {}, received() {} });
}
class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 8 * 1024 * 1024;
  bufferedAmountLowThreshold = 512 * 1024;
}

test('backpressure waits for drain and responds to cancel / channel close', async () => {
  const transport = create();
  const dc = new Channel();
  let done = false;
  const waiting = transport.waitForBuffer(dc, new AbortController().signal).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  dc.bufferedAmount = 0;
  dc.dispatchEvent(new Event('bufferedamountlow'));
  await waiting;
  dc.bufferedAmount = 8 * 1024 * 1024;
  const controller = new AbortController();
  const cancelled = transport.waitForBuffer(dc, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /取消/);
  const disconnected = transport.waitForBuffer(dc, new AbortController().signal);
  dc.readyState = 'closed';
  dc.dispatchEvent(new Event('close'));
  await assert.rejects(disconnected, /断开/);
});

test('direct pipeline bounds blocks in flight and respects the frame limit', async () => {
  const transport = create();
  const acknowledgements = [];
  let frames = 0;
  let sent = 0;
  let pending = 0;
  let peak = 0;
  transport.dc = { readyState: 'open', bufferedAmount: 0, send(data) {
    assert.ok(data.byteLength <= 16384);
    assert.ok(data instanceof ArrayBuffer);
    frames++;
    sent += data.byteLength;
  } };
  transport.pc = { sctp: { maxMessageSize: 16384 } };
  transport.request = () => {
    pending++;
    peak = Math.max(peak, pending);
    const bytes = sent;
    return new Promise(resolve => acknowledgements.push(() => { pending--; resolve({ bytes }); }));
  };
  let finished = false;
  const sending = transport.sendDirect(new Blob([new Uint8Array(6 * 1024 * 1024)]), () => {}, new AbortController().signal)
    .then(() => { finished = true; });
  const deadline = Date.now() + 3000;
  while (acknowledgements.length < 16 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(acknowledgements.length, 16);
  assert.equal(sent, 16 * 256 * 1024);
  assert.equal(peak, 16);
  while (!finished && Date.now() < deadline) {
    acknowledgements.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(finished, true);
  await sending;
  assert.equal(sent, 6 * 1024 * 1024);
  assert.equal(frames, 384);
});

test('offer/answer and candidates flow both ways; mDNS candidates get a literal fallback', async () => {
  class FakeChannel {
    constructor() { this.readyState = 'connecting'; }
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  }
  class FakePC {
    constructor() { this.iceCandidates = []; FakePC.instances.push(this); }
    createDataChannel() { this.channel = new FakeChannel(); return this.channel; }
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(desc) { this.localDescription = { ...desc, toJSON: () => ({ type: desc.type, sdp: desc.sdp }) }; }
    async setRemoteDescription(desc) { this.remoteDescription = desc; }
    async addIceCandidate(candidate) { this.iceCandidates.push(candidate); }
    close() {}
  }
  FakePC.instances = [];
  const env = { window: { RTCPeerConnection: FakePC }, performance, setTimeout, clearTimeout, ArrayBuffer, Uint8Array, Blob, URL, RTCPeerConnection: FakePC, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/transfer.js'), 'utf8'), env);
  const T = env.window.FileTransport;
  class FakeSocket {
    constructor() { this.handlers = {}; this.other = null; }
    on(evt, fn) { (this.handlers[evt] ||= []).push(fn); }
    emit(evt, payload) { if (evt === 'rtc-signal' && this.other) for (const fn of this.other.handlers['rtc-signal'] || []) fn(payload); }
  }
  const sa = new FakeSocket();
  const sb = new FakeSocket();
  sa.other = sb; sb.other = sa;
  const hooks = { route() {}, receiveProgress() {}, received() {} };
  const a = new T(sa, hooks);
  const b = new T(sb, hooks);
  await Promise.all([a.start(true), b.start(false)]);
  await new Promise(resolve => setTimeout(resolve, 20));
  const [pa, pb] = FakePC.instances;
  assert.equal(pa.remoteDescription.type, 'answer');
  assert.equal(pb.remoteDescription.type, 'offer');

  const mdns = { candidate: 'candidate:1 1 udp 100 abc.local 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
  const expanded = a.expandCandidate(mdns, '192.168.3.20');
  assert.equal(expanded.length, 2);
  assert.equal(expanded[0], mdns);
  assert.match(expanded[1].candidate, /192\.168\.3\.20 5000 typ host/);
  assert.equal(a.expandCandidate(mdns, null).length, 1);
  assert.equal(a.expandCandidate({ candidate: 'candidate:1 1 udp 100 192.168.3.9 5000 typ host' }, '192.168.3.20').length, 1);
  a.close();
  b.close();
});
