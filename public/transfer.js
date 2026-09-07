/* Ordered, acknowledged file blocks. File bytes use WebRTC when available. */
class FileTransport {
  constructor(socket, hooks) {
    this.socket = socket;
    this.hooks = hooks;
    this.pending = new Map();
    this.limit = 1024 ** 3;
    socket.on('rtc-start', ({ initiator }) => this.start(initiator));
    socket.on('rtc-signal', data => this.signal(data).catch(() => this.close()));
    socket.on('file-packet', (packet, ack) => {
      try { ack(this.receive(packet)); } catch (e) { ack({ error: e.message }); }
    });
  }
  close() {
    clearTimeout(this.receiveTimer);
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
    dc.onopen = () => this.hooks.route('设备直传 · 不经过服务器');
    dc.onclose = () => { if (this.dc === dc) this.close(); };
    dc.onmessage = ({ data }) => {
      try {
        if (typeof data !== 'string') { this.receive({ kind: 'data', data }); return; }
        const packet = JSON.parse(data);
        if (packet.reply) { this.pending.get(packet.reply)?.(packet); return; }
        let result;
        try { result = this.receive(packet); } catch (e) { result = { error: e.message }; }
        dc.send(JSON.stringify({ ...result, reply: packet.request }));
      } catch { this.close(); }
    };
  }
  receive(packet) {
    clearTimeout(this.receiveTimer);
    this.receiveTimer = setTimeout(() => {
      if (this.incoming) this.hooks.receiveProgress(this.incoming, true);
      this.incoming = null;
    }, 45000);
    if (packet.kind === 'begin') {
      if (this.incoming) throw new Error('接收端正在接收另一个文件');
      if (!Number.isSafeInteger(packet.size) || packet.size < 1 || packet.size > this.limit) throw new Error('文件大小超出接收限制');
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
      this.hooks.receiveProgress(file);
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
  async send(file, progress, signal) {
    // Give an in-progress LAN handshake a chance before choosing the relay path.
    while (this.pc && this.dc?.readyState !== 'open') {
      if (signal.aborted) throw new Error('已取消传输');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const direct = this.dc?.readyState === 'open';
    const route = direct ? '设备直传' : '服务器转发';
    const started = performance.now();
    progress(0, started, route);
    let begun = false;
    try {
      await this.request({ kind: 'begin', name: file.name, type: file.type, size: file.size }, direct);
      begun = true;
      const blockSize = direct ? 1024 * 1024 : 256 * 1024;
      for (let offset = 0; offset < file.size; offset += blockSize) {
        if (signal.aborted) throw new Error('已取消传输');
        const data = await file.slice(offset, offset + blockSize).arrayBuffer();
        if (signal.aborted) throw new Error('已取消传输');
        let result;
        if (direct) {
          // At most one 1 MiB block is queued; 16 KiB frames fit browser SCTP limits.
          for (let pos = 0; pos < data.byteLength; pos += 16384) this.dc.send(data.slice(pos, pos + 16384));
          result = await this.request({ kind: 'block' }, true);
        } else result = await this.request({ kind: 'data', data }, false);
        progress(result.bytes, started, route);
      }
      if (signal.aborted) throw new Error('已取消传输');
      await this.request({ kind: 'end' }, direct);
    } catch (e) {
      if (begun) this.request({ kind: 'cancel' }, direct).catch(() => {});
      throw e;
    }
  }
}
window.FileTransport = FileTransport;
