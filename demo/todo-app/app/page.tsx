import { todoService } from "../server/domain/todo/todo.service";
import { categoryService } from "../server/domain/category/category.service";
import { noteService } from "../server/domain/note/note.service";

export default function HomePage() {
  const stats = todoService.stats();
  const noteStats = noteService.stats();
  const categories = categoryService.list();
  const allTodos = todoService.list("all");

  const categoryStats = categories.map((cat) => {
    const catTodos = allTodos.filter((t) => t.categoryId === cat.id);
    return {
      ...cat,
      total: catTodos.length,
      active: catTodos.filter((t) => !t.completed).length,
    };
  });

  const uncategorized = allTodos.filter((t) => !t.categoryId).length;

  return (
    <div>
      {/* Hero */}
      <div className="mb-12">
        <h1
          className="text-5xl mb-3 leading-tight"
          style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}
        >
          Your tasks,{" "}
          <span style={{ color: 'var(--color-terracotta)' }}>organized.</span>
        </h1>
        <p className="text-lg leading-relaxed" style={{ color: 'var(--color-ink-muted)', maxWidth: '480px' }}>
          Mandu 프레임워크의 CRUD, Island Hydration, Zod Contracts를 시연하는 데모 앱입니다.
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="card p-5">
          <div className="stat-number" style={{ color: 'var(--color-ink)' }}>{stats.total}</div>
          <div className="section-label mt-1">Total Todos</div>
        </div>
        <div className="card p-5">
          <div className="stat-number" style={{ color: 'var(--color-terracotta)' }}>{stats.active}</div>
          <div className="section-label mt-1">Active</div>
        </div>
        <div className="card p-5">
          <div className="stat-number" style={{ color: 'var(--color-sage)' }}>{stats.completed}</div>
          <div className="section-label mt-1">Completed</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-10">
        <div className="card p-5">
          <div className="stat-number" style={{ color: 'var(--color-plum)' }}>{noteStats.total}</div>
          <div className="section-label mt-1">Notes</div>
        </div>
        <div className="card p-5">
          <div className="stat-number" style={{ color: 'var(--color-amber)' }}>{noteStats.pinned}</div>
          <div className="section-label mt-1">Pinned</div>
        </div>
        <div className="card p-5">
          <div className="stat-number" style={{ color: 'var(--color-teal)' }}>{noteStats.linked}</div>
          <div className="section-label mt-1">Linked</div>
        </div>
      </div>

      {/* Category breakdown */}
      {categoryStats.length > 0 && (
        <section className="mb-10">
          <div className="section-label mb-3">By Category</div>
          <div className="grid grid-cols-2 gap-3">
            {categoryStats.map((cat) => (
              <div key={cat.id} className="card p-4 flex items-center gap-4">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-semibold"
                  style={{ backgroundColor: cat.color }}
                >
                  {cat.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--color-ink)' }}>{cat.name}</div>
                  <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>
                    {cat.active} active / {cat.total} total
                  </div>
                </div>
              </div>
            ))}
            {uncategorized > 0 && (
              <div className="card p-4 flex items-center gap-4">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-semibold"
                  style={{ backgroundColor: 'var(--color-cream-dark)', color: 'var(--color-ink-muted)' }}
                >
                  ?
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold" style={{ color: 'var(--color-ink)' }}>Uncategorized</div>
                  <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>{uncategorized} todos</div>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* CTA buttons */}
      <div className="flex gap-3 mb-12">
        <a href="/todos" className="btn-primary" style={{ textDecoration: 'none' }}>
          Manage Todos
        </a>
        <a href="/notes" className="btn-secondary" style={{ textDecoration: 'none' }}>
          View Notes
        </a>
        <a href="/dashboard" className="btn-secondary" style={{ textDecoration: 'none' }}>
          Dashboard
        </a>
      </div>

      {/* API section */}
      <section>
        <div className="section-label mb-4">API Endpoints</div>
        <div className="card p-5">
          <div className="grid gap-2 text-sm" style={{ color: 'var(--color-ink-light)' }}>
            {[
              ["GET", "/api/todos?filter=all|active|completed"],
              ["POST", "/api/todos", "Create (title, priority?, dueDate?, categoryId?)"],
              ["PUT", "/api/todos/:id", "Update"],
              ["DELETE", "/api/todos/:id", "Delete"],
            ].map(([method, path, desc], i) => (
              <div key={i} className="flex items-center gap-3">
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-md w-12 text-center"
                  style={{
                    background: method === "GET" ? 'var(--color-sage-light)' :
                      method === "POST" ? 'var(--color-teal-light)' :
                      method === "PUT" ? 'var(--color-amber-light)' :
                      'var(--color-terracotta-light)',
                    color: method === "GET" ? 'var(--color-sage-dark)' :
                      method === "POST" ? 'var(--color-teal)' :
                      method === "PUT" ? '#9A7230' :
                      'var(--color-terracotta)',
                  }}
                >
                  {method}
                </span>
                <code className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-ink)' }}>
                  {path}
                </code>
                {desc && <span className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>— {desc}</span>}
              </div>
            ))}
            <div className="my-1" style={{ borderTop: '1px solid var(--color-border)' }} />
            {[
              ["GET", "/api/categories", "List"],
              ["POST", "/api/categories", "Create (name, color?)"],
              ["GET", "/api/notes?todoId=", "List (filter by todo)"],
              ["POST", "/api/notes", "Create (title, content, todoId?, pinned?)"],
              ["GET", "/api/search?q=", "Global search"],
            ].map(([method, path, desc], i) => (
              <div key={i} className="flex items-center gap-3">
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-md w-12 text-center"
                  style={{
                    background: method === "GET" ? 'var(--color-sage-light)' : 'var(--color-teal-light)',
                    color: method === "GET" ? 'var(--color-sage-dark)' : 'var(--color-teal)',
                  }}
                >
                  {method}
                </span>
                <code className="text-xs" style={{ fontFamily: 'var(--font-body)', color: 'var(--color-ink)' }}>
                  {path}
                </code>
                {desc && <span className="text-xs" style={{ color: 'var(--color-ink-faint)' }}>— {desc}</span>}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
