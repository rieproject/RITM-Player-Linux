// RITM Player — proses utama Electron.
// Tugas: jendela, satu instance, buka file dari Explorer (asosiasi .ritm), dialog Buka,
// dan membaca file HANYA dari path yang dipilih pengguna (dialog, drop, argumen, perpustakaan).
'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { NativeAudio } = require('./native.cjs');
const { entryMethod, readRitmAudio, SCRAMBLE_XOR_V1 } = require('./ritmzip.cjs');
const fsSync = require('node:fs');
const crypto = require('node:crypto');

const AUDIO_EXTS = ['ritm', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'];
const MAX_BYTES = 600 * 1024 * 1024;
const RECENT_MAX = 30;

/** @type {BrowserWindow | null} */
let win = null;
/** File yang diminta dibuka sebelum jendela siap. */
let pendingOpen = null;
/** Path yang boleh dibaca renderer. */
const allowed = new Set();

const isMediaPath = (p) => typeof p === 'string' && AUDIO_EXTS.includes(path.extname(p).slice(1).toLowerCase());
const fileFromArgv = (argv) => argv.slice(1).find((a) => !a.startsWith('-') && isMediaPath(a)) ?? null;

// ---------------------------------------------------------------- perpustakaan (file terakhir dibuka)
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
async function readRecent() {
  try {
    const list = JSON.parse(await fs.readFile(recentFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
async function writeRecent(list) {
  await fs.mkdir(path.dirname(recentFile()), { recursive: true });
  await fs.writeFile(recentFile(), JSON.stringify(list.slice(0, RECENT_MAX)));
}

// ---------------------------------------------------------------- satu instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const p = fileFromArgv(argv);
    if (p) openInRenderer(p);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

// macOS: dobel-klik file saat app berjalan / belum siap
app.on('open-file', (e, p) => {
  e.preventDefault();
  openInRenderer(p);
});

function openInRenderer(p) {
  allowed.add(path.resolve(p));
  if (win && !win.webContents.isLoading()) win.webContents.send('ritm:open-path', path.resolve(p));
  else pendingOpen = path.resolve(p);
}

async function readAllowed(p) {
  const abs = path.resolve(String(p));
  if (!allowed.has(abs)) throw new Error('Akses file ditolak');
  if (!isMediaPath(abs)) throw new Error('Format file tidak didukung');
  const st = await fs.stat(abs);
  if (st.size > MAX_BYTES) throw new Error('File terlalu besar');
  const buf = await fs.readFile(abs);
  // kirim sebagai ArrayBuffer (disalin sekali lewat IPC)
  return { path: abs, name: path.basename(abs), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

// ---------------------------------------------------------------- mesin audio native
const native = new NativeAudio({
  app,
  canRead: (p) => allowed.has(path.resolve(p)) && isMediaPath(p),
  onEvent: (ev) => {
    if (win && !win.isDestroyed()) win.webContents.send('ritm:native-event', ev);
  },
});
ipcMain.handle('ritm:native-info', () => native.info());
// ---------------------------------------------------------------- audio .ritm terkompresi untuk mesin native
// Mesin native hanya membaca entry yang disimpan tanpa kompresi. Untuk entry deflate, audio dibuka di sini,
// diverifikasi, lalu ditulis sebagai salinan sementara (seperti extractToTemp di mesin native). Salinan dihapus saat keluar.
const nativeCacheDir = () => path.join(app.getPath('temp'), 'ritm-native-cache');
const nativeCopies = new Set();

async function nativeOpenMessage(msg) {
  if (msg?.cmd !== 'open' || typeof msg.entry !== 'string' || !msg.entry) return msg;
  const src = path.resolve(String(msg.path ?? ''));
  if (!allowed.has(src) || !isMediaPath(src)) return msg; // mesin native akan menolak sendiri
  if ((await entryMethod(src, msg.entry)) === 0) return msg; // sudah stored: langsung dibaca native

  const ext = path.extname(msg.entry).toLowerCase();
  if (!isMediaPath(`x${ext}`)) throw new Error('format audio dalam arsip tidak didukung');

  const st = await fs.stat(src);
  const key = crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${msg.entry}|${msg.scramble ?? ''}`).digest('hex');
  const dest = path.join(nativeCacheDir(), `${key}${ext}`);
  if (!fsSync.existsSync(dest)) {
    const audio = await readRitmAudio(src, msg.entry, msg.scramble === SCRAMBLE_XOR_V1);
    await fs.mkdir(nativeCacheDir(), { recursive: true });
    // tulis ke berkas sementara lalu ganti nama: pembuka lain tidak pernah melihat berkas yang setengah jadi
    const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`;
    nativeCopies.add(tmp);
    try {
      await fs.writeFile(tmp, audio);
      await fs.rename(tmp, dest);
    } catch (err) {
      fsSync.rmSync(tmp, { force: true });
      nativeCopies.delete(tmp);
      throw err;
    }
    nativeCopies.delete(tmp);
    nativeCopies.add(dest);
  }
  allowed.add(dest);
  return { cmd: 'open', path: dest, at: msg.at, play: msg.play };
}

ipcMain.handle('ritm:native-send', async (_e, msg) => {
  try {
    return native.send(await nativeOpenMessage(msg));
  } catch (err) {
    // gagal menyiapkan audio (mis. hash tidak cocok): laporkan alasannya ke renderer → Web Audio mengambil alih
    console.error('RITM: audio .ritm tidak bisa disiapkan —', err.message);
    return err.message;
  }
});

app.on('before-quit', () => {
  native.shutdown();
  for (const f of nativeCopies) {
    try {
      fsSync.rmSync(f, { force: true });
    } catch (err) {
      console.error('RITM: salinan sementara tidak bisa dihapus —', err.message);
    }
  }
  nativeCopies.clear();
});

// ---------------------------------------------------------------- IPC
ipcMain.handle('ritm:open-dialog', async (_e, labels) => {
  // label dikirim renderer mengikuti bahasa aktif; cadangan bahasa Indonesia bila tidak ada
  const label = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : fallback);
  const r = await dialog.showOpenDialog(win, {
    title: label(labels?.title, 'Buka rilisan'),
    properties: ['openFile'],
    filters: [
      { name: label(labels?.ritm, 'Rilisan RITM'), extensions: ['ritm'] },
      { name: label(labels?.audio, 'Audio'), extensions: AUDIO_EXTS.filter((e) => e !== 'ritm') },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  allowed.add(path.resolve(r.filePaths[0]));
  return readAllowed(r.filePaths[0]);
});

// ---------------------------------------------------------------- playlist folder (audio biasa)
// Hanya daftar berkas dan sebagian awal berkas yang dikirim ke renderer; audio dibaca langsung dari disk oleh mesin native.
const FOLDER_AUDIO = /\.(mp3|wav|flac|ogg|m4a|aac)$/i;
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'folder.png'];
const HEAD_MAX = 8 * 1024 * 1024; // tag ID3/Vorbis/FLAC/MP4 umumnya berada di awal berkas

ipcMain.handle('ritm:open-folder', async (_e, labels) => {
  const l = labels && typeof labels === 'object' ? labels : {};
  const r = await dialog.showOpenDialog(win, {
    title: String(l.title ?? 'Folder').slice(0, 120),
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = path.resolve(r.filePaths[0]);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile() || !FOLDER_AUDIO.test(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    allowed.add(abs);
    files.push({ path: abs, name: ent.name });
  }
  let cover = null;
  for (const name of COVER_NAMES) {
    const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === name);
    if (hit) {
      cover = path.join(dir, hit.name);
      allowed.add(cover);
      break;
    }
  }
  return { dir, name: path.basename(dir), files, cover };
});

ipcMain.handle('ritm:read-head', async (_e, p) => {
  const abs = path.resolve(String(p));
  const isImage = /\.(jpe?g|png)$/i.test(abs);
  if (!allowed.has(abs) || !(isMediaPath(abs) || isImage)) throw new Error('Akses file ditolak');
  const fh = await fs.open(abs, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, HEAD_MAX);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return { name: path.basename(abs), size, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } finally {
    await fh.close();
  }
});

ipcMain.handle('ritm:window-mode', () => !!win && (win.isMaximized() || win.isFullScreen()));

ipcMain.handle('ritm:fullscreen-get', () => !!win && win.isFullScreen());
ipcMain.handle('ritm:fullscreen-set', (_e, on) => {
  if (win && !win.isDestroyed()) win.setFullScreen(!!on);
  return !!win && win.isFullScreen();
});

// ---------------------------------------------------------------- lirik untuk file audio biasa
// Urutan: file .lrc dengan nama yang sama di folder yang sama.
const LRC_MAX_BYTES = 512 * 1024;

const clip = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function readSidecarLrc(abs) {
  const lrcPath = path.join(path.dirname(abs), `${path.basename(abs, path.extname(abs))}.lrc`);
  try {
    const st = await fs.stat(lrcPath);
    if (!st.isFile() || st.size > LRC_MAX_BYTES) return null;
    return await fs.readFile(lrcPath, 'utf8');
  } catch {
    return null;
  }
}

ipcMain.handle('ritm:find-lyrics', async (_e, q) => {
  try {
    const abs = typeof q?.path === 'string' ? path.resolve(q.path) : null;
    if (abs && allowed.has(abs) && isMediaPath(abs)) {
      const side = await readSidecarLrc(abs);
      if (side && /\[\d{1,3}:\d{2}/.test(side)) return { lrc: side, source: 'sidecar' };
    }
    // edisi standar tidak mencari lirik daring: hanya file .lrc di sebelah audio (di atas)
    return null;
  } catch {
    return null; // lirik bersifat tambahan; kegagalan jaringan tidak boleh mengganggu pemutaran
  }
});

ipcMain.handle('ritm:read-path', (_e, p) => readAllowed(p));

// path dari file yang di-drop ke jendela (renderer mengirim path hasil webUtils)
ipcMain.handle('ritm:allow-path', (_e, p) => {
  if (isMediaPath(p)) allowed.add(path.resolve(String(p)));
  return true;
});

ipcMain.handle('ritm:take-pending', () => {
  const p = pendingOpen;
  pendingOpen = null;
  return p;
});

ipcMain.handle('ritm:recent-list', async () => {
  const list = await readRecent();
  // hanya path yang masih ada; semuanya boleh dibaca karena pernah dibuka pengguna
  const out = [];
  for (const item of list) {
    const exists = await fs.stat(item.path).then(() => true, () => false);
    if (exists) allowed.add(path.resolve(item.path));
    out.push({ ...item, missing: !exists });
  }
  return out;
});

ipcMain.handle('ritm:recent-add', async (_e, item) => {
  if (!item || typeof item.path !== 'string' || !allowed.has(path.resolve(item.path))) return false;
  const clean = {
    path: path.resolve(item.path),
    title: String(item.title ?? '').slice(0, 200),
    artist: String(item.artist ?? '').slice(0, 200),
    type: String(item.type ?? '').slice(0, 20),
    tracks: Number(item.tracks) || 0,
    cover: typeof item.cover === 'string' && item.cover.startsWith('data:image/') && item.cover.length < 120_000 ? item.cover : null,
    accent: typeof item.accent === 'string' ? item.accent.slice(0, 9) : null,
    openedAt: new Date().toISOString(),
  };
  const list = (await readRecent()).filter((x) => path.resolve(x.path) !== clean.path);
  await writeRecent([clean, ...list]);
  return true;
});

ipcMain.handle('ritm:recent-remove', async (_e, p) => {
  const list = (await readRecent()).filter((x) => path.resolve(x.path) !== path.resolve(String(p)));
  await writeRecent(list);
  return true;
});

ipcMain.handle('ritm:show-in-folder', (_e, p) => {
  const abs = path.resolve(String(p));
  if (allowed.has(abs)) shell.showItemInFolder(abs);
});

ipcMain.on('ritm:set-title', (_e, title) => {
  if (win && typeof title === 'string') win.setTitle(title.slice(0, 200) || 'RITM Player');
});

// ---------------------------------------------------------------- jendela
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 815,
    minHeight: 830,
    title: 'RITM Player',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#fafafa',
    autoHideMenuBar: true,
    show: false, // tampil setelah halaman siap (lihat di bawah)
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // tautan luar dibuka di browser, bukan di dalam app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const sendWindowMode = () => {
    if (win && !win.isDestroyed()) win.webContents.send('ritm:window-mode', win.isMaximized() || win.isFullScreen());
  };
  win.on('maximize', sendWindowMode);
  win.on('unmaximize', sendWindowMode);
  win.on('enter-full-screen', sendWindowMode);
  win.on('leave-full-screen', sendWindowMode);
  win.webContents.once('did-finish-load', sendWindowMode);

  const sendFullScreen = () => {
    if (win && !win.isDestroyed()) win.webContents.send('ritm:fullscreen', win.isFullScreen());
  };
  win.on('enter-full-screen', sendFullScreen);
  win.on('leave-full-screen', sendFullScreen);

  // jendela tampil begitu halaman siap. Animasi pembuka dimainkan di dalam jendela (lihat IntroAnimation).
  // Cadangan: bila halaman gagal dimuat atau ready-to-show tidak datang, jendela tetap ditampilkan.
  const reveal = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', reveal);
  win.webContents.on('did-fail-load', (_e, _code, desc) => {
    console.error('RITM: gagal memuat halaman —', desc);
    reveal();
  });
  setTimeout(reveal, 5000);

  const devUrl = process.env.RITM_DEV_URL;
  const loading = devUrl ? win.loadURL(devUrl) : win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  loading.catch((err) => {
    console.error('RITM: gagal memuat halaman —', err.message);
    reveal();
  });

  win.on('closed', () => {
    win = null;
    native.shutdown();
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // sisa salinan dari sesi yang berakhir tidak rapi (crash, dimatikan paksa): bersihkan saat mulai
  try {
    fsSync.rmSync(nativeCacheDir(), { recursive: true, force: true });
  } catch {}
  const p = fileFromArgv(process.argv);
  if (p) {
    allowed.add(path.resolve(p));
    pendingOpen = path.resolve(p);
  }
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
