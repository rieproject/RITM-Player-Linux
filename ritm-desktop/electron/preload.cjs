// Jembatan aman renderer ↔ proses utama (contextIsolation + sandbox).
'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ritmDesktop', {
  platform: process.platform,
  getWindowMode: () => ipcRenderer.invoke('ritm:window-mode'),
  onWindowModeChange: (cb) => {
    const h = (_e, maximized) => cb(maximized);
    ipcRenderer.on('ritm:window-mode', h);
    return () => ipcRenderer.removeListener('ritm:window-mode', h);
  },
  fullScreen: {
    get: () => ipcRenderer.invoke('ritm:fullscreen-get'),
    /** Atur layar penuh → status terbaru. */
    set: (on) => ipcRenderer.invoke('ritm:fullscreen-set', on),
    onChange: (cb) => {
      const h = (_e, on) => cb(on);
      ipcRenderer.on('ritm:fullscreen', h);
      return () => ipcRenderer.removeListener('ritm:fullscreen', h);
    },
  },
  /** Lirik untuk file audio biasa: .lrc di sebelah file, lalu pencarian daring bila `online`. */
  findLyrics: (q) => ipcRenderer.invoke('ritm:find-lyrics', q),
  /** Dialog "Buka" → { path, name, data: ArrayBuffer } | null */
  openDialog: (labels) => ipcRenderer.invoke('ritm:open-dialog', labels),
  /** Dialog pilih folder → daftar berkas audio di dalamnya (playlist), atau null bila dibatalkan. */
  openFolder: (labels) => ipcRenderer.invoke('ritm:open-folder', labels),
  /** Sebagian awal berkas (untuk metadata) dan ukuran penuhnya. */
  readHead: (p) => ipcRenderer.invoke('ritm:read-head', p),
  /** Baca file yang sudah diizinkan (dari dialog, drop, Explorer, atau perpustakaan). */
  readPath: (p) => ipcRenderer.invoke('ritm:read-path', p),
  /** Path asli file yang di-drop; sekaligus mengizinkannya untuk dibaca ulang dari perpustakaan. */
  pathForFile: (file) => {
    const p = webUtils.getPathForFile(file);
    if (p) ipcRenderer.invoke('ritm:allow-path', p);
    return p || null;
  },
  /** File yang dibuka lewat Explorer saat app baru dijalankan. */
  takePending: () => ipcRenderer.invoke('ritm:take-pending'),
  /** File dibuka lewat Explorer saat app sudah berjalan. */
  onOpenPath: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('ritm:open-path', h);
    return () => ipcRenderer.removeListener('ritm:open-path', h);
  },
  recent: {
    list: () => ipcRenderer.invoke('ritm:recent-list'),
    add: (item) => ipcRenderer.invoke('ritm:recent-add', item),
    remove: (p) => ipcRenderer.invoke('ritm:recent-remove', p),
  },
  showInFolder: (p) => ipcRenderer.invoke('ritm:show-in-folder', p),
  setTitle: (t) => ipcRenderer.send('ritm:set-title', t),
  /** Mesin audio native (WASAPI / CoreAudio). */
  native: {
    info: () => ipcRenderer.invoke('ritm:native-info'),
    /** Kirim perintah → null bila terkirim, atau pesan error. */
    send: (msg) => ipcRenderer.invoke('ritm:native-send', msg),
    onEvent: (cb) => {
      const h = (_e, ev) => cb(ev);
      ipcRenderer.on('ritm:native-event', h);
      return () => ipcRenderer.removeListener('ritm:native-event', h);
    },
  },
});
