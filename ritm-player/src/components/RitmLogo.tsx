import logoBlack from '../../assets/ritm-logo-black.svg';
import logoWhite from '../../assets/ritm-logo-white.svg';

/**
 * Logo RITM dari file asli (assets/ritm-logo-black.svg dan ritm-logo-white.svg).
 * variant "auto": putih di mode gelap, hitam di mode terang. "white" / "black": selalu satu warna
 * (mis. layar pembuka di atas latar gelap).
 */
export function RitmLogo({
  className = 'h-5 w-auto',
  title = 'RITM',
  variant = 'auto',
}: {
  className?: string;
  title?: string;
  variant?: 'auto' | 'white' | 'black';
}) {
  if (variant === 'white') return <img src={logoWhite} alt={title} className={className} draggable={false} />;
  if (variant === 'black') return <img src={logoBlack} alt={title} className={className} draggable={false} />;
  return (
    <>
      <img src={logoBlack} alt={title} className={`dark:hidden ${className}`} draggable={false} />
      <img src={logoWhite} alt={title} className={`hidden dark:block ${className}`} draggable={false} />
    </>
  );
}

/** Format merek: [LOGO] /NAMA — mis. RITM /ARCHIVER, RITM /SPACE, RITM /PLAYER. */
export function RitmBrand({ product, className = '', logoClassName = 'h-[18px] w-auto' }: { product: string; className?: string; logoClassName?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <RitmLogo className={logoClassName} />
      <span className="text-[13px] leading-none font-semibold tracking-[0.12em] uppercase opacity-55">/{product}</span>
    </span>
  );
}
