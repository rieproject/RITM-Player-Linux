import { useEffect, useRef, useState } from 'react';
import { File as FileIcon, Folder, FolderOpen } from 'lucide-react';
import { useI18n } from './i18n';

/** Satu tombol buka di header: menu kecil berisi "Buka file" dan "Buka folder". */
export function OpenMenu({ onOpenFile, onOpenFolder, immersive }: { onOpenFile: () => void; onOpenFolder: () => void; immersive: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t('header.openMenu')}
        title={t('header.openMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex size-9 items-center justify-center rounded-full transition-colors ${
          immersive ? 'text-white/85 hover:bg-white/10' : 'text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-neutral-900'
        }`}
      >
        <FolderOpen className="size-[18px]" strokeWidth={1.75} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-[90] min-w-48 overflow-hidden rounded-2xl border border-neutral-200 bg-white p-1 text-neutral-800 shadow-xl dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onOpenFile)}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <FileIcon className="size-4" strokeWidth={1.75} aria-hidden />
            {t('header.openFile')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onOpenFolder)}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Folder className="size-4" strokeWidth={1.75} aria-hidden />
            {t('header.openFolder')}
          </button>
        </div>
      )}
    </div>
  );
}
