import { todoRepository } from "./todo.repository";
import type { Todo, TodoFilter, CreateTodoInput, UpdateTodoInput, Priority } from "./todo.types";

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function sortTodos(todos: Todo[]): Todo[] {
  return todos.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pa !== 0) return pa;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
}

export const todoService = {
  list(filter: TodoFilter = "all"): Todo[] {
    const todos = todoRepository.findAll();
    let filtered: Todo[];
    switch (filter) {
      case "active":
        filtered = todos.filter((t) => !t.completed);
        break;
      case "completed":
        filtered = todos.filter((t) => t.completed);
        break;
      default:
        filtered = todos;
    }
    return sortTodos(filtered);
  },

  getById(id: string): Todo | undefined {
    return todoRepository.findById(id);
  },

  create(input: CreateTodoInput): Todo {
    return todoRepository.create(input.title.trim(), input.priority, input.dueDate ?? null, input.categoryId ?? null);
  },

  update(id: string, input: UpdateTodoInput): Todo | undefined {
    return todoRepository.update(id, input);
  },

  delete(id: string): boolean {
    return todoRepository.delete(id);
  },

  clearCompleted(): number {
    return todoRepository.clearCompleted();
  },

  stats() {
    const all = todoRepository.findAll();
    return {
      total: all.length,
      active: all.filter((t) => !t.completed).length,
      completed: all.filter((t) => t.completed).length,
    };
  },
};
