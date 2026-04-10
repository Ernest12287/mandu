export type Priority = "high" | "medium" | "low";

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
  priority: Priority;
  dueDate: string | null;
  categoryId: string | null;
  createdAt: string;
}

export type TodoFilter = "all" | "active" | "completed";

export interface Category {
  id: string;
  name: string;
  color: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  todoId: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}
