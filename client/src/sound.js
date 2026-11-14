// Web Audio API Sound Synthesizer & Background Music Controller - JakLudo
import { createSynth, makeImpulse } from './audio/synth';
import { ElectroBgm } from './audio/electroBgm';
import { SnakesBgm } from './audio/snakesBgm';
import * as ludoSfx from './audio/ludoSfx';

// localStorage bisa melempar error (mode privat, in-app browser WhatsApp/Instagram, storage diblokir).
// Error di sini terjadi saat modul dimuat, jadi tanpa pengaman seluruh aplikasi gagal tampil.
const prefs = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Abaikan: pengaturan suara hanya berlaku untuk sesi ini
    }
  }
};

const DEFAULT_BGM_VOLUME = 0.25;
const DEFAULT_SFX_VOLUME = 0.75;

class SoundManager {
  constructor() {
    this.ctx = null;
    this.sfxGain = null;

    // Load initial settings from localStorage (or sensible fun defaults)
    // Default BGM: 0.25 (lembut, tidak menutupi suara game)
    // Default SFX: 0.75 (renyah, jelas, dan seru)
    const storedBgmVol = parseFloat(prefs.get('jakludo_bgm_volume'));
    const storedSfxVol = parseFloat(prefs.get('jakludo_sfx_volume'));

    this.bgmVolume = Number.isFinite(storedBgmVol) ? storedBgmVol : DEFAULT_BGM_VOLUME;
    this.sfxVolume = Number.isFinite(storedSfxVol) ? storedSfxVol : DEFAULT_SFX_VOLUME;
    this.bgmMuted = prefs.get('jakludo_bgm_muted') === 'true';
    this.sfxMuted = prefs.get('jakludo_sfx_muted') === 'true';
    this.bgmEnabled = prefs.get('jakludo_bgm_enabled') !== 'false';

    this.listeners = new Set();
    this.hasUnlocked = false;
    this.isInRoom = false; // BGM hanya dimainkan saat berada di dalam room/gameplay

    // Musik latar dibuat prosedural lewat Web Audio (lihat audio/electroBgm.js & audio/snakesBgm.js)
    this.ludoMusic = new ElectroBgm();
    this.snakesMusic = new SnakesBgm();
    this.bgmTheme = 'ludo';
    this.music = this.ludoMusic;
    this.updateBgmAudioVolume();
    if (typeof window !== 'undefined') {
      this.setupAutoplayUnlock();
      this.setupVisibilityHandling();
    }
  }

  // Putar BGM hanya jika semua syarat terpenuhi (di room, aktif, tidak mute, halaman terlihat)
  resumeBgmIfAllowed() {
    if (!this.isInRoom || !this.bgmEnabled || this.bgmMuted || !this.hasUnlocked) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.init();
    if (this.ctx) this.music.start(this.ctx);
  }

  // Hentikan musik saat aplikasi di background (pindah ke aplikasi lain / layar terkunci)
  setupVisibilityHandling() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.music.stop();
        if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
      } else {
        if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') this.ctx.resume().catch(() => {});
        this.resumeBgmIfAllowed();
      }
      this.notifyListeners();
    });
  }

  // Setup one-shot user interaction listener to bypass browser autoplay restrictions
  setupAutoplayUnlock() {
    if (typeof window === 'undefined') return;

    const unlock = () => {
      this.hasUnlocked = true;
      this.init();
      // BGM HANYA berbunyi jika user sudah berada di dalam room/permainan, BUKAN di landing page
      this.resumeBgmIfAllowed();
      this.notifyListeners();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };

    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true, passive: true });
    window.addEventListener('touchstart', unlock, { once: true, passive: true });
  }

  setBgmTheme(theme) {
    const nextTheme = theme === 'snakes' ? 'snakes' : 'ludo';
    if (this.bgmTheme === nextTheme) return;
    const wasPlaying = this.music?.playing;
    if (wasPlaying) this.music.stop();
    this.bgmTheme = nextTheme;
    this.music = nextTheme === 'snakes' ? this.snakesMusic : this.ludoMusic;
    this.updateBgmAudioVolume();
    if (wasPlaying) {
      this.resumeBgmIfAllowed();
    }
    this.notifyListeners();
  }

  setInRoom(inRoom) {
    this.isInRoom = Boolean(inRoom);
    if (!this.isInRoom) {
      this.pauseBgm();
    } else {
      this.resumeBgmIfAllowed();
    }
    this.notifyListeners();
  }

  unlockFromGesture() {
    this.hasUnlocked = true;
    this.init();
    this.resumeBgmIfAllowed();
    this.notifyListeners();
  }

  // AudioContext hanya dibuat setelah ada interaksi pengguna. Membuatnya lebih awal (misalnya dari
  // event socket) memicu peringatan "AudioContext was not allowed to start" di browser.
  init() {
    if (!this.hasUnlocked) return;
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.setValueAtTime(this.sfxMuted ? 0 : this.sfxVolume, this.ctx.currentTime);
        this.sfxGain.connect(this.ctx.destination);
        // Jalur SFX dengan reverb (sorakan, gong, burung kukuk) agar terdengar lebih "luas"
        this.sfxVerb = this.ctx.createGain();
        this.sfxVerb.connect(this.sfxGain);
        const verb = this.ctx.createConvolver();
        verb.buffer = makeImpulse(this.ctx, 2.6, 2.5);
        const send = this.ctx.createGain();
        send.gain.value = 0.45;
        this.sfxVerb.connect(send);
        send.connect(verb);
        verb.connect(this.sfxGain);
        this.synth = createSynth(this.ctx);
      }
    }
    // iOS memakai state 'interrupted' (telepon masuk, aplikasi di background)
    if (this.ctx && (this.ctx.state === 'suspended' || this.ctx.state === 'interrupted')) {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        this.ctx.resume().catch(() => {});
      }
    }
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach(cb => {
      try {
        cb(this.getState());
      } catch (e) {
        console.error(e);
      }
    });
  }

  getState() {
    return {
      bgmVolume: this.bgmVolume,
      sfxVolume: this.sfxVolume,
      bgmMuted: this.bgmMuted,
      sfxMuted: this.sfxMuted,
      bgmEnabled: this.bgmEnabled,
      isBgmPlaying: this.isBgmPlaying()
    };
  }

  // ==========================================
  // BACKGROUND MUSIC (BGM) CONTROLS
  // ==========================================
  updateBgmAudioVolume() {
    const target = (this.bgmMuted || !this.bgmEnabled) ? 0 : Math.max(0, Math.min(1, this.bgmVolume));
    this.ludoMusic.setVolume(target);
    this.snakesMusic.setVolume(target);
  }

  setBgmVolume(val) {
    const num = Math.max(0, Math.min(1, parseFloat(val) || 0));
    this.bgmVolume = num;
    prefs.set('jakludo_bgm_volume', String(num));
    if (this.bgmMuted && num > 0) {
      this.bgmMuted = false;
      prefs.set('jakludo_bgm_muted', 'false');
    }
    this.updateBgmAudioVolume();
    this.resumeBgmIfAllowed();
    this.notifyListeners();
  }

  getBgmVolume() {
    return this.bgmVolume;
  }

  toggleBgmMute() {
    this.bgmMuted = !this.bgmMuted;
    prefs.set('jakludo_bgm_muted', String(this.bgmMuted));
    this.updateBgmAudioVolume();
    this.resumeBgmIfAllowed();
    this.notifyListeners();
    return this.bgmMuted;
  }

  isBgmMuted() {
    return this.bgmMuted;
  }

  // Aktifkan BGM. Musik baru benar-benar berbunyi saat pemain berada di room.
  playBgm() {
    this.init();
    this.bgmEnabled = true;
    prefs.set('jakludo_bgm_enabled', 'true');
    this.updateBgmAudioVolume();
    this.resumeBgmIfAllowed();
    this.notifyListeners();
  }

  pauseBgm() {
    this.music.stop();
    this.notifyListeners();
  }

  toggleBgmPlay() {
    if (this.isBgmPlaying()) {
      this.pauseBgm();
      this.bgmEnabled = false;
      prefs.set('jakludo_bgm_enabled', 'false');
    } else {
      this.playBgm();
    }
    this.notifyListeners();
  }

  isBgmPlaying() {
    return this.music.playing;
  }

  // ==========================================
  // SOUND EFFECTS (SFX) CONTROLS
  // ==========================================
  updateSfxGain() {
    this.init();
    if (!this.sfxGain || !this.ctx) return;
    const target = this.sfxMuted ? 0 : Math.max(0, Math.min(1, this.sfxVolume));
    this.sfxGain.gain.setValueAtTime(target, this.ctx.currentTime);
  }

  setSfxVolume(val) {
    const num = Math.max(0, Math.min(1, parseFloat(val) || 0));
    this.sfxVolume = num;
    prefs.set('jakludo_sfx_volume', String(num));
    if (this.sfxMuted && num > 0) {
      this.sfxMuted = false;
      prefs.set('jakludo_sfx_muted', 'false');
    }
    this.updateSfxGain();
    this.notifyListeners();
  }

  getSfxVolume() {
    return this.sfxVolume;
  }

  toggleSfxMute() {
    this.sfxMuted = !this.sfxMuted;
    prefs.set('jakludo_sfx_muted', String(this.sfxMuted));
    this.updateSfxGain();
    this.notifyListeners();
    return this.sfxMuted;
  }

  isSfxMuted() {
    return this.sfxMuted;
  }

  // Backward compatibility master toggle
  toggleMute() {
    // If either is unmuted, mute both. If both muted, unmute both.
    const bothMuted = this.bgmMuted && this.sfxMuted;
    if (bothMuted) {
      this.bgmMuted = false;
      this.sfxMuted = false;
    } else {
      this.bgmMuted = true;
      this.sfxMuted = true;
    }
    prefs.set('jakludo_bgm_muted', String(this.bgmMuted));
    prefs.set('jakludo_sfx_muted', String(this.sfxMuted));
    this.updateBgmAudioVolume();
    this.updateSfxGain();
    if (this.bgmMuted) this.pauseBgm();
    else this.resumeBgmIfAllowed();
    this.notifyListeners();
    return this.isAllMuted();
  }

  // Kembalikan semua pengaturan suara ke default (volume, unmute, BGM aktif)
  resetDefaults() {
    this.bgmVolume = DEFAULT_BGM_VOLUME;
    this.sfxVolume = DEFAULT_SFX_VOLUME;
    this.bgmMuted = false;
    this.sfxMuted = false;
    this.bgmEnabled = true;
    prefs.set('jakludo_bgm_volume', String(this.bgmVolume));
    prefs.set('jakludo_sfx_volume', String(this.sfxVolume));
    prefs.set('jakludo_bgm_muted', 'false');
    prefs.set('jakludo_sfx_muted', 'false');
    prefs.set('jakludo_bgm_enabled', 'true');
    this.updateBgmAudioVolume();
    this.updateSfxGain();
    this.resumeBgmIfAllowed();
    this.notifyListeners();
  }

  isAllMuted() {
    return this.bgmMuted && this.sfxMuted;
  }

  isMuted() {
    return this.isAllMuted();
  }

  // Get master node to route SFX through
  getDestination() {
    this.init();
    if (this.sfxGain) return this.sfxGain;
    return this.ctx ? this.ctx.destination : null;
  }

  // ==========================================
  // SFX SYNTHESIZERS
  // ==========================================

  playRoll() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    for (let i = 0; i < 9; i++) {
      const t = now + i * 0.075 + (Math.random() * 0.02 - 0.01);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = i % 2 === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(260 + Math.random() * 320, t);
      osc.frequency.exponentialRampToValueAtTime(120, t + 0.05);

      gain.gain.setValueAtTime(0.14, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);

      osc.connect(gain);
      gain.connect(dest);

      osc.start(t);
      osc.stop(t + 0.05);
    }
  }

  playDiceLand(isSix = false) {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(50, now + 0.12);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + 0.15);

    if (isSix) {
      setTimeout(() => {
        if (this.sfxMuted || this.sfxVolume <= 0 || !this.ctx) return;
        const chimeNotes = [523.25, 659.25, 783.99, 1046.50];
        const chimeTime = this.ctx.currentTime;
        chimeNotes.forEach((freq, idx) => {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(freq, chimeTime + idx * 0.08);

          g.gain.setValueAtTime(0.18, chimeTime + idx * 0.08);
          g.gain.exponentialRampToValueAtTime(0.001, chimeTime + idx * 0.08 + 0.25);

          o.connect(g);
          g.connect(dest);
          o.start(chimeTime + idx * 0.08);
          o.stop(chimeTime + idx * 0.08 + 0.28);
        });
      }, 90);
    }
  }

  // Suara langkah bidak bertahap (tangga nada naik per hop)
  playStep(stepIdx = 0) {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const baseFreqs = [380, 430, 490, 550, 620, 700];
    const freq = baseFreqs[Math.min(stepIdx, baseFreqs.length - 1)];

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.25, now + 0.08);

    gain.gain.setValueAtTime(0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + 0.1);
  }

  playStepLand() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.12);

    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + 0.14);
  }

  playMove() {
    this.playStep(0);
  }

  // Suara eliminasi / bidak terinjak lawan: Bonk kartun + Wah-wah-wah-waaah sad trombone lucu
  playFunnyElimination() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 1. Suara "BONK / SQUISH" komikal
    const bonkOsc = ctx.createOscillator();
    const bonkGain = ctx.createGain();
    bonkOsc.type = 'triangle';
    bonkOsc.frequency.setValueAtTime(480, now);
    bonkOsc.frequency.exponentialRampToValueAtTime(70, now + 0.12);
    bonkGain.gain.setValueAtTime(0.35, now);
    bonkGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    bonkOsc.connect(bonkGain);
    bonkGain.connect(dest);
    bonkOsc.start(now);
    bonkOsc.stop(now + 0.15);

    // 2. Melodi "Wah-wah-wah-waaah" kartun klasik yang jenaka
    const wahNotes = [
      { freq: 330, start: 0.14, dur: 0.16 }, // E4 "Wah"
      { freq: 311, start: 0.32, dur: 0.16 }, // Eb4 "wah"
      { freq: 293, start: 0.50, dur: 0.16 }, // D4 "wah"
      { freq: 277, start: 0.68, dur: 0.45, slideTo: 150 } // Db4 -> meluncur jatuh komikal
    ];

    wahNotes.forEach(n => {
      const t = now + n.start;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      // Karakter instrumen brass/mute trombone kartun
      osc.type = 'sawtooth';
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(650, t);
      filter.frequency.linearRampToValueAtTime(1400, t + 0.05);
      filter.frequency.linearRampToValueAtTime(450, t + n.dur);

      osc.frequency.setValueAtTime(n.freq, t);
      if (n.slideTo) {
        osc.frequency.setValueAtTime(n.freq, t + 0.08);
        osc.frequency.exponentialRampToValueAtTime(n.slideTo, t + n.dur);
      }

      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.24, t + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + n.dur);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(dest);

      osc.start(t);
      osc.stop(t + n.dur + 0.02);
    });
  }

  // Suara Black Hole komikal: hisapan pusaran spiral meliuk-liuk + efek "BLOOP!"
  playFunnyBlackHole() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 1. Hisapan spiral yang meliuk-liuk cepat (frequency wobbling down)
    const suckOsc = ctx.createOscillator();
    const suckGain = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();

    suckOsc.type = 'sawtooth';
    suckOsc.frequency.setValueAtTime(850, now);
    suckOsc.frequency.exponentialRampToValueAtTime(80, now + 0.55);

    // LFO spiral vibrato komikal
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(20, now);
    lfo.frequency.linearRampToValueAtTime(6, now + 0.55);
    lfoGain.gain.setValueAtTime(130, now);

    // Kedalaman vibrato ±130 Hz (sebelumnya LFO tersambung langsung sehingga hanya ±1 Hz)
    lfo.connect(lfoGain);
    lfoGain.connect(suckOsc.frequency);

    suckGain.gain.setValueAtTime(0.01, now);
    suckGain.gain.linearRampToValueAtTime(0.25, now + 0.08);
    suckGain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    suckOsc.connect(suckGain);
    suckGain.connect(dest);

    lfo.start(now);
    suckOsc.start(now);
    lfo.stop(now + 0.56);
    suckOsc.stop(now + 0.56);

    // 2. Bunyi kartun "SPRING / BLOOP" saat bidak terlontar balik ke base
    const popTime = now + 0.56;
    const popOsc = ctx.createOscillator();
    const popGain = ctx.createGain();

    popOsc.type = 'sine';
    popOsc.frequency.setValueAtTime(160, popTime);
    popOsc.frequency.exponentialRampToValueAtTime(780, popTime + 0.09);
    popOsc.frequency.exponentialRampToValueAtTime(200, popTime + 0.22);

    popGain.gain.setValueAtTime(0.3, popTime);
    popGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.24);

    popOsc.connect(popGain);
    popGain.connect(dest);

    popOsc.start(popTime);
    popOsc.stop(popTime + 0.25);
  }

  // Jalur & alat sintesis untuk efek di audio/ludoSfx.js; null bila SFX mati atau audio belum siap
  sfxTools() {
    if (this.sfxMuted || this.sfxVolume <= 0) return null;
    this.init();
    if (!this.ctx || !this.synth) return null;
    return { synth: this.synth, out: this.sfxGain, verb: this.sfxVerb };
  }

  // Bidak terinjak: satu suara dipilih acak murni dari pool (trombon sedih + 5 suara ejekan)
  playCapture() {
    const tools = this.sfxTools();
    if (!tools) return;
    const pick = Math.floor(Math.random() * (ludoSfx.CAPTURE_SOUNDS.length + 1));
    if (pick === 0) this.playFunnyElimination();
    else ludoSfx.CAPTURE_SOUNDS[pick - 1](tools);
  }

  playLeaveBase() {
    const tools = this.sfxTools();
    if (tools) ludoSfx.keluarBase(tools);
  }

  playForceReturn() {
    const tools = this.sfxTools();
    if (tools) ludoSfx.forceReturn(tools);
  }

  playUniversalShield() {
    const tools = this.sfxTools();
    if (tools) ludoSfx.universalShield(tools);
  }

  playBlackholeShield() {
    const tools = this.sfxTools();
    if (tools) ludoSfx.blackholeShield(tools);
  }

  // Bidak finish: "Gong raja" (saron gamelan naik, kendang, lalu gong besar)
  playGoalCelebration() {
    const tools = this.sfxTools();
    if (tools) ludoSfx.gongRaja(tools);
  }

  playWin() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const notes = [
      { f: 523.25, d: 0.15 },
      { f: 659.25, d: 0.15 },
      { f: 783.99, d: 0.15 },
      { f: 1046.50, d: 0.40 }
    ];
    let time = this.ctx.currentTime;
    notes.forEach(note => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(note.f, time);

      g.gain.setValueAtTime(0.25, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + note.d);

      o.connect(g);
      g.connect(dest);
      o.start(time);
      o.stop(time + note.d + 0.02);
      time += note.d + 0.03;
    });
  }

  playClick() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + 0.04);
  }

  // Suara notifikasi member baru join room: Ding-Dong Chime / Marimba Bell yang renyah dan ceria
  playJoinNotification() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 2-tone melodic chime: G5 (784Hz) -> C6 (1046.5Hz)
    const notes = [
      { freq: 783.99, time: now, dur: 0.28, gain: 0.22 },
      { freq: 1046.50, time: now + 0.12, dur: 0.45, gain: 0.26 }
    ];

    notes.forEach(n => {
      // Harmonic 1: Sine murni untuk resonance empuk
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, n.time);

      gain.gain.setValueAtTime(0.001, n.time);
      gain.gain.linearRampToValueAtTime(n.gain, n.time + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, n.time + n.dur);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(n.time);
      osc.stop(n.time + n.dur + 0.02);

      // Harmonic 2: Overtone triangle untuk sentuhan bell kristal
      const bell = ctx.createOscillator();
      const bellGain = ctx.createGain();
      bell.type = 'triangle';
      bell.frequency.setValueAtTime(n.freq * 2, n.time);

      bellGain.gain.setValueAtTime(0.001, n.time);
      bellGain.gain.linearRampToValueAtTime(n.gain * 0.25, n.time + 0.012);
      bellGain.gain.exponentialRampToValueAtTime(0.001, n.time + (n.dur * 0.55));

      bell.connect(bellGain);
      bellGain.connect(dest);
      bell.start(n.time);
      bell.stop(n.time + (n.dur * 0.55) + 0.02);
    });
  }

  // Suara notifikasi chat baru: Nada pop-ping manis & renyah saat pesan baru diterima
  playChatNotification() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;

    // 2-tone melodic bubble pop: B5 (987.77 Hz) -> E6 (1318.51 Hz)
    const tones = [
      { freq: 987.77, time: now, dur: 0.12, gain: 0.22 },
      { freq: 1318.51, time: now + 0.07, dur: 0.22, gain: 0.28 }
    ];

    tones.forEach(t => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(t.freq, t.time);

      gain.gain.setValueAtTime(0.001, t.time);
      gain.gain.linearRampToValueAtTime(t.gain, t.time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t.time + t.dur);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(t.time);
      osc.stop(t.time + t.dur + 0.01);

      // Sentuhan sparkle subtle
      const sparkle = ctx.createOscillator();
      const sparkleGain = ctx.createGain();
      sparkle.type = 'triangle';
      sparkle.frequency.setValueAtTime(t.freq * 2, t.time);

      sparkleGain.gain.setValueAtTime(0.001, t.time);
      sparkleGain.gain.linearRampToValueAtTime(t.gain * 0.2, t.time + 0.008);
      sparkleGain.gain.exponentialRampToValueAtTime(0.001, t.time + (t.dur * 0.6));

      sparkle.connect(sparkleGain);
      sparkleGain.connect(dest);
      sparkle.start(t.time);
      sparkle.stop(t.time + (t.dur * 0.6) + 0.01);
    });
  }

  // Suara pembelian di Toko / Shop: Koin emas & chimes berkilau (B5 -> D#6 -> F#6)
  playShopPurchase() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const coinNotes = [
      { freq: 987.77, time: now, dur: 0.12, gain: 0.2 },
      { freq: 1244.51, time: now + 0.06, dur: 0.15, gain: 0.25 },
      { freq: 1479.98, time: now + 0.12, dur: 0.32, gain: 0.3 }
    ];

    coinNotes.forEach(n => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(n.freq, n.time);

      gain.gain.setValueAtTime(0.001, n.time);
      gain.gain.linearRampToValueAtTime(n.gain, n.time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, n.time + n.dur);

      osc.connect(gain);
      gain.connect(dest);
      osc.start(n.time);
      osc.stop(n.time + n.dur + 0.02);
    });
  }

  // Suara countdown arena Monster Quiz Battle
  playQuizCountdown(isStart = false) {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isStart ? 880 : 440, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(isStart ? 0.28 : 0.18, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (isStart ? 0.28 : 0.14));
    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + (isStart ? 0.3 : 0.16));
  }

  // Suara jawaban benar di Monster Quiz Battle
  playQuizCorrect() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      const t = now + i * 0.055;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  }

  // Suara jawaban salah / waktu habis di Monster Quiz Battle
  playQuizWrong() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.linearRampToValueAtTime(140, now + 0.24);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  // Suara monster melancarkan serangan elemen
  playMonsterAttack() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(260, now);
    osc.frequency.exponentialRampToValueAtTime(720, now + 0.14);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.28);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.26, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  // Suara monster terkena serangan (-10 HP)
  playMonsterHurt() {
    if (this.sfxMuted || this.sfxVolume <= 0) return;
    this.init();
    if (!this.ctx) return;
    const dest = this.getDestination();
    if (!dest) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(55, now + 0.22);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.26);
  }
}

export const sound = new SoundManager();
