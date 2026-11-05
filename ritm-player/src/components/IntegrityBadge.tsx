import type { IntegrityReport } from '../types/ritm';
import { usePlayerI18n } from '../i18n';

const STYLE: Record<IntegrityReport['status'], string> = {
  verified: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  unsigned: 'bg-neutral-200/80 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  tampered: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

/** Badge status integritas arsip (unsigned / tampered / verified). */
export function IntegrityBadge({ report }: { report: IntegrityReport }) {
  const { t } = usePlayerI18n();
  const key = report.status;
  const label = t(`integrity.${key}` as const);
  const title =
    report.status === 'tampered'
      ? t('integrity.tamperedTitle', { files: report.mismatched.join(', ') || '-' })
      : t(`integrity.${key}Title` as const);
  return (
    <span
      title={title}
      className={`inline-flex h-[22px] items-center rounded-full px-2.5 text-[10px] font-bold tracking-[0.06em] ${STYLE[report.status]}`}
    >
      {label}
    </span>
  );
}
