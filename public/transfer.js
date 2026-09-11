/* Ordered, acknowledged file blocks. File bytes use WebRTC when available. */
function formatLimit(bytes) {
  if (bytes >= 1024 ** 3) return `${bytes % (1024 ** 3) ? (bytes / 1024 ** 3).toFixed(1) : bytes / 1024 ** 3} GiB`;
  return `${Math.floor(bytes / 1024 / 1024)} MB`;
}

class FileTransport {
  constructor(socket, hooks) {
    this.socket = socket;
    this.hooks = hooks;
    this.pending = new Map();
    // Device-to-device limit; these bytes never reach the server.
    this.limit = 1024 ** 3;
    // Server-relayed limit, supplied by the server and lower by default.
    this.relayLimit = 1024 ** 3;
    socket.on('rtc-start', ({ initiator }) => this.start(initiator));
    socket.on('rtc-signal', data => this.signal(data).catch(() => this.close()));
    socket.on('file-packet', (packet, ack) => {
      try { ack(this.receive(packet, 'relay')); } catch (e) { ack({ error: e.message }); }
    });
  }
  setLimits({ direct, relay } = {}) {
    if (Number.isSafeInteger(direct) && direct > 0) this.limit = direct;
    if (Number.isSafeInteger(relay) && relay > 0) this.relayLimit = relay;
  }
  close() {
    clearTimeout(this.receiveTimer);
    this.receiveTimer = null;
    this.pc?.close();
    this.pc = null;
    this.dc = null;
    for (const done of this.pending.values()) done({ error: '直传连接已断开' });
    this.pending.clear();
    if (this.incoming) this.hooks.receiveProgress(this.incoming, true);
    this.incoming = null;
    this.hooks.route('服务器转发');
  }
  async start(initiator) {
    this.close();
    if (!window.RTCPeerConnection) return;
    this.hooks.route('正在建立直传…');
    const pc = this.pc = new RTCPeerConnection({ iceServers: [] });
    this.candidates = [];
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('rtc-signal', { candidate: candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && ['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.close();
    };
    pc.ondatachannel = ({ channel }) => this.attach(channel);
    setTimeout(() => { if (this.pc === pc && this.dc?.readyState !== 'open') this.close(); }, 8000);
    try {
      if (initiator) {
        this.attach(pc.createDataChannel('files'));
        await pc.setLocalDescription(await pc.createOffer());
        if (this.pc === pc) this.socket.emit('rtc-signal', { description: pc.localDescription.toJSON() });
      }
    } catch { if (this.pc === pc) this.close(); }
  }
  async signal({ description, candidate }) {
    const pc = this.pc;
    if (!pc) return;
    if (description) {
      await pc.setRemoteDescription(description);
      for (const item of this.candidates.splice(0)) await pc.addIceCandidate(item);
      if (description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        this.socket.emit('rtc-signal', { description: pc.localDescription.toJSON() });
      }
    } else if (candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else this.candidates.push(candidate);
    }
  }
  attach(dc) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = () => this.hooks.route('设备直传 · 不经过服务器');
    dc.onclose = () => { if (this.dc === dc) this.close(); };
    dc.onmessage = ({ data }) => {
      try {
        if (typeof data !== 'string') { this.receive({ kind: 'data', data }, 'direct'); return; }
        const packet = JSON.parse(data);
        if (packet.reply) { this.pending.get(packet.reply)?.(packet); return; }
        let result;
        try { result = this.receive(packet, 'direct'); } catch (e) { result = { error: e.message }; }
        dc.send(JSON.stringify({ ...result, reply: packet.request }));
      } catch { this.close(); }
    };
  }
  receive(packet, route = 'relay') {
    // Avoid allocating/clearing a timer for every binary frame.
    this.lastReceivedAt = performance.now();
    if (!this.receiveTimer) {
      const checkIdle = () => {
        if (this.incoming && performance.now() - this.lastReceivedAt < 45000) {
          this.receiveTimer = setTimeout(checkIdle, 5000);
        } else {
          if (this.incoming) this.hooks.receiveProgress(this.incoming, true);
          this.incoming = null;
          this.receiveTimer = null;
        }
      };
      this.receiveTimer = setTimeout(checkIdle, 5000);
    }
    if (packet.kind === 'begin') {
      if (this.incoming) throw new Error('接收端正在接收另一个文件');
      const limit = route === 'direct' ? this.limit : this.relayLimit;
      if (!Number.isSafeInteger(packet.size) || packet.size < 1 || packet.size > limit) throw new Error('文件大小超出接收限制');
      this.incoming = { name: String(packet.name).slice(0, 255), type: String(packet.type).slice(0, 120), size: packet.size, bytes: 0, parts: [], started: performance.now() };
      this.hooks.receiveProgress(this.incoming);
      return {};
    }
    const file = this.incoming;
    if (packet.kind === 'cancel') {
      if (file) this.hooks.receiveProgress(file, true);
      this.incoming = null;
      return {};
    }
    if (!file) throw new Error('接收任务不存在');
    if (packet.kind === 'data') {
      const data = packet.data;
      if (!(data instanceof ArrayBuffer) || data.byteLength > 256 * 1024 || file.bytes + data.byteLength > file.size) throw new Error('文件分块无效');
      file.parts.push(data);
      file.bytes += data.byteLength;
      const now = performance.now();
      if (!file.lastProgressAt || now - file.lastProgressAt >= 200 || file.bytes === file.size) {
        file.lastProgressAt = now;
        this.hooks.receiveProgress(file);
      }
    }
    if (packet.kind === 'end') {
      if (file.bytes !== file.size) throw new Error('文件不完整');
      const blob = new Blob(file.parts, { type: file.type });
      this.hooks.received(file, URL.createObjectURL(blob));
      this.incoming = null;
    }
    return { bytes: file.bytes };
  }
  async request(packet, direct) {
    let result;
    if (direct) {
      const dc = this.dc;
      if (dc?.readyState !== 'open') throw new Error('直传连接已断开，请重试');
      result = await new Promise((resolve, reject) => {
        const request = `${Date.now()}-${Math.random()}`;
        const timer = setTimeout(() => { this.pending.delete(request); reject(new Error('接收端响应超时')); }, 30000);
        this.pending.set(request, value => { clearTimeout(timer); this.pending.delete(request); resolve(value); });
        try { dc.send(JSON.stringify({ ...packet, request })); }
        catch (e) { clearTimeout(timer); this.pending.delete(request); reject(e); }
      });
    } else {
      result = await this.socket.timeout(30000).emitWithAck('file-packet', packet);
    }
    if (!result || result.error) throw new Error(result?.error || '传输失败');
    return result;
  }
  async waitForBuffer(dc, signal) {
    if (signal.aborted) throw new Error('已取消传输');
    if (dc.readyState !== 'open') throw new Error('直传连接已断开');
    if (dc.bufferedAmount <= 1024 * 1024) return;
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        dc.removeEventListener('bufferedamountlow', drained);
        dc.removeEventListener('close', closed);
        dc.removeEventListener('error', closed);
        signal.removeEventListener('abort', aborted);
        error ? reject(error) : resolve();
      };
      const drained = () => finish();
      const closed = () => finish(new Error('直传连接已断开'));
      const aborted = () => finish(new Error('已取消传输'));
      const timer = setTimeout(() => finish(new Error('发送缓冲区超时，请重试')), 30000);
      dc.addEventListener('bufferedamountlow', drained, { once: true });
      dc.addEventListener('close', closed, { once: true });
      dc.addEventListener('error', closed, { once: true });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      else if (dc.readyState !== 'open') closed();
      else if (dc.bufferedAmount <= dc.bufferedAmountLowThreshold) drained();
    });
  }
  async sendDirect(file, report, signal) {
    const dc = this.dc;
    const blockSize = 64 * 1024;
    const maximum = this.pc?.sctp?.maxMessageSize;
    const frameSize = Math.min(16 * 1024, maximum > 0 ? maximum : 16 * 1024);
    const confirmations = [];
    let failure;
    // At most two read blocks, bounded SCTP buffering and four unconfirmed 64 KiB blocks.
    const read = offset => file.slice(offset, offset + blockSize).arrayBuffer()
      .then(data => ({ data }), error => ({ error }));
    let nextRead = read(0);
    {
      for (let offset = 0; offset < file.size; offset += blockSize) {
        if (signal.aborted) throw new Error('已取消传输');
        if (failure) throw failure;
        const result = await nextRead;
        if (result.error) throw result.error;
        const data = result.data;
        nextRead = offset + blockSize < file.size ? read(offset + blockSize) : null;
        for (let pos = 0; pos < data.byteLength; pos += frameSize) {
          if (signal.aborted) throw new Error('已取消传输');
          if (dc.readyState !== 'open' || dc.bufferedAmount > 1024 * 1024) await this.waitForBuffer(dc, signal);
          if (failure) throw failure;
          // Keep frames small for browser SCTP interoperability.
          dc.send(data.slice(pos, pos + frameSize));
        }
        // Pipeline receiver confirmations instead of stopping after every block.
        confirmations.push(this.request({ kind: 'block' }, true)
          .then(result => report(result.bytes), error => { failure = error; }));
        if (confirmations.length >= 4) await confirmations.shift();
      }
      await Promise.all(confirmations);
      if (failure) throw failure;
      if (signal.aborted) throw new Error('已取消传输');
    }
  }
  async send(file, progress, signal) {
    while (this.pc && this.dc?.readyState !== 'open') {
      if (signal.aborted) throw new Error('已取消传输');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const direct = this.dc?.readyState === 'open';
    const route = direct ? '设备直传' : '服务器转发';
    const routeLimit = direct ? this.limit : this.relayLimit;
    if (file.size > routeLimit) {
      throw new Error(direct
        ? `文件超过设备直传上限 ${formatLimit(this.limit)}`
        : `文件超过服务器转发上限（${formatLimit(this.relayLimit)}），且未建立设备直传`);
    }
    const started = performance.now();
    let lastProgress = started;
    let acknowledged = 0;
    let reporting = true;
    const report = bytes => {
      if (!reporting) return;
      acknowledged = Math.max(acknowledged, bytes);
      const now = performance.now();
      if (now - lastProgress >= 200 || acknowledged === file.size) {
        lastProgress = now;
        progress(acknowledged, started, route);
      }
    };
    progress(0, started, route);
    let begun = false;
    try {
      if (signal.aborted) throw new Error('已取消传输');
      await this.request({ kind: 'begin', name: file.name, type: file.type, size: file.size }, direct);
      begun = true;
      if (direct) await this.sendDirect(file, report, signal);
      else {
        for (let offset = 0; offset < file.size; offset += 256 * 1024) {
          if (signal.aborted) throw new Error('已取消传输');
          const data = await file.slice(offset, offset + 256 * 1024).arrayBuffer();
          if (signal.aborted) throw new Error('已取消传输');
          const result = await this.request({ kind: 'data', data }, false);
          report(result.bytes);
        }
      }
      if (signal.aborted) throw new Error('已取消传输');
      await this.request({ kind: 'end' }, direct);
      report(file.size);
    } catch (e) {
      if (begun) this.request({ kind: 'cancel' }, direct).catch(() => {});
      throw e;
    } finally { reporting = false;  }
  }
}
window.FileTransport = FileTransport;
