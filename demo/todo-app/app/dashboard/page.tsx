// Island-First: static page (no island needed — pure SSR)
import { todoService } from "../../server/domain/todo/todo.service";
import { categoryService } from "../../server/domain/category/category.service";
import { noteService } from "../../server/domain/note/note.service";

export default function DashboardPage() {
  const todos = todoService.list("all");
  const categories = categoryService.list();
  const noteStats = noteService.stats();
  const todoStats = todoService.stats();

  const completionRate = todoStats.total > 0
    ? Math.round((todoStats.completed / todoStats.total) * 100)
    : 0;

  const overdueTodos = todos.filter((t) => {
    if (t.completed || !t.dueDate) return false;
    return new Date(t.dueDate + "T23:59:59") < new Date();
  });

  const priorityCounts = { high: 0, medium: 0, low: 0 };
  todos.filter((t) => !t.completed).forEach((t) => {
    priorityCounts[t.priority]++;
  });

  const categoryDistribution = categories.map((cat) => {
    const count = todos.filter((t) => t.categoryId === cat.id).length;
    return { ...cat, count };
  }).sort((a, b) => b.count - a.count);

  return (
    <div>
      <h1
        className="text-4xl mb-1"
        style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}
      >
        Dashboard
      </h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-ink-muted)' }}>
        Overview of your productivity
      </p>

      {/* Completion meter */}
      <section className="mb-8">
        <div className="section-label mb-3">Completion Rate</div>
        <div className="card p-6">
          <div className="flex items-end justify-between mb-4">
            <div>
              <div
                className="text-6xl leading-none"
                style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', color: 'var(--color-sage)' }}
              >
                {completionRate}%
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>{todoStats.completed} of {todoStats.total}</div>
              <div className="text-xs" style={{ color: 'var(--color-ink-muted)' }}>tasks completed</div>
            </div>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${completionRate}%` }} />
          </div>
        </div>
      </section>

      {/* Overview cards */}
      <section className="grid grid-cols-4 gap-3 mb-8">
        {[
          { value: todoStats.total, label: "Todos", color: 'var(--color-ink)' },
          { value: noteStats.total, label: "Notes", color: 'var(--color-plum)' },
          { value: categories.length, label: "Categories", color: 'var(--color-teal)' },
          { value: overdueTodos.length, label: "Overdue", color: 'var(--color-terracotta)' },
        ].map((item) => (
          <div key={item.label} className="card p-4 text-center">
            <div className="stat-number" style={{ color: item.color }}>{item.value}</div>
            <div className="section-label mt-1">{item.label}</div>
          </div>
        ))}
      </section>

      {/* Priority breakdown */}
      <section className="mb-8">
        <div className="section-label mb-3">Active by Priority</div>
        <div className="card p-5">
          <div className="flex gap-0">
            {[
              { count: priorityCounts.high, label: "High", color: 'var(--color-terracotta)', bg: 'var(--color-terracotta-light)' },
              { count: priorityCounts.medium, label: "Medium", color: 'var(--color-amber)', bg: 'var(--color-amber-light)' },
              { count: priorityCounts.low, label: "Low", color: 'var(--color-ink-muted)', bg: 'var(--color-cream-dark)' },
            ].map((item, i) => (
              <div
                key={item.label}
                className="flex-1 text-center py-3 rounded-xl"
                style={{ background: item.bg }}
              >
                <div
                  className="text-2xl font-bold mb-0.5"
                  style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', color: item.color }}
                >
                  {item.count}
                </div>
                <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: item.color, opacity: 0.7 }}>
                  {item.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Category distribution */}
      {categoryDistribution.length > 0 && (
        <section className="mb-8">
          <div className="section-label mb-3">Category Distribution</div>
          <div className="card p-5 space-y-4">
            {categoryDistribution.map((cat) => (
              <div key={cat.id} className="flex items-center gap-4">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                  style={{ backgroundColor: cat.color }}
                >
                  {cat.name.charAt(0)}
                </div>
                <span className="text-sm font-medium flex-1" style={{ color: 'var(--color-ink)' }}>{cat.name}</span>
                <div className="w-32">
                  <div className="progress-track" style={{ height: '8px' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        backgroundColor: cat.color,
                        width: `${todoStats.total > 0 ? (cat.count / todoStats.total) * 100 : 0}%`,
                        transition: 'width 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    />
                  </div>
                </div>
                <span className="text-xs font-semibold w-6 text-right" style={{ color: 'var(--color-ink-muted)' }}>{cat.count}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Overdue items */}
      {overdueTodos.length > 0 && (
        <section>
          <div className="section-label mb-3" style={{ color: 'var(--color-terracotta)' }}>
            Overdue ({overdueTodos.length})
          </div>
          <div className="space-y-2">
            {overdueTodos.map((todo) => (
              <div
                key={todo.id}
                className="card flex items-center gap-3 p-4"
                style={{ borderColor: 'var(--color-terracotta-light)', background: '#FEF8F6' }}
              >
                <div className="w-2 h-2 rounded-full" style={{ background: 'var(--color-terracotta)' }} />
                <span className="text-sm flex-1" style={{ color: 'var(--color-ink)' }}>{todo.title}</span>
                <span className="badge badge-high">{todo.dueDate}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
