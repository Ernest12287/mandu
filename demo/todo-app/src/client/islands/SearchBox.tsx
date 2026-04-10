import { island } from "@mandujs/core/client";
import { useState, useCallback, useEffect } from "react";
import type { Todo, Category, Note } from "../../shared/types";

interface SearchBoxData {
  initialQuery: string;
}

interface SearchResult {
  query: string;
  todos: Todo[];
  categories: Category[];
  notes: Note[];
  totalCount: number;
}

export default island<SearchBoxData>({
  setup: (serverData) => {
    const [query, setQuery] = useState(serverData.initialQuery || "");
    const [results, setResults] = useState<SearchResult | null>(null);
    const [loading, setLoading] = useState(false);

    const doSearch = useCallback(async (q: string) => {
      if (!q.trim()) {
        setResults(null);
        return;
      }
      setLoading(true);
      const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      setResults(data);
      setLoading(false);
    }, []);

    useEffect(() => {
      const timer = setTimeout(() => doSearch(query), 300);
      return () => clearTimeout(timer);
    }, [query, doSearch]);

    return { query, setQuery, results, loading };
  },

  render: ({ query, setQuery, results, loading }) => (
    <div>
      {/* Search input */}
      <div className="relative mb-8">
        <div
          className="absolute left-4 top-1/2 -translate-y-1/2 text-lg"
          style={{ color: 'var(--color-ink-faint)' }}
        >
          🔍
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search todos, notes, categories..."
          className="input-warm pl-12 py-4 text-base"
          style={{ borderWidth: '2px' }}
          autoFocus
        />
        {loading && (
          <div
            className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-medium"
            style={{ color: 'var(--color-ink-faint)' }}
          >
            Searching...
          </div>
        )}
      </div>

      {/* Empty state */}
      {results === null && !loading && (
        <div className="card p-10 text-center">
          <div className="text-3xl mb-3">🔍</div>
          <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>Type to search across all your data.</p>
        </div>
      )}

      {/* No results */}
      {results && results.totalCount === 0 && (
        <div className="card p-10 text-center">
          <div className="text-3xl mb-3">🤷</div>
          <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            No results for "<strong>{results.query}</strong>"
          </p>
        </div>
      )}

      {/* Results */}
      {results && results.totalCount > 0 && (
        <div className="space-y-8">
          <p className="text-xs font-medium" style={{ color: 'var(--color-ink-faint)' }}>
            {results.totalCount} result(s) for "<strong style={{ color: 'var(--color-ink)' }}>{results.query}</strong>"
          </p>

          {results.todos.length > 0 && (
            <section>
              <div className="section-label mb-3">Todos ({results.todos.length})</div>
              <div className="space-y-2">
                {results.todos.map((todo) => (
                  <div key={todo.id} className="card p-4 flex items-center gap-3">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: todo.completed ? 'var(--color-sage)' : 'var(--color-teal)' }}
                    />
                    <span
                      className="text-sm flex-1"
                      style={{
                        color: todo.completed ? 'var(--color-ink-faint)' : 'var(--color-ink)',
                        textDecoration: todo.completed ? 'line-through' : 'none',
                      }}
                    >
                      {todo.title}
                    </span>
                    <span className={`badge badge-${todo.priority}`}>{todo.priority}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {results.notes.length > 0 && (
            <section>
              <div className="section-label mb-3">Notes ({results.notes.length})</div>
              <div className="space-y-2">
                {results.notes.map((note) => (
                  <div
                    key={note.id}
                    className="card p-4"
                    style={note.pinned ? { borderLeftWidth: '4px', borderLeftColor: 'var(--color-amber)' } : {}}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {note.pinned && <span style={{ color: 'var(--color-amber)' }}>★</span>}
                      <h3 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-ink)' }}>
                        {note.title}
                      </h3>
                    </div>
                    <p className="text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--color-ink-light)' }}>
                      {note.content}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {results.categories.length > 0 && (
            <section>
              <div className="section-label mb-3">Categories ({results.categories.length})</div>
              <div className="flex gap-3 flex-wrap">
                {results.categories.map((cat) => (
                  <span
                    key={cat.id}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-white font-semibold"
                    style={{ backgroundColor: cat.color }}
                  >
                    {cat.name}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  ),
});
