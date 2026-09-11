    const form = document.getElementById('loginForm');
    const password = document.getElementById('password');
    const submitBtn = document.getElementById('submitBtn');
    const message = document.getElementById('message');

    const refreshBtn = document.getElementById('refreshCaptcha');
    const captchaImage = document.getElementById('captchaImage');
    let imageUrl = null;
    let loading = false;
    let submitting = false;
    let ready = false;
    let lockedUntil = 0;
    async function refreshCaptcha() {
      if (loading || lockedUntil > Date.now()) return;
      loading = true;
      ready = false;
      updateLock();
      try {
        const response = await fetch('/api/captcha', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) {
          const data = await response.json();
          if (response.status === 429) lockedUntil = Date.now() + data.retryAfter * 1000;
          throw new Error(data.error || '验证码加载失败，请点击图片重试');
        }
        const blob = await response.blob();
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = URL.createObjectURL(blob);
        captchaImage.src = imageUrl;
        password.value = '';
        ready = true;
      } catch (error) { message.textContent = error.message; }
      finally { loading = false; updateLock(); }
    }
    refreshBtn.addEventListener('click', refreshCaptcha);
    function updateLock() {
      const seconds = Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000));
      if (!seconds) lockedUntil = 0;
      password.disabled = seconds > 0;
      submitBtn.disabled = seconds > 0 || loading || submitting || !ready;
      refreshBtn.disabled = seconds > 0 || loading || submitting;
      submitBtn.textContent = seconds ? `已锁定 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : submitting ? '验证中…' : '进入';
    }
    password.addEventListener('input', () => { password.value = password.value.replace(/\D/g, '').slice(0, 4); });
    setInterval(() => { if (lockedUntil) { updateLock(); if (!lockedUntil) refreshCaptcha(); } }, 1000);
    refreshCaptcha();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!ready || submitting || lockedUntil > Date.now() || !password.value) return;
      submitting = true;
      updateLock();

      submitBtn.disabled = true;
      submitBtn.textContent = '验证中…';
      message.textContent = '';

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ password: password.value })
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.ok) {
          message.textContent = data.error || '登录失败，请重试';
          if (response.status === 429) lockedUntil = Date.now() + Number(data.retryAfter || 3600) * 1000;
          if (!lockedUntil) await refreshCaptcha();
          password.select();
          return;
        }

        location.replace('/');
      } catch {
        message.textContent = '无法连接服务器，请稍后重试';
      } finally {
        submitting = false;
        updateLock();
      }
    });
