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
const folderInput = $('folderInput');
const filePreview = $('filePreview');
const filePreviewSummary = $('filePreviewSummary');
const filePreviewList = $('filePreviewList');
const clearFilesBtn = $('clearFilesBtn');
const leaveBtn = $('leaveBtn');
const statusText = $('statusText');
const logoutBtn = $('logoutBtn');
const lockBtn = $('lockBtn');

let transferController = null;
// 接收方当前正在接收的文件气泡，用于就地更新绿色进度。
let incomingFile = null;
const transport = new FileTransport(socket, {
  route: text => { $('transferRoute').textContent = text; },
  receiveProgress: (file, cancelled = false) => {
    if (cancelled) {
      if (incomingFile?.file === file) incomingFile.interrupt();
      incomingFile = null;
      $('receiveProgress').textContent = '接收已中断';
      return;
    }
    // 第一块数据到达时就创建气泡，而不是等文件收完。
    if (incomingFile?.file !== file) incomingFile = addProgressFileMessage(file);
    const percent = file.size ? Math.min(100, file.bytes / file.size * 100) : 0;
    incomingFile.setProgress(percent);
    $('receiveProgress').textContent = `正在接收 ${file.name} · ${percent.toFixed(1)}% · ${formatBytes(file.bytes)} / ${formatBytes(file.size)}`;
  },
  received: (file, url) => {
    $('receiveProgress').textContent = '文件接收完成';
    if (incomingFile?.file === file) {
      incomingFile.complete(url);
      incomingFile = null;
    } else {
      addFileMessage(file, false, url);
    }
  }
});
let activeRoom = null;
let peerConnected = false;
let selectedFiles = [];
// 系统生成的垃圾文件，加入发送队列时直接忽略。
const ignoredFileNames = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

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

// 接收方在收到第一块数据时立即显示气泡，并用绿色填充显示接收进度。
function addProgressFileMessage(file) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message file-progress-message theirs';

  const fill = document.createElement('div');
  fill.className = 'file-fill';

  const content = document.createElement('a');
  content.className = 'file-message';

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
  size.textContent = '接收中 · 0%';
  meta.append(name, size);
  content.append(icon, meta);

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = timeText(Date.now());
  wrapper.append(fill, content, time);
  messages.appendChild(wrapper);
  scrollBottom();

  return {
    file,
    setProgress(percent) {
      const clamped = Math.max(0, Math.min(100, percent));
      fill.style.width = `${clamped}%`;
      size.textContent = `接收中 · ${clamped.toFixed(1)}% · ${formatBytes(Math.round(file.size * clamped / 100))} / ${formatBytes(file.size)}`;
    },
    interrupt() {
      wrapper.classList.add('interrupted');
      size.textContent = '接收已中断';
    },
    complete(url) {
      fill.style.width = '100%';
      content.href = url;
      content.download = file.name;
      content.title = '点击下载';
      content.classList.add('download-link');
      wrapper.classList.add('complete');
      size.textContent = `${formatBytes(file.size)} · 点击下载`;
      scrollBottom();
    }
  };
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
    transport.setLimits({ relay: res.maxFileSize });
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
    transport.setLimits({ relay: res.maxFileSize });
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
  if (selectedFiles.length) return sendSelectedFiles();
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
  const files = [...fileInput.files];
  fileInput.value = '';
  addFiles(files.map(file => ({ file, relativePath: '', folder: '' })));
});

folderInput.addEventListener('change', () => {
  const files = [...folderInput.files];
  folderInput.value = '';
  addFiles(files.map(file => {
    const relativePath = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const slash = relativePath.indexOf('/');
    return { file, relativePath, folder: slash > 0 ? relativePath.slice(0, slash) : '' };
  }));
});

clearFilesBtn.addEventListener('click', clearSelectedFiles);

function addFiles(items) {
  if (transferController) { showSystem('正在传输文件，请等待完成后再添加'); return; }
  const folderTotals = new Map();
  for (const item of items) {
    if (item.folder) folderTotals.set(item.folder, (folderTotals.get(item.folder) || 0) + item.file.size);
  }
  const oversizedFolders = new Set(
    [...folderTotals].filter(([, total]) => total > transport.limit).map(([folder]) => folder));
  const accepted = [];
  const skipped = [];
  const reportedFolders = new Set();
  for (const item of items) {
    if (ignoredFileNames.has(item.file.name)) continue;
    const label = item.relativePath || item.file.name;
    if (oversizedFolders.has(item.folder)) {
      if (!reportedFolders.has(item.folder)) {
        reportedFolders.add(item.folder);
        skipped.push(`${item.folder}/`);
      }
      continue;
    }
    if (item.file.size > transport.limit) {
      skipped.push(label);
      continue;
    }
    accepted.push(item);
  }
  if (accepted.length) selectedFiles.push(...accepted);
  renderFilePreview();
  if (skipped.length) showSystem(`已跳过超过 ${formatBytes(transport.limit)} 的项目：${skipped.join('、')}`);
}

function renderFilePreview() {
  filePreviewList.replaceChildren();
  if (!selectedFiles.length) {
    filePreview.classList.add('hidden');
    filePreview.classList.remove('sending');
    $('fileProgress').value = 0;
    $('fileProgressDetail').textContent = '等待发送';
    sendBtn.textContent = '发送';
    return;
  }
  filePreview.classList.remove('hidden');
  const folders = new Set(selectedFiles.map(item => item.folder).filter(Boolean));
  const totalBytes = selectedFiles.reduce((sum, item) => sum + item.file.size, 0);
  const counts = [`${selectedFiles.length} 个文件`];
  if (folders.size) counts.push(`${folders.size} 个文件夹`);
  filePreviewSummary.textContent = `${counts.join(' · ')} · 共 ${formatBytes(totalBytes)}`;
  for (const item of selectedFiles) {
    const label = item.relativePath || item.file.name;
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'preview-name';
    name.textContent = label;
    name.title = label;
    const size = document.createElement('span');
    size.className = 'preview-size';
    size.textContent = formatBytes(item.file.size);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'preview-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除 ${label}`);
    remove.addEventListener('click', () => {
      if (transferController) return;
      selectedFiles = selectedFiles.filter(entry => entry !== item);
      renderFilePreview();
    });
    row.append(name, size, remove);
    filePreviewList.appendChild(row);
  }
  const sending = Boolean(transferController);
  filePreview.classList.toggle('sending', sending);
  clearFilesBtn.disabled = sending;
  sendBtn.textContent = selectedFiles.length > 1 ? `发送 ${selectedFiles.length} 个文件` : '发送文件';
}

function clearSelectedFiles() {
  if (transferController) { transferController.abort(); statusText.textContent = '正在取消…'; return; }
  selectedFiles = [];
  fileInput.value = '';
  folderInput.value = '';
  renderFilePreview();
}

function jobBytes(job) {
  return job.kind === 'zip'
    ? job.entries.reduce((sum, entry) => sum + entry.file.size, 0)
    : job.file.size;
}

// 散装文件逐个发送；文件夹合并为一个 ZIP，接收方解压后保留目录结构。
function planTransferJobs(items) {
  const jobs = [];
  const folders = new Map();
  for (const item of items) {
    if (!item.folder) {
      jobs.push({ kind: 'file', name: item.file.name, file: item.file, items: [item] });
      continue;
    }
    let group = folders.get(item.folder);
    if (!group) {
      group = { entries: [], items: [] };
      folders.set(item.folder, group);
      jobs.push({ kind: 'zip', name: `${item.folder}.zip`, entries: group.entries, items: group.items });
    }
    const path = (item.relativePath || item.file.name).replace(/\\/g, '/');
    if (path.split('/').includes('..')) continue;
    group.entries.push({ path, file: item.file });
    group.items.push(item);
  }
  return jobs.filter(job => job.kind === 'file' || job.entries.length);
}

async function sendSelectedFiles() {
  if (!selectedFiles.length || !peerConnected || transferController) return;
  const jobs = planTransferJobs(selectedFiles);
  if (!jobs.length) return;
  const controller = transferController = new AbortController();
  sendBtn.disabled = true;
  fileInput.disabled = true;
  folderInput.disabled = true;
  filePreview.classList.add('sending');
  clearFilesBtn.disabled = true;
  $('fileProgress').value = 0;
  $('fileProgressDetail').textContent = '等待发送';
  const totalBytes = jobs.reduce((sum, job) => sum + jobBytes(job), 0) || 1;
  const batchStarted = performance.now();
  let sentBytes = 0;
  let finished = false;
  try {
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      let payload = job.file;
      if (job.kind === 'zip') {
        statusText.textContent = `正在打包 ${job.name}…`;
        const blob = await window.ZipArchive.build(job.entries, (done, total) => {
          statusText.textContent = `正在打包 ${job.name} · ${Math.floor(done / total * 100)}%`;
        });
        if (controller.signal.aborted) throw new Error('已取消传输');
        payload = wrapZipPayload(blob, job.name);
      }
      statusText.textContent = `正在发送 ${index + 1}/${jobs.length}：${job.name}`;
      await transport.send(payload, (bytes, started, route) => {
        const overall = sentBytes + bytes;
        const elapsed = Math.max((performance.now() - batchStarted) / 1000, 0.01);
        $('fileProgress').value = overall / totalBytes * 100;
        $('fileProgressDetail').textContent = `${route} · ${index + 1}/${jobs.length} · ${(overall / totalBytes * 100).toFixed(1)}% · ${formatBytes(overall)} / ${formatBytes(totalBytes)} · ${formatBytes(overall / elapsed)}/s`;
      }, controller.signal);
      addFileMessage({ name: job.name, size: payload.size, sentAt: Date.now() }, true);
      sentBytes += payload.size;
      selectedFiles = selectedFiles.filter(item => !job.items.includes(item));
      renderFilePreview();
    }
    finished = true;
    statusText.textContent = jobs.length > 1 ? '传输完成，对方已收到全部文件' : '传输完成，对方已收到文件';
  } catch (error) {
    statusText.textContent = error.message || '传输失败，请重试';
  } finally {
    transferController = null;
    fileInput.disabled = false;
    folderInput.disabled = false;
    sendBtn.disabled = !peerConnected;
    clearFilesBtn.disabled = false;
    filePreview.classList.remove('sending');
    if (finished || controller.signal.aborted) clearSelectedFiles();
    else renderFilePreview();
  }
}

function wrapZipPayload(blob, name) {
  try {
    return new File([blob], name, { type: 'application/zip' });
  } catch {
    // 个别环境没有 File 构造器；Blob 直接补上名字属性。
    blob.name = name;
    return blob;
  }
}

// 拖拽文件 / 文件夹到聊天窗口加入发送队列；拖入纯文字则填入输入框。
let dragDepth = 0;
const dragHasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');

function collectDropRoots(dataTransfer) {
  const roots = [];
  const items = dataTransfer?.items;
  if (items?.length) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) roots.push(entry);
      else {
        const file = item.getAsFile();
        if (file) roots.push(file);
      }
    }
  } else if (dataTransfer?.files?.length) {
    roots.push(...dataTransfer.files);
  }
  return roots;
}

function readEntryFile(entry) {
  return new Promise(resolve => entry.file(file => resolve(file), () => resolve(null)));
}

// readEntries 每次最多返回 100 项，必须循环调用直到返回空数组。
function readEntryDirectory(entry) {
  return new Promise(resolve => {
    const reader = entry.createReader();
    const all = [];
    const step = () => reader.readEntries(batch => {
      if (batch.length) { all.push(...batch); step(); }
      else resolve(all);
    }, () => resolve(all));
    step();
  });
}

async function walkEntry(entry, parent, folderRoot, out) {
  if (entry.isFile) {
    if (ignoredFileNames.has(entry.name)) return;
    const file = await readEntryFile(entry);
    if (file) out.push({ file, relativePath: parent ? `${parent}/${entry.name}` : '', folder: folderRoot });
    return;
  }
  if (!entry.isDirectory) return;
  const path = parent ? `${parent}/${entry.name}` : entry.name;
  for (const child of await readEntryDirectory(entry)) {
    await walkEntry(child, path, folderRoot || entry.name, out);
  }
}

async function collectFromDrop(dataTransfer) {
  const out = [];
  for (const root of collectDropRoots(dataTransfer)) {
    if (root.isFile || root.isDirectory) await walkEntry(root, '', '', out);
    else out.push({ file: root, relativePath: '', folder: '' });
  }
  return out;
}

async function handleFileDrop(dataTransfer) {
  const collected = await collectFromDrop(dataTransfer);
  if (collected.length) addFiles(collected);
  else showSystem('拖入的内容中没有可发送的文件');
}

chatView.addEventListener('dragenter', (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  chatView.classList.add('drag-over');
});
chatView.addEventListener('dragover', (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
chatView.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) chatView.classList.remove('drag-over');
});
chatView.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  chatView.classList.remove('drag-over');
  if (dragHasFiles(event)) {
    void handleFileDrop(event.dataTransfer);
    return;
  }
  const text = event.dataTransfer?.getData('text/plain');
  if (text) {
    textInput.value = textInput.value
      ? `${textInput.value}\n${text}`.slice(0, 10000)
      : text.slice(0, 10000);
    textInput.dispatchEvent(new Event('input'));
    textInput.focus({ preventScroll: true });
  }
});

// 拖到窗口其他位置时不让浏览器直接打开或下载文件。
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());

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
  transport.setLimits({ relay: limit });
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
    transport.setLimits({ relay: res.maxFileSize });
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
