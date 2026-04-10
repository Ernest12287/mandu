import type { Todo } from "../todo/todo.types";
import type { Category } from "../category/category.types";
import type { Note } from "../note/note.types";

export interface SearchResult {
  query: string;
  todos: Todo[];
  categories: Category[];
  notes: Note[];
  totalCount: number;
}
