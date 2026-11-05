// Mesin audio native (ritm-audio): proses sidecar, protokol JSON per baris lewat stdin/stdout.
// WASAPI (Windows) / CoreAudio (macOS) — bit-perfect di mode Exclusive. Renderer tidak pernah menjalankan
// proses atau menyentuh path sendiri: semua perintah divalidasi di sini.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = process.platform === 'win32' ? 'ritm-audio.exe' : 'ritm-audio';
const PLATFORM_DIR = { win32: 'win-x64', darwin: 'mac', linux: 'linux-x64' }[process.platform];

/** Lokasi biner: hasil paket (resources/native) atau folder kerja (native/bin/<platform>). */
function binaryPath(app) {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'native', EXE));
  if (PLATFORM_DIR) candidates.push(path.join(__dirname, '..', 'native', 'bin', PLATFORM_DIR, EXE));
  if (process.env.RITM_AUDIO_BIN) candidates.unshift(process.env.RITM_AUDIO_BIN);
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

const ALLOWED_CMDS = new Set(['devices', 'config', 'open', 'preload', 'play', 'pause', 'seek', 'stop', 'mute']);

class NativeAudio {
  /** @param {{ app: Electron.App, canRead: (p: string) => boolean, onEvent: (e: object) => void }} opts */
  constructor(opts) {
    this.opts = opts;
    this.bin = binaryPath(opts.app);
    /** @type {import('node:child_process').ChildProcess | null} */
    this.proc = null;
    this.buf = '';
    this.version = null;
    this.backend = null;
    this.stopping = false;
  }

  available() {
    return !!this.bin;
  }

  info() {
    return { available: !!this.bin, running: !!this.proc, version: this.version, backend: this.backend };
  }

  ensure() {
    if (this.proc || !this.bin) return !!this.proc;
    this.stopping = false;
    // RITM_AUDIO_SINK hanya untuk uji otomatis (mis. "file:out.wav;rates=44100") — tidak dipakai di produksi
    const args = process.env.RITM_AUDIO_SINK ? ['--sink', process.env.RITM_AUDIO_SINK] : [];
    const p = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    // proses yang sudah berhenti menolak tulisan; tanpa penangan ini EPIPE menjadi exception di proses utama
    p.stdin.on('error', () => {});
    this.buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.ev === 'ready') {
          this.version = ev.version ?? null;
          this.backend = ev.backend ?? null;
        }
        this.opts.onEvent(ev);
      }
    });
    p.stderr.on('data', () => {}); // log driver (mis. ALSA/wine) diabaikan
    p.on('error', (err) => {
      this.proc = null;
      this.opts.onEvent({ ev: 'crashed', message: String(err.message || err) });
    });
    p.on('exit', (code, signal) => {
      const was = this.proc === p;
      if (was) this.proc = null;
      if (was && !this.stopping)
        this.opts.onEvent({ ev: 'crashed', message: `mesin audio native berhenti (${signal ? `sinyal ${signal}` : `kode ${code}`})` });
    });
    return true;
  }

  /** Validasi & kirim satu perintah dari renderer. Mengembalikan pesan error atau null. */
  send(msg) {
    if (!msg || typeof msg !== 'object' || !ALLOWED_CMDS.has(msg.cmd)) return 'perintah tidak diizinkan';
    const out = { cmd: msg.cmd };
    switch (msg.cmd) {
      case 'open':
      case 'preload': {
        const p = path.resolve(String(msg.path ?? ''));
        if (!this.opts.canRead(p)) return 'akses file ditolak';
        out.path = p;
        if (typeof msg.entry === 'string' && msg.entry.length > 0 && msg.entry.length < 512 && !msg.entry.includes('\0')) out.entry = msg.entry;
        if (msg.scramble === 'xor-v1' && out.entry) out.scramble = 'xor-v1';
        if (msg.cmd === 'open') {
          out.at = Number.isFinite(msg.at) ? Math.max(0, msg.at) : 0;
          out.play = msg.play !== false;
        }
        break;
      }
      case 'seek':
        out.t = Number.isFinite(msg.t) ? Math.max(0, msg.t) : 0;
        break;
      case 'mute':
        out.on = !!msg.on;
        break;
      case 'config': {
        if (msg.mode === 'exclusive' || msg.mode === 'shared') out.mode = msg.mode;
        if (typeof msg.device === 'string' && msg.device.length < 512) out.device = msg.device;
        if ([256, 512, 1024, 2048, 4096].includes(msg.buffer)) out.buffer = msg.buffer;
        if (msg.phase === 'linear' || msg.phase === 'minimum') out.phase = msg.phase;
        if (typeof msg.dither === 'boolean') out.dither = msg.dither;
        if (typeof msg.shaping === 'boolean') out.shaping = msg.shaping;
        if (msg.profile === 'purist' || msg.profile === 'analog') out.profile = msg.profile;
        if (typeof msg.guard === 'boolean') out.guard = msg.guard;
        break;
      }
      default:
        break;
    }
    if (!this.ensure()) return 'mesin audio native tidak tersedia';
    try {
      this.proc.stdin.write(JSON.stringify(out) + '\n');
    } catch (e) {
      return String(e.message || e);
    }
    return null;
  }

  shutdown() {
    if (!this.proc) return;
    this.stopping = true;
    const p = this.proc;
    try {
      p.stdin.write('{"cmd":"quit"}\n');
      p.stdin.end();
    } catch {}
    // pastikan perangkat (hog/exclusive) dilepas walau proses macet
    setTimeout(() => {
      if (p.exitCode === null) p.kill();
    }, 1500).unref();
    this.proc = null;
  }
}

module.exports = { NativeAudio, binaryPath };
