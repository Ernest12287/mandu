interface RootLayoutProps {
  children: React.ReactNode;
}

const NAV_ITEMS = [
  { href: "/", label: "Home" },
  { href: "/todos", label: "Todos" },
  { href: "/categories", label: "Categories" },
  { href: "/notes", label: "Notes" },
  { href: "/search", label: "Search" },
  { href: "/dashboard", label: "Dashboard" },
];

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <div className="min-h-screen grain" style={{ fontFamily: 'var(--font-body)' }}>
      <header
        className="sticky top-0 z-50 backdrop-blur-md"
        style={{
          background: 'rgba(248, 245, 240, 0.85)',
          borderBottom: '2px solid var(--color-border)',
        }}
      >
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-8">
          <a
            href="/"
            className="flex items-center gap-2 group"
            style={{ textDecoration: 'none' }}
          >
            <span className="text-2xl" role="img" aria-label="mandu">🥟</span>
            <span
              className="text-xl tracking-tight"
              style={{
                fontFamily: 'var(--font-display)',
                color: 'var(--color-ink)',
                fontStyle: 'italic',
              }}
            >
              Mandu
            </span>
          </a>
          <nav className="flex gap-1">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="nav-link px-3 py-1.5 rounded-lg text-sm font-medium"
                style={{
                  color: 'var(--color-ink-light)',
                  textDecoration: 'none',
                  transition: 'color 0.2s, background 0.2s',
                }}
                onMouseEnter={(e) => {
                  (e.target as HTMLElement).style.color = 'var(--color-ink)';
                  (e.target as HTMLElement).style.background = 'var(--color-cream-dark)';
                }}
                onMouseLeave={(e) => {
                  (e.target as HTMLElement).style.color = 'var(--color-ink-light)';
                  (e.target as HTMLElement).style.background = 'transparent';
                }}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-10">
        {children}
      </main>
      <footer
        className="text-center py-8 text-xs"
        style={{ color: 'var(--color-ink-faint)' }}
      >
        Built with Mandu Framework — Island Architecture + Zod Contracts
      </footer>
    </div>
  );
}
