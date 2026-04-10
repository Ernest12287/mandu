import { todoService } from "../todo/todo.service";
import { categoryService } from "../category/category.service";
import { noteService } from "../note/note.service";
import type { SearchResult } from "./search.types";

export const searchService = {
  search(query: string): SearchResult {
    const q = query.toLowerCase().trim();
    if (!q) {
      return { query, todos: [], categories: [], notes: [], totalCount: 0 };
    }

    const todos = todoService.list("all").filter((t) =>
      t.title.toLowerCase().includes(q)
    );

    const categories = categoryService.list().filter((c) =>
      c.name.toLowerCase().includes(q)
    );

    const notes = noteService.list().filter((n) =>
      n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
    );

    return {
      query,
      todos,
      categories,
      notes,
      totalCount: todos.length + categories.length + notes.length,
    };
  },
};
