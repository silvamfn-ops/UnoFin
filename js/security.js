import { $ } from './config.js';

const SEC_KEY = 'unofin_security_v1';

export class SecurityManager {
  constructor() {
    this.cfg = this.load();
    this.privacyMasked = !!this.cfg.privacyMasked;
    this.idleTimer = null;
  }

  load() {
    try {
      return JSON.parse(localStorage.getItem(SEC_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(SEC_KEY, JSON.stringify(this.cfg));
    } catch {}
  }

  hasPin() {
    return !!this.cfg.pinHash;
  }

  async hashPin(pin) {
    if (window.crypto && window.crypto.subtle) {
      const data = new TextEncoder().encode('unofin-salt:' + pin);
      const buf = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return btoa('unofin:' + pin);
  }

  async setPin(pin, autoLockMinutes = 5) {
    this.cfg.pinHash = await this.hashPin(pin);
    this.cfg.autoLockMinutes = Number(autoLockMinutes) || 0;
    this.save();
  }

  disablePin() {
    delete this.cfg.pinHash;
    delete this.cfg.bioCredId;
    this.save();
    this.unlock();
  }

  async verifyPin(pin) {
    if (!this.hasPin()) return true;
    const h = await this.hashPin(pin);
    if (h === this.cfg.pinHash) {
      this.unlock();
      return true;
    }
    return false;
  }

  lock() {
    if (!this.hasPin()) return;
    const ov = $('appLockOverlay');
    if (ov) {
      ov.hidden = false;
      if ($('appLockPinInput')) {
        $('appLockPinInput').value = '';
        setTimeout(() => $('appLockPinInput').focus(), 40);
      }
      if ($('appLockError')) $('appLockError').textContent = '';
      if ($('appLockBioBtn')) $('appLockBioBtn').hidden = !this.cfg.bioCredId;
    }
  }

  unlock() {
    const ov = $('appLockOverlay');
    if (ov) ov.hidden = true;
    this.resetIdleTimer();
  }

  async enableBiometrics() {
    if (!window.PublicKeyCredential) throw new Error('Biometria não suportada neste dispositivo.');
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'UnoFin' },
        user: { id: userId, name: 'unofin-user', displayName: 'Utilizador UnoFin' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000
      }
    });
    if (cred && cred.rawId) {
      this.cfg.bioCredId = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
      this.save();
    }
  }

  async unlockWithBiometrics() {
    if (!this.cfg.bioCredId || !window.PublicKeyCredential) return;
    try {
      const raw = Uint8Array.from(atob(this.cfg.bioCredId), c => c.charCodeAt(0));
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{ type: 'public-key', id: raw }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      this.unlock();
    } catch {
      if ($('appLockError')) $('appLockError').textContent = 'Autenticação biométrica cancelada ou falhou.';
    }
  }

  togglePrivacy() {
    this.privacyMasked = !this.privacyMasked;
    this.cfg.privacyMasked = this.privacyMasked;
    this.save();
    this.applyPrivacy();
  }

  applyPrivacy() {
    document.body.classList.toggle('privacy-masked', this.privacyMasked);
    const btn = $('privacyToggleBtn');
    if (btn) btn.classList.toggle('is-active', this.privacyMasked);
  }

  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const mins = Number(this.cfg.autoLockMinutes) || 0;
    if (mins > 0 && this.hasPin()) {
      this.idleTimer = setTimeout(() => this.lock(), mins * 60 * 1000);
    }
  }

  startIdleWatcher() {
    ['pointerdown', 'keydown', 'scroll'].forEach(ev => {
      document.addEventListener(ev, () => this.resetIdleTimer(), { passive: true });
    });
  }
}
