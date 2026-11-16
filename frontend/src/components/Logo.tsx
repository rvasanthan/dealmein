export function LogoMark({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <rect x="20" y="6" width="36" height="46" rx="6" transform="rotate(10 38 29)" fill="#fff" stroke="#0f5e63" strokeWidth="3" />
      <path d="M44 20c-3-5-9-2-6 3 1.500 2.500 6 5 6 5s4.500-2.500 6-5c3-5-3-8-6-3z" fill="#f28c28" transform="rotate(10 44 24)" />
      <path d="M6 24h24l16 16-16 16H6z" fill="#0f5e63" />
      <circle cx="15" cy="40" r="3.200" fill="#fbf7f0" />
    </svg>
  )
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="leading-tight">
        <span className="brand-name block text-xl font-extrabold text-teal-800">Deal Me In<span className="brand-dot">.</span></span>
        <span className="hidden text-xs text-ink-soft sm:block">Great deals. Count me in.</span>
      </span>
    </span>
  )
}
