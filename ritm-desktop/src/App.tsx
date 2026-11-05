import { useCallback, useEffect, useRef, useState } from 'react';
import { Library as LibraryIcon, Maximize, Minimize, Moon, Settings, Sun, X } from 'lucide-react';
import { OpenMenu } from './OpenMenu';
import {
  BookletModal,
  PlayerStage,
  RitmBrand,
  alertTextFor,
  cleanupMediaState,
  parseMediaFile,
  useIslandState,
  type ActiveMediaState,
} from '@ritm/player';
import { desktop, thumbFrom, type RecentItem } from './desktop';
import { attachLyrics } from './lyrics';
import { buildFolderMedia, buildWebFolderMedia } from './folder';
import { IntroAnimation } from './IntroAnimation';
import { Library } from './Library';
import { SettingsPanel } from './SettingsPanel';
import { TrackList } from './TrackList';
import { useI18n } from './i18n';
import { useMediaSession } from './useMediaSession';
import { useDesktopEngine } from './useDesktopEngine';

const ACCEPT = '.ritm,.mp3,.wav,.flac,.ogg,.m4a,.aac';

export function App() {
  const [media, setMedia] = useState<ActiveMediaState | null>(null);
  const [source, setSource] = useState<{ path: string | null; name: string } | null>(null);
  const [karaoke, setKaraoke] = useState(false);
  const { engine, choice } = useDesktopEngine(media, source?.path ?? null, karaoke);
  const island = useIslandState({ hasMedia: !!media, playing: engine.playing });
  const [booklet, setBooklet] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { t } = useI18n();
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [intro, setIntro] = useState(true);
  const [viewW, setViewW] = useState(() => window.innerWidth);
  const narrowWindow = viewW < 1180;
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const picker = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  /** Nomor pemuatan terakhir; hasil pemuatan yang sudah tergantikan diabaikan. */
  const loadSeq = useRef(0);
  /** Rilisan dihapus dari Catalogue saat masih diputar: layar utama dikosongkan setelah stop. */
  const pendingClear = useRef(false);
  const clearMedia = useCallback(() => {
    const prev = mediaRef.current;
    pendingClear.current = false;
    setMedia(null);
    setSource(null);
    setKaraoke(false);
    setBooklet(false);
    setLibraryOpen(false);
    if (prev) setTimeout(() => cleanupMediaState(prev), 3000);
  }, []);
  // stop (pause + posisi 0) pada rilisan yang sudah dihapus dari Catalogue: kosongkan layar utama
  useEffect(() => {
    if (pendingClear.current && !engine.playing && engine.time < 0.5) clearMedia();
  }, [engine.playing, engine.time, clearMedia]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('ritm-theme', dark ? 'dark' : 'light');
    } catch {}
  }, [dark]);

  useEffect(() => {
    const onResize = () => setViewW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let mounted = true;
    const unsubscribe = desktop.onWindowModeChange(setMaximized);
    void desktop.getWindowMode().then((value) => mounted && setMaximized(value));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (desktop) {
      const unsubscribe = desktop.fullScreen.onChange(setFullScreen);
      void desktop.fullScreen.get().then(setFullScreen);
      return unsubscribe;
    }
    const sync = () => setFullScreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  const toggleFullScreen = useCallback(async () => {
    if (desktop) {
      setFullScreen(await desktop.fullScreen.set(!fullScreen));
    } else if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    } else {
      await document.documentElement.requestFullscreen().catch(() => {});
    }
  }, [fullScreen]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(undefined), 3600);
    return () => clearTimeout(id);
  }, [toast]);

  const refreshRecent = useCallback(async () => {
    if (desktop) setRecent(await desktop.recent.list());
  }, []);
  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  /** Muat satu file (dari dialog, drop, Explorer, atau perpustakaan). */
  const load = useCallback(
    async (file: File, path: string | null) => {
      setLoading(true);
      const seq = ++loadSeq.current;
      try {
        const { state: parsed } = await parseMediaFile(file, { includeKaraoke: true });
        // lirik diambil dulu: mengganti objek media setelah lagu mulai akan memulai ulang pemutaran
        const state = await attachLyrics(parsed, path);
        if (seq !== loadSeq.current) return; // pemuatan lain sudah dimulai setelah ini
        const prev = mediaRef.current;
        pendingClear.current = false;
        setMedia(state);
        setKaraoke(false);
        // lepas Blob URL rilisan sebelumnya setelah transisi selesai (gambar/latar lama masih memudar)
        if (prev) setTimeout(() => cleanupMediaState(prev), 3000);
        setSource({ path, name: file.name });
        setBooklet(false);
        setLibraryOpen(false);
        island.showAlert({ kind: 'loaded', text: 'LOADED' });
        if (desktop && path) {
          await desktop.recent.add({
            path,
            title: state.release.title,
            artist: state.release.artist,
            type: state.release.type ?? '',
            tracks: state.tracks.length,
            cover: await thumbFrom(state.artworkUrl),
            accent: state.theme.accentColor,
          });
          void refreshRecent();
        }
      } catch (e) {
        island.showAlert({ kind: 'error', text: alertTextFor(e) });
        console.warn('[load]', e);
        setToast(`${file.name}: ${t('error.open')}`);
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [island, refreshRecent, t],
  );

  const loadPath = useCallback(
    async (p: string) => {
      if (!desktop) return;
      try {
        const f = await desktop.readPath(p);
        await load(new File([f.data], f.name), f.path);
      } catch (e) {
        console.warn('[open]', e);
        setToast(t('error.open'));
        void refreshRecent();
      }
    },
    [load, refreshRecent],
  );

  const open = useCallback(async () => {
    if (!desktop) return picker.current?.click();
    const f = await desktop.openDialog({ title: t('dialog.open'), ritm: t('dialog.filter.ritm'), audio: t('dialog.filter.audio') });
    if (f) await load(new File([f.data], f.name), f.path);
  }, [load, t]);

  /** Buka folder: semua file audio di dalamnya menjadi playlist (metadata per file). Tanpa fitur eksklusif .ritm. */
  const openFolder = useCallback(async () => {
    if (!desktop) return folderInput.current?.click();
    const pick = await desktop.openFolder({ title: t('dialog.folder') });
    if (!pick) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      if (pick.files.length === 0) {
        setToast(t('folder.empty'));
        return;
      }
      const state = await buildFolderMedia(pick);
      if (seq !== loadSeq.current) return;
      const prev = mediaRef.current;
      pendingClear.current = false;
      setMedia(state);
      setKaraoke(false);
      if (prev) setTimeout(() => cleanupMediaState(prev), 3000);
      setSource({ path: pick.dir, name: pick.name });
      setBooklet(false);
      setLibraryOpen(false);
      island.showAlert({ kind: 'loaded', text: 'LOADED' });
    } catch (e) {
      console.warn('[folder]', e);
      setToast(t('error.folder'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [island, t]);

  // web: folder dipilih lewat input folder (webkitdirectory); bila browser tak mendukung, pilihan berkas jamak tetap jadi playlist
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  const onWebFolder = async (files: File[]) => {
    if (files.length === 0) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const state = await buildWebFolderMedia(files);
      if (seq !== loadSeq.current) return;
      if (state.tracks.length === 0) {
        setToast(t('folder.empty'));
        return;
      }
      const prev = mediaRef.current;
      pendingClear.current = false;
      setMedia(state);
      setKaraoke(false);
      if (prev) setTimeout(() => cleanupMediaState(prev), 3000);
      setSource(null);
      setBooklet(false);
      setLibraryOpen(false);
      island.showAlert({ kind: 'loaded', text: 'LOADED' });
    } catch (e) {
      console.warn('[folder]', e);
      setToast(t('error.folder'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  // file dari Explorer (saat start & saat app sudah berjalan)
  useEffect(() => {
    if (!desktop) return;
    void desktop.takePending().then((p) => {
      if (p) void loadPath(p);
    });
    return desktop.onOpenPath((p) => void loadPath(p));
  }, [loadPath]);

  // Ctrl+O · F11 layar penuh
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void open();
      } else if (e.key === 'F11') {
        e.preventDefault();
        void toggleFullScreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, toggleFullScreen]);

  // seret & lepas file ke jendela
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = () => {
      if (--depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) void load(file, desktop?.pathForFile(file) ?? null);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [load]);

  // PWA terpasang: file .ritm yang dibuka dari sistem (file_handlers di manifest). Hanya di browser.
  useEffect(() => {
    if (desktop) return;
    const lq = (window as unknown as { launchQueue?: { setConsumer: (cb: (p: { files: FileSystemFileHandle[] }) => void) => void } }).launchQueue;
    lq?.setConsumer((params) => {
      const handle = params.files[0];
      if (handle) void handle.getFile().then((file) => load(file, null));
    });
  }, [load]);

  // judul jendela & kontrol media OS (tombol media keyboard, overlay Windows)
  useEffect(() => {
    const t = engine.track;
    const title = t ? `${t.title} — ${t.artist} · RITM Player` : 'RITM Player';
    document.title = title;
    desktop?.setTitle(title);
  }, [engine.track]);
  useMediaSession(media, engine);

  // letak daftar lagu: desktop mengikuti jendela (maksimal / sempit → bawah). Web: sedang → kiri, sempit atau lebar → bawah (tengah)
  const trackPlacement: 'left' | 'bottom' = desktop
    ? maximized || narrowWindow
      ? 'bottom'
      : 'left'
    : viewW < 1180 || viewW >= 1800
      ? 'bottom'
      : 'left';

  const header = ({ immersive }: { immersive: boolean }) => (
    <div className="flex h-14 items-center gap-1 px-4 sm:px-6">
      <RitmBrand product="Player" />
      <span className="flex-1" />
      <OpenMenu onOpenFile={() => void open()} onOpenFolder={() => void openFolder()} immersive={immersive} />
      {media && desktop && (
        <HeaderBtn label={t('header.library')} onClick={() => setLibraryOpen(true)} immersive={immersive}>
          <LibraryIcon className="size-[18px]" strokeWidth={1.75} />
        </HeaderBtn>
      )}
      <HeaderBtn label={fullScreen ? t('header.exitFullScreen') : t('header.fullScreen')} onClick={() => void toggleFullScreen()} immersive={immersive}>
        {fullScreen ? <Minimize className="size-[18px]" strokeWidth={1.75} /> : <Maximize className="size-[18px]" strokeWidth={1.75} />}
      </HeaderBtn>
      <HeaderBtn label={t('header.settings')} onClick={() => setSettingsOpen(true)} immersive={immersive}>
        <Settings className="size-[18px]" strokeWidth={1.75} />
      </HeaderBtn>
      <HeaderBtn label={dark ? t('header.lightMode') : t('header.darkMode')} onClick={() => setDark((d) => !d)} immersive={immersive}>
        {dark ? <Sun className="size-[18px]" strokeWidth={1.75} /> : <Moon className="size-[18px]" strokeWidth={1.75} />}
      </HeaderBtn>
    </div>
  );

  const libraryView = (
    <Library
      items={recent}
      desktop={!!desktop}
      loading={loading}
      currentPath={source?.path ?? null}
      onOpen={open}
      onPick={(it) => void loadPath(it.path)}
      onRemove={async (it) => {
        await desktop?.recent.remove(it.path);
        const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
        if (source?.path && norm(source.path) === norm(it.path)) {
          // masih diputar: biarkan sampai stop; tidak diputar: langsung kosongkan layar utama
          if (engine.playing) pendingClear.current = true;
          else clearMedia();
        }
        void refreshRecent();
      }}
      onShow={(it) => void desktop?.showInFolder(it.path)}
    />
  );

  return (
    <>
      <PlayerStage
        media={media}
        engine={engine}
        island={island}
        header={header}
        empty={libraryView}
        trackList={media && media.tracks.length > 1 ? (
          <TrackList media={media} engine={engine} placement={trackPlacement} />
        ) : undefined}
        onOpenBooklet={() => setBooklet(true)}
        karaoke={media?.folderPath ? undefined : { available: !!engine.track?.karaoke, on: karaoke && !!engine.track?.karaoke, onToggle: () => setKaraoke((v) => !v) }}
      />

      {/* perpustakaan saat sedang memutar */}
      {libraryOpen && (
        <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label={t('library.dialog')}>
          <button type="button" tabIndex={-1} aria-label={t('common.close')} className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => setLibraryOpen(false)} />
          <div className="relative flex h-full w-full max-w-xl flex-col overflow-y-auto bg-neutral-50 p-6 shadow-[0_0_64px_rgba(0,0,0,0.2)] dark:bg-neutral-950">
            <div className="mb-2 flex justify-end">
              <button type="button" className="btn-icon" aria-label={t('library.close')} onClick={() => setLibraryOpen(false)}>
                <X className="size-4" />
              </button>
            </div>
            {libraryView}
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          linuxBackend={choice.controls?.settings.backend}
          onLinuxBackendChange={choice.controls ? (b) => choice.controls!.update({ backend: b }) : undefined}
        />
      )}

      {booklet && media?.booklet && <BookletModal media={media} onClose={() => setBooklet(false)} />}

      {intro && <IntroAnimation onDone={() => setIntro(false)} />}

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-[70] flex items-center justify-center rounded-3xl border-2 border-dashed border-amber-500 bg-amber-500/10 backdrop-blur-sm">
          <p className="rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-neutral-900">{t('drop.hint')}</p>
        </div>
      )}

      <input
        ref={picker}
        type="file"
        accept={ACCEPT}
        hidden
        data-testid="open-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void load(f, null);
          e.target.value = '';
        }}
      />

      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        data-testid="folder-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void onWebFolder(files);
        }}
      />

      <div
        role="status"
        aria-live="polite"
        className={`fixed top-16 left-1/2 z-[80] max-w-[90vw] -translate-x-1/2 truncate rounded-full bg-neutral-900 px-4 py-2.5 text-sm text-white shadow-[0_8px_32px_rgba(0,0,0,0.24)] transition-all duration-300 dark:bg-neutral-100 dark:text-neutral-900 ${
          toast ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0'
        }`}
      >
        {toast}
      </div>
    </>
  );
}

function HeaderBtn({ label, onClick, immersive, children }: { label: string; onClick: () => void; immersive: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex size-9 items-center justify-center rounded-full transition-colors ${
        immersive ? 'text-white/85 hover:bg-white/10' : 'text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-neutral-900'
      }`}
    >
      {children}
    </button>
  );
}
