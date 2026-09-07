const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const proxyaddr = require('proxy-addr');
const { networkKey, deviceLabel } = require('./discovery');
const trustProxy = proxyaddr.compile(process.env.TRUST_PROXY || 'loopback');

const PORT = Number(process.env.PORT || 5000);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 20 * 1024 * 1024);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);

const { LoginGuard } = require('./login-guard');
const loginGuard = new LoginGuard(path.join(process.env.AUTH_STATE_DIR || path.join(__dirname, '.data'), 'login-attempts.json'));

const app = express();
app.set('trust proxy', trustProxy);
app.disable('x-powered-by');
app.use(express.json({ limit: '2kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: MAX_FILE_SIZE + 1024 * 1024
});

const COOKIE_NAME = 'file_bridge_session';
const sessions = new Map();

function parseCookies(cookieHeader = '') {
  const result = {};
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function getSessionToken(cookieHeader) {
  return parseCookies(cookieHeader)[COOKIE_NAME] || null;
}

function getValidSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;

  if (Date.now() - session.lastSeen > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }

  session.lastSeen = Date.now();
  return session;
}

function isAuthenticatedRequest(req) {
  return Boolean(getValidSession(getSessionToken(req.headers.cookie)));
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function getClientIp(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/login', (req, res) => {
  if (isAuthenticatedRequest(req)) return res.redirect('/');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/api/captcha', (req, res) => {
  const ip = getClientIp(req);
  const state = loginGuard.state(ip);
  res.setHeader('Cache-Control', 'no-store');
  if (state.lockedUntil > Date.now()) {
    const result = loginGuard.locked(state);
    res.setHeader('Retry-After', String(result.retryAfter));
    return res.status(429).json(result);
  }
  const challenge = loginGuard.issue(ip, parseCookies(req.headers.cookie).file_bridge_captcha);
  res.setHeader('Set-Cookie', `file_bridge_captcha=${challenge.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=300${req.secure ? '; Secure' : ''}`);
  res.type('svg').send(challenge.data);
});

app.post('/api/login', (req, res) => {
  const ip = getClientIp(req);
  const now = Date.now();
  const result = loginGuard.check(ip, req.body?.password, parseCookies(req.headers.cookie).file_bridge_captcha);
  res.setHeader('Cache-Control', 'no-store');
  if (!result.ok) {
    if (result.retryAfter) res.setHeader('Retry-After', String(result.retryAfter));
    return res.status(result.status).json(result);
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    createdAt: now,
    lastSeen: now,
    ip
  });
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = getSessionToken(req.headers.cookie);
  if (token) {
    sessions.delete(token);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.authToken === token) socket.disconnect(true);
    }
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (isAuthenticatedRequest(req)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: '请先登录' });
  }

  const acceptsHtml = req.accepts(['html', 'json']) === 'html';
  if (acceptsHtml) return res.redirect('/login');
  return res.status(401).end();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  index: 'index.html'
}));

// Rooms reserve each disconnected member for ROOM_TTL_MS.
const rooms = new Map();

function generateCode() {
  for (let i = 0; i < 100; i += 1) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

function roomSize(code) {
  return io.sockets.adapter.rooms.get(code)?.size || 0;
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  for (const [token, member] of room.members) {
    if (!member.socketId && Date.now() >= member.expiresAt) room.members.delete(token);
  }
  if (!room.members.size) rooms.delete(code);
}

function attachMember(socket, code) {
  const resumeToken = crypto.randomBytes(32).toString('hex');
  rooms.get(code).members.set(resumeToken, { authToken: socket.data.authToken, socketId: socket.id, expiresAt: null });
  socket.data.resumeToken = resumeToken;
  socket.data.roomCode = code;
  socket.join(code);
  return { ok: true, code, resumeToken, maxFileSize: MAX_FILE_SIZE, connected: roomSize(code) === 2 };
}

function reconnectPeers(socket, code) {
  if (roomSize(code) < 2) return;
  socket.to(code).emit('peer-status', { connected: true });
  socket.emit('rtc-start', { initiator: true });
  socket.to(code).emit('rtc-start', { initiator: false });
}

function roomPeerCount(code) {
  return Math.max(0, roomSize(code) - 1);
}

io.use((socket, next) => {
  const token = getSessionToken(socket.handshake.headers.cookie);
  if (!getValidSession(token)) {
    return next(new Error('unauthorized'));
  }
  socket.data.authToken = token;
  next();
});

function publishDevices() {
  const available = [...io.sockets.sockets.values()].filter((peer) =>
    !peer.data.roomCode && peer.data.networkKey && getValidSession(peer.data.authToken));
  for (const peer of available) {
    peer.emit('nearby-devices', {
      self: peer.data.deviceLabel,
      devices: available.filter((other) => other.id !== peer.id &&
        other.data.networkKey === peer.data.networkKey)
        .map((other) => ({ id: other.id, name: other.data.deviceLabel }))
    });
  }
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.networkKey = networkKey(proxyaddr(socket.request, trustProxy));
  socket.data.deviceLabel = `${deviceLabel(socket.handshake.headers['user-agent'])} · ${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  publishDevices();

  socket.use((_packet, next) => {
    if (!getValidSession(socket.data.authToken)) {
      socket.disconnect(true);
      return next(new Error('unauthorized'));
    }
    next();
  });

  socket.on('resume-room', (payload, ack = () => {}) => {
    const code = payload?.code;
    if (typeof code !== 'string' || socket.data.roomCode) return ack({ ok: false, error: '无法恢复会话' });
    cleanupRoom(code);
    const member = rooms.get(code)?.members.get(payload?.resumeToken);
    if (!member || member.authToken !== socket.data.authToken) return ack({ ok: false, error: '会话已过期或已退出，请重新配对' });
    if (member.socketId && member.socketId !== socket.id) {
      const old = io.sockets.sockets.get(member.socketId);
      if (old) { old.data.roomCode = null; old.leave(code); old.disconnect(true); }
    }
    member.socketId = socket.id;
    member.expiresAt = null;
    socket.data.roomCode = code;
    socket.data.resumeToken = payload.resumeToken;
    socket.join(code);
    ack({ ok: true, code, resumeToken: payload.resumeToken, maxFileSize: MAX_FILE_SIZE, connected: roomSize(code) === 2 });
    reconnectPeers(socket, code);
    publishDevices();
  });

  // Signalling and fallback blocks are restricted to the current paired peer.
  socket.on('rtc-signal', (payload) => {
    const code = socket.data.roomCode;
    if (!code || roomSize(code) !== 2 || JSON.stringify(payload || {}).length > 64000) return;
    socket.to(code).emit('rtc-signal', payload);
  });
  socket.on('file-packet', (packet, ack = () => {}) => {
    const code = socket.data.roomCode;
    if (!code || roomSize(code) !== 2) return ack({ error: '另一台设备尚未连接' });
    if (!packet || !['begin', 'data', 'end', 'cancel'].includes(packet.kind)) return ack({ error: '传输请求无效' });
    if (packet.kind === 'begin' && (!Number.isSafeInteger(packet.size) || packet.size < 1 || packet.size > MAX_FILE_SIZE)) return ack({ error: '文件超过服务器转发大小限制，请使用设备直传' });
    if (packet.kind === 'data' && (!Buffer.isBuffer(packet.data) || packet.data.length > 256 * 1024)) return ack({ error: '分块过大' });
    socket.to(code).timeout(25000).emit('file-packet', packet, (error, replies) => {
      ack(error ? { error: '接收端响应超时' } : replies[0]);
    });
  });

  socket.on('connect-nearby', (id, ack = () => {}) => {
    const peer = typeof id === 'string' ? io.sockets.sockets.get(id) : null;
    if (socket.data.roomCode || !peer || peer === socket || peer.data.roomCode ||
        !getValidSession(peer.data.authToken) || !socket.data.networkKey ||
        peer.data.networkKey !== socket.data.networkKey) {
      return ack({ ok: false, error: '设备已离线、正在会话中或不在同一网络，请重新选择' });
    }
    const code = `nearby-${crypto.randomUUID()}`;
    rooms.set(code, { hostId: socket.id, createdAt: Date.now(), members: new Map() });
    for (const member of [socket, peer]) {
      member.emit('nearby-connected', attachMember(member, code));
    }
    socket.emit('rtc-start', { initiator: true });
    peer.emit('rtc-start', { initiator: false });
    ack({ ok: true });
    publishDevices();
  });

  socket.on('create-room', (ack = () => {}) => {
    if (socket.data.roomCode) {
      ack({ ok: false, error: '你已经在一个会话中' });
      return;
    }

    const code = generateCode();
    if (!code) {
      ack({ ok: false, error: '暂时无法生成配对码，请重试' });
      return;
    }

    rooms.set(code, { hostId: socket.id, createdAt: Date.now(), members: new Map() });
    ack(attachMember(socket, code));
    publishDevices();
  });

  socket.on('join-room', (rawCode, ack = () => {}) => {
    if (socket.data.roomCode) return ack({ ok: false, error: '你已经在一个会话中' });
    const code = String(rawCode || '').trim();
    cleanupRoom(code);
    const room = rooms.get(code);

    if (!/^\d{4}$/.test(code)) {
      ack({ ok: false, error: '请输入 4 位数字配对码' });
      return;
    }
    if (!room) {
      ack({ ok: false, error: '配对码不存在或已失效' });
      return;
    }
    if (Date.now() - room.createdAt > ROOM_TTL_MS) {
      ack({ ok: false, error: '配对码已过期，请重新生成' });
      return;
    }
    if (room.members.size >= 2) {
      ack({ ok: false, error: '该会话已有两台设备连接' });
      return;
    }

    ack(attachMember(socket, code));
    publishDevices();
    socket.to(code).emit('peer-status', { connected: true });
    io.to(code).emit('room-status', { peers: roomPeerCount(code) });
    socket.emit('rtc-start', { initiator: true });
    socket.to(code).emit('rtc-start', { initiator: false });
  });

  socket.on('send-text', (payload, ack = () => {}) => {
    const code = socket.data.roomCode;
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!code || !rooms.has(code)) return ack({ ok: false, error: '当前未配对' });
    if (!text) return ack({ ok: false, error: '消息不能为空' });
    if (text.length > 10000) return ack({ ok: false, error: '单条文字不能超过 10000 字符' });
    if (roomSize(code) < 2) return ack({ ok: false, error: '另一台设备尚未连接' });

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      sentAt: Date.now()
    };
    socket.to(code).emit('text-message', message);
    ack({ ok: true, message });
  });

  socket.on('send-file', (payload, ack = () => {}) => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code)) return ack({ ok: false, error: '当前未配对' });
    if (roomSize(code) < 2) return ack({ ok: false, error: '另一台设备尚未连接' });

    const name = String(payload?.name || 'file').slice(0, 255);
    const type = String(payload?.type || 'application/octet-stream').slice(0, 120);
    const size = Number(payload?.size || 0);
    const data = payload?.data;

    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE) {
      return ack({ ok: false, error: `文件大小必须在 1B - ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB 之间` });
    }
    if (!data || typeof data.byteLength !== 'number' || data.byteLength !== size) {
      return ack({ ok: false, error: '文件数据不完整' });
    }

    const file = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      type,
      size,
      data,
      sentAt: Date.now()
    };

    socket.to(code).emit('file-message', file);
    ack({ ok: true, meta: { ...file, data: undefined } });
  });

  socket.on('leave-room', (ack = () => {}) => {
    const code = socket.data.roomCode;
    if (!code) return;
    rooms.get(code)?.members.delete(socket.data.resumeToken);
    socket.leave(code);
    socket.data.roomCode = null;
    socket.to(code).emit('peer-status', { connected: false });
    cleanupRoom(code);
    publishDevices();
    ack({ ok: true });
  });

  socket.on('disconnecting', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const member = rooms.get(code)?.members.get(socket.data.resumeToken);
    if (member?.socketId === socket.id) { member.socketId = null; member.expiresAt = Date.now() + ROOM_TTL_MS; }
    socket.to(code).emit('peer-status', { connected: false });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) { publishDevices(); return; }
    cleanupRoom(code);
    publishDevices();
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [code, room] of rooms) {
    cleanupRoom(code);
  }

  for (const [token, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) {
      sessions.delete(token);
      for (const socket of io.sockets.sockets.values()) {
        if (socket.data.authToken === token) socket.disconnect(true);
      }
    }
  }


}, 60_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`File Bridge running at http://0.0.0.0:${server.address().port}`);
  console.log(`Max file size: ${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}MB`);
  console.log('图片验证码已启用：连续输错 3 次锁定 1 小时');
});
