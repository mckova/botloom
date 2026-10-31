/** BotLoom mark: three warp threads crossed by a weft that steps over and under them. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="0.5" y="0.5" width="19" height="19" rx="4.5" fill="#b4441f" />
      <path d="M6 4v12M10 4v12M14 4v12" stroke="#f5e6de" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
      <path d="M3.5 10c1.2 0 1.6-1.6 2.5-1.6s1.6 3.2 4 3.2 3.1-3.2 4-3.2 1.3 1.6 2.5 1.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
