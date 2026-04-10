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

export interface CreateTodoInput {
  title: string;
  priority?: Priority;
  dueDate?: string | null;
  categoryId?: string | null;
}

export interface UpdateTodoInput {
  title?: string;
  completed?: boolean;
  priority?: Priority;
  dueDate?: string | null;
  categoryId?: string | null;
}
