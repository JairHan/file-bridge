const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const captcha = require('svg-captcha');

const LOCK_MS = 60 * 60 * 1000;
class LoginGuard {
  constructor(filename, now = Date.now) {
    this.filename = filename;
    this.now = now;
    this.challenges = new Map();
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try {
      this.attempts = new Map(JSON.parse(fs.readFileSync(filename, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.attempts = new Map();
    }
  }
  save() {
    const temporary = `${this.filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.attempts]), { mode: 0o600 });
    fs.renameSync(temporary, this.filename);
  }
  state(ip) {
    const state = this.attempts.get(ip);
    if (state?.lockedUntil && this.now() >= state.lockedUntil) {
      this.attempts.delete(ip);
      this.save();
      return { count: 0, lockedUntil: 0 };
    }
    return state || { count: 0, lockedUntil: 0 };
  }
  issue(ip, previousId) {
    for (const [id, challenge] of this.challenges) {
      if (challenge.expires <= this.now()) this.challenges.delete(id);
    }
    this.challenges.delete(previousId);
    if (this.challenges.size >= 10000) this.challenges.delete(this.challenges.keys().next().value);
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const id = crypto.randomBytes(32).toString('hex');
    const data = captcha(code, { width: 130, height: 52, fontSize: 42, noise: 5, color: true, background: '#edf4ef' });
    this.challenges.set(id, { code, ip, expires: this.now() + 5 * 60 * 1000 });
    return { id, data };
  }
  check(ip, input, challengeId) {
    const state = this.state(ip);
    if (state.lockedUntil > this.now()) return this.locked(state);
    const challenge = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    const valid = challenge && challenge.ip === ip && challenge.expires > this.now();
    const expected = Buffer.from(valid ? challenge.code : '----');
    if (valid && typeof input === 'string' && /^\d{4}$/.test(input) && crypto.timingSafeEqual(expected, Buffer.from(input))) {
      this.attempts.delete(ip);
      this.save();
      return { ok: true };
    }
    state.count += 1;
    if (state.count >= 3) state.lockedUntil = this.now() + LOCK_MS;
    this.attempts.set(ip, state);
    this.save();
    return state.lockedUntil ? this.locked(state) : {
      ok: false, status: 401, error: `验证码错误，还可尝试 ${3 - state.count} 次`
    };
  }
  locked(state) {
    return { ok: false, status: 429, retryAfter: Math.ceil((state.lockedUntil - this.now()) / 1000),
      error: '连续输错 3 次，此 IP 已锁定 1 小时' };
  }
}
module.exports = { LoginGuard, LOCK_MS };
