// Island-First: todos.client.tsx → TodoList island
import { todoService } from "../../server/domain/todo/todo.service";
import { categoryService } from "../../server/domain/category/category.service";

export default function TodosPage() {
  const todos = todoService.list("all");
  const categories = categoryService.list();

  return (
    <div>
      <h1
        className="text-4xl mb-1"
        style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}
      >
        Todos
      </h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-ink-muted)' }}>
        {todos.filter((t) => !t.completed).length} active, {todos.filter((t) => t.completed).length} completed
      </p>
      <div
        data-island="todo-list"
        data-props={JSON.stringify({ initialTodos: todos, categories })}
      >
        {/* SSR fallback */}
        <div className="space-y-3">
          {todos.map((todo) => (
            <div key={todo.id} className="card p-4 flex items-center gap-4">
              <div
                className="checkbox-warm"
                style={todo.completed ? { background: 'var(--color-sage)', borderColor: 'var(--color-sage)' } : {}}
              >
                {todo.completed && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6L5 8.5L9.5 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <span
                className="text-sm"
                style={{
                  color: todo.completed ? 'var(--color-ink-faint)' : 'var(--color-ink)',
                  textDecoration: todo.completed ? 'line-through' : 'none',
                }}
              >
                {todo.title}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
