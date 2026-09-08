const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const sandbox = { window: {}, performance, setTimeout, clearTimeout, ArrayBuffer, Uint8Array, Blob, URL };
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

test('direct pipeline keeps at most four blocks awaiting acknowledgement and respects frame limit', async () => {
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
  while (acknowledgements.length < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(acknowledgements.length, 4);
  assert.equal(sent, 4 * 64 * 1024);
  while (!finished && Date.now() < deadline) {
    acknowledgements.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(finished, true);
  await sending;
  assert.equal(sent, 6 * 1024 * 1024);
  assert.equal(frames, 384);
  assert.equal(peak, 4);
});
