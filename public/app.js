const socket = io({ transports: ['websocket', 'polling'] });

const $ = (id) => document.getElementById(id);
const pairView = $('pairView');
const chatView = $('chatView');
const createBtn = $('createBtn');
const joinForm = $('joinForm');
const codeInput = $('codeInput');
const pairTip = $('pairTip');
const roomCode = $('roomCode');
const peerBadge = $('peerBadge');
const messages = $('messages');
const textInput = $('textInput');
const sendBtn = $('sendBtn');
const fileInput = $('fileInput');
const filePreview = $('filePreview');
const leaveBtn = $('leaveBtn');
const statusText = $('statusText');
const logoutBtn = $('logoutBtn');
const lockBtn = $('lockBtn');

let transferController = null;
const transport = new FileTransport(socket, {
  route: text => { $('transferRoute').textContent = text; },
  receiveProgress: (file, cancelled = false) => {
    $('receiveProgress').textContent = cancelled ? '接收已中断' : `正在接收 ${file.name} · ${(file.bytes / file.size * 100).toFixed(1)}% · ${formatBytes(file.bytes)}`;
  },
  received: (file, url) => {
    $('receiveProgress').textContent = '文件接收完成';
    addFileMessage(file, false, url);
  }
});
let activeRoom = null;
let peerConnected = false;
let selectedFile = null;
let maxFileSize = 20 * 1024 * 1024;

function setTip(text, error = false) {
  pairTip.textContent = text;
  pairTip.style.color = error ? '#d70015' : '#8a8a8f';
}

function rememberRoom(res) {
  try { sessionStorage.setItem('file-bridge-room', JSON.stringify({ code: res.code, resumeToken: res.resumeToken })); } catch {}
}
function forgetRoom() {
  try { sessionStorage.removeItem('file-bridge-room'); } catch {}
}
function openChat(code) {
  activeRoom = code;
  roomCode.textContent = code.startsWith('nearby-') ? '免码连接' : code;
  document.querySelector('.room-label').textContent = code.startsWith('nearby-') ? '同网络设备' : '配对码';
  pairView.classList.add('hidden');
  chatView.classList.remove('hidden');
  setPeer(false);
  updateViewportHeight();
  if (matchMedia('(pointer: fine)').matches) textInput.focus({ preventScroll: true });
}

function setPeer(connected) {
  peerConnected = connected;
  if (!connected) { transferController?.abort(); transport.close(); }
  peerBadge.textContent = connected ? '已连接' : '等待另一台设备';
  peerBadge.className = `badge ${connected ? 'online' : 'waiting'}`;
  sendBtn.disabled = !connected || Boolean(transferController);
}

function showSystem(text) {
  const el = document.createElement('div');
  el.className = 'system-message';
  el.textContent = text;
  messages.appendChild(el);
  scrollBottom();
}

function scrollBottom() {
  messages.scrollTop = messages.scrollHeight;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function timeText(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setCopyIcon(button, copied = false) {
  // Static SVG only; message contents are never inserted into markup.
  button.innerHTML = copied
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7V5a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3h-2"/><rect x="3" y="7" width="13" height="14" rx="3"/></svg>';
  button.setAttribute('aria-label', copied ? '已复制' : '复制这条文字消息');
  button.title = copied ? '已复制' : '复制文字';
}

async function copyText(text, button) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      if (!copied) throw new Error('copy failed');
    }

    setCopyIcon(button, true);
    button.classList.add('copied');
    button.disabled = true;
    setTimeout(() => {
      setCopyIcon(button);
      button.classList.remove('copied');
      button.disabled = false;
    }, 1200);
  } catch {
    showSystem('复制失败，请手动选择文字复制');
  }
}

function addTextMessage(text, mine, sentAt = Date.now()) {
  const el = document.createElement('div');
  el.className = `message text-message ${mine ? 'mine' : 'theirs'}`;

  const content = document.createElement('div');
  content.className = 'text-content';
  content.textContent = text;

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeText(sentAt);
  meta.appendChild(time);

  if (!mine) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-btn';
    setCopyIcon(copyBtn);
    copyBtn.addEventListener('click', () => copyText(text, copyBtn));
    meta.appendChild(copyBtn);
  }

  el.append(content, meta);
  messages.appendChild(el);
  scrollBottom();
}

function addFileMessage(file, mine, blobUrl = null) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${mine ? 'mine' : 'theirs'}`;

  const content = document.createElement(blobUrl ? 'a' : 'div');
  content.className = blobUrl ? 'file-message download-link' : 'file-message';
  if (blobUrl) {
    content.href = blobUrl;
    content.download = file.name;
    content.title = '点击下载';
  }

  const icon = document.createElement('div');
  icon.className = 'file-icon';
  icon.textContent = '📄';

  const meta = document.createElement('div');
  meta.className = 'file-meta';
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = file.name;
  const size = document.createElement('div');
  size.className = 'file-size';
  size.textContent = `${formatBytes(file.size)}${blobUrl ? ' · 点击下载' : ''}`;
  meta.append(name, size);

  content.append(icon, meta);
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeText(file.sentAt || Date.now());
  wrapper.append(content, time);
  messages.appendChild(wrapper);
  scrollBottom();
}


async function logout() {
  forgetRoom();
  try {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin'
    });
  } finally {
    location.replace('/login');
  }
}

logoutBtn?.addEventListener('click', logout);
lockBtn?.addEventListener('click', logout);

createBtn.addEventListener('click', () => {
  createBtn.disabled = true;
  setTip('正在生成配对码…');
  socket.emit('create-room', (res) => {
    createBtn.disabled = false;
    if (!res?.ok) return setTip(res?.error || '生成失败', true);
    maxFileSize = res.maxFileSize || maxFileSize;
    rememberRoom(res);
    openChat(res.code);
    showSystem(`配对码 ${res.code} 已生成，请在另一台设备输入`);
  });
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 4);
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = codeInput.value.trim();
  socket.emit('join-room', code, (res) => {
    if (!res?.ok) return setTip(res?.error || '加入失败', true);
    maxFileSize = res.maxFileSize || maxFileSize;
    rememberRoom(res);
    openChat(res.code);
    setPeer(Boolean(res.connected));
    showSystem(res.connected ? '已连接另一台设备' : '已加入会话，等待另一台设备重连');
  });
});

sendBtn.addEventListener('click', sendCurrent);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});
textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = `${Math.min(textInput.scrollHeight, 120)}px`;
});

function sendCurrent() {
  if (!peerConnected || transferController) return;
  if (selectedFile) return sendSelectedFile();
  const text = textInput.value.trim();
  if (!text) return;
  sendBtn.disabled = true;
  socket.emit('send-text', { text }, (res) => {
    sendBtn.disabled = !peerConnected;
    if (!res?.ok) return showSystem(res?.error || '发送失败');
    addTextMessage(text, true, res.message?.sentAt);
    textInput.value = '';
    textInput.style.height = 'auto';
  });
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  if (file.size > transport.limit) {
    showSystem(`文件过大，当前限制 ${formatBytes(transport.limit)}`);
    fileInput.value = '';
    return;
  }
  selectedFile = file;
  filePreview.classList.remove('hidden');
  filePreview.innerHTML = '';
  const info = document.createElement('span');
  info.textContent = `${file.name} · ${formatBytes(file.size)}`;
  const cancel = document.createElement('button');
  cancel.textContent = '取消';
  cancel.onclick = clearSelectedFile;
  const progress = document.createElement('progress');
  progress.id = 'fileProgress';
  progress.max = 100;
  progress.value = 0;
  progress.setAttribute('aria-label', '对方已接收的文件进度');
  const detail = document.createElement('div');
  detail.id = 'fileProgressDetail';
  detail.className = 'file-progress-detail';
  detail.textContent = '等待发送';
  filePreview.append(info, cancel, progress, detail);
  sendBtn.textContent = '发送文件';
});

function clearSelectedFile() {
  if (transferController) { transferController.abort(); statusText.textContent = '正在取消…'; return; }
  selectedFile = null;
  fileInput.value = '';
  filePreview.classList.add('hidden');
  filePreview.innerHTML = '';
  sendBtn.textContent = '发送';
}

async function sendSelectedFile() {
  if (!selectedFile || !peerConnected || transferController) return;
  const file = selectedFile;
  const controller = transferController = new AbortController();
  sendBtn.disabled = true;
  fileInput.disabled = true;
  statusText.textContent = '正在发送，等待对方确认…';
  let completed = false;
  try {
    await transport.send(file, (bytes, started, route) => {
      const percent = bytes / file.size * 100;
      const speed = bytes / Math.max((performance.now() - started) / 1000, 0.01);
      $('fileProgress').value = percent;
      $('fileProgressDetail').textContent = `${route} · ${percent.toFixed(1)}% · ${formatBytes(bytes)} / ${formatBytes(file.size)} · ${formatBytes(speed)}/s`;
    }, controller.signal);
    addFileMessage({ name: file.name, size: file.size, sentAt: Date.now() }, true);
    statusText.textContent = '传输完成，对方已收到文件';
    completed = true;
  } catch (error) {
    statusText.textContent = error.message || '传输失败，请重试';
  } finally {
    transferController = null;
    fileInput.disabled = false;
    sendBtn.disabled = !peerConnected;
    if (completed || controller.signal.aborted) clearSelectedFile();
  }
}

leaveBtn.addEventListener('click', () => {
  forgetRoom();
  socket.timeout(3000).emit('leave-room', () => location.reload());
});

socket.on('nearby-devices', ({ self, devices }) => {
  $('localDevice').textContent = `本机：${self}`;
  const list = $('nearbyDevices');
  list.replaceChildren();
  if (!devices.length) list.textContent = '暂未发现可连接设备，等待另一台设备打开并登录…';
  for (const device of devices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nearby-device';
    button.textContent = `${device.name}　连接`;
    button.addEventListener('click', () => {
      if (!socket.connected) return setTip('连接已断开，请等待重连', true);
      button.disabled = true;
      socket.timeout(5000).emit('connect-nearby', device.id, (error, res) => {
        button.disabled = false;
        if (error || !res?.ok) setTip(res?.error || '连接超时，请重试', true);
      });
    });
    list.appendChild(button);
  }
});

socket.on('nearby-connected', ({ code, resumeToken, maxFileSize: limit }) => {
  rememberRoom({ code, resumeToken });
  maxFileSize = limit;
  openChat(code);
  setPeer(true);
  showSystem('已通过同网络设备发现建立连接，无需输入配对码');
});

socket.on('connect', () => {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('file-bridge-room')); } catch {}
  if (!saved?.resumeToken) return;
  setTip('正在恢复原会话…');
  socket.timeout(5000).emit('resume-room', saved, (error, res) => {
    if (error) { setTip('恢复会话超时，请刷新重试', true); return; }
    if (!res?.ok) {
      forgetRoom();
      activeRoom = null;
      setPeer(false);
      chatView.classList.add('hidden');
      pairView.classList.remove('hidden');
      updateViewportHeight();
      setTip(res?.error || '会话已过期，请重新配对', true);
      return;
    }
    rememberRoom(res);
    maxFileSize = res.maxFileSize;
    openChat(res.code);
    setPeer(res.connected);
    showSystem(res.connected ? '原会话已恢复' : '原会话已恢复，等待另一台设备重连');
  });
});

socket.on('peer-status', ({ connected }) => {
  setPeer(Boolean(connected));
  showSystem(connected ? '另一台设备已连接' : '另一台设备已断开');
});

socket.on('room-status', ({ peers }) => {
  if (peers > 0) setPeer(true);
});

socket.on('text-message', (message) => {
  addTextMessage(message.text, false, message.sentAt);
});

socket.on('file-message', (file) => {
  const blob = new Blob([file.data], { type: file.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  addFileMessage(file, false, url);
  showSystem(`收到文件：${file.name}`);
});

socket.on('disconnect', () => {
  $('nearbyDevices').textContent = '连接已断开，正在重新发现设备…';
  if (activeRoom) {
    setPeer(false);
    showSystem('与服务器连接断开，正在尝试重连…');
  }
});


socket.on('connect_error', (error) => {
  if (error?.message === 'unauthorized') {
    location.replace('/login');
  }
});

// Safari can pan the visual viewport independently when the keyboard opens.
// Track both its height and offset; resizing a document in normal flow is not enough.
let viewportFrame = 0;
function updateViewportHeight() {
  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight;
  const top = viewport?.offsetTop || 0;
  const root = document.documentElement;
  const chatting = !chatView.classList.contains('hidden');
  const nearBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 60;
  root.classList.toggle('chat-open', chatting);
  root.style.setProperty('--app-height', `${Math.round(height)}px`);
  root.style.setProperty('--app-top', `${Math.round(top)}px`);
  root.classList.toggle('keyboard-open', chatting && document.activeElement === textInput && window.innerHeight - height > 120);
  if (chatting && nearBottom) messages.scrollTop = messages.scrollHeight;
}
function scheduleViewportUpdate() {
  if (viewportFrame) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0;
    updateViewportHeight();
  });
}
updateViewportHeight();
window.addEventListener('resize', scheduleViewportUpdate, { passive: true });
window.addEventListener('orientationchange', scheduleViewportUpdate, { passive: true });
window.visualViewport?.addEventListener('resize', scheduleViewportUpdate, { passive: true });
window.visualViewport?.addEventListener('scroll', scheduleViewportUpdate, { passive: true });
textInput.addEventListener('focus', scheduleViewportUpdate);
textInput.addEventListener('blur', scheduleViewportUpdate);
