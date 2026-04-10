// 📜 Mandu Contract - api-search
// Pattern: /api/search
// Global search API - search across todos, notes, categories by keyword

import { z } from "zod";
import { Mandu } from "@mandujs/core";

const PrioritySchema = z.enum(["high", "medium", "low"]);

const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  priority: PrioritySchema,
  dueDate: z.string().nullable(),
  categoryId: z.string().nullable(),
  createdAt: z.string(),
});

const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});

const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  todoId: z.string().nullable(),
  pinned: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export default Mandu.contract({
  description: "Global search across todos, notes, and categories",
  tags: ["search"],

  request: {
    GET: {
      query: z.object({
        q: z.string().default(""),
      }),
    },
  },

  response: {
    200: z.object({
      query: z.string(),
      todos: z.array(TodoSchema),
      categories: z.array(CategorySchema),
      notes: z.array(NoteSchema),
      totalCount: z.number().int(),
    }),
  },
});
