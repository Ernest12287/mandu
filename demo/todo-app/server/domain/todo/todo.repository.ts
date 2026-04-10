import type { Todo, Priority, UpdateTodoInput } from "./todo.types";

const todos: Todo[] = [
  { id: "1", title: "Mandu 프레임워크 배우기", completed: false, priority: "high", dueDate: "2026-04-12", categoryId: "3", createdAt: new Date().toISOString() },
  { id: "2", title: "Island 컴포넌트 만들기", completed: false, priority: "medium", dueDate: "2026-04-15", categoryId: "1", createdAt: new Date().toISOString() },
  { id: "3", title: "API 라우트 테스트", completed: true, priority: "low", dueDate: null, categoryId: "1", createdAt: new Date().toISOString() },
];

let nextId = 4;

export const todoRepository = {
  findAll(): Todo[] {
    return [...todos];
  },

  findById(id: string): Todo | undefined {
    return todos.find((t) => t.id === id);
  },

  create(title: string, priority: Priority = "medium", dueDate: string | null = null, categoryId: string | null = null): Todo {
    const todo: Todo = {
      id: String(nextId++),
      title,
      completed: false,
      priority,
      dueDate,
      categoryId,
      createdAt: new Date().toISOString(),
    };
    todos.push(todo);
    return todo;
  },

  update(id: string, data: UpdateTodoInput): Todo | undefined {
    const todo = todos.find((t) => t.id === id);
    if (!todo) return undefined;
    if (data.title !== undefined) todo.title = data.title;
    if (data.completed !== undefined) todo.completed = data.completed;
    if (data.priority !== undefined) todo.priority = data.priority;
    if (data.dueDate !== undefined) todo.dueDate = data.dueDate;
    if (data.categoryId !== undefined) todo.categoryId = data.categoryId;
    return todo;
  },

  delete(id: string): boolean {
    const index = todos.findIndex((t) => t.id === id);
    if (index === -1) return false;
    todos.splice(index, 1);
    return true;
  },

  clearCompleted(): number {
    const before = todos.length;
    const remaining = todos.filter((t) => !t.completed);
    todos.length = 0;
    todos.push(...remaining);
    return before - todos.length;
  },
};
