// Island-First: search.client.tsx → SearchBox island
export default function SearchPage() {
  return (
    <div>
      <h1
        className="text-4xl mb-1"
        style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}
      >
        Search
      </h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-ink-muted)' }}>
        Find anything across todos, notes, and categories
      </p>
      <div
        data-island="search-box"
        data-props={JSON.stringify({ initialQuery: "" })}
      >
        {/* SSR fallback */}
        <div className="card p-10 text-center">
          <div className="text-3xl mb-3">🔍</div>
          <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>Type to search across all your data.</p>
        </div>
      </div>
    </div>
  );
}
