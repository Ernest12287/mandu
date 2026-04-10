// 📜 Mandu Contract - api-todos
// Pattern: /api/todos
// Todo CRUD API - list with filters, create with priority/dueDate/category, clear completed

import { z } from "zod";
import { Mandu } from "@mandujs/core";

// ============================================
// 🥟 Schema Definitions
// ============================================

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

const StatsSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  completed: z.number().int(),
});

// ============================================
// 📜 Contract Definition
// ============================================

export default Mandu.contract({
  description: "Todo list/create/clear API",
  tags: ["todos"],

  normalize: "strip",
  coerceQueryParams: true,
  request: {
    GET: {
      query: z.object({
        filter: z.enum(["all", "active", "completed"]).default("all"),
      }),
    },

    POST: {
      body: z.object({
        title: z.string().min(1, "Title is required"),
        priority: PrioritySchema.optional().default("medium"),
        dueDate: z.string().optional(),
        categoryId: z.string().optional(),
      }),
    },

    DELETE: {},
  },

  response: {
    200: z.object({
      todos: z.array(TodoSchema),
      stats: StatsSchema,
    }),
    201: z.object({
      todo: TodoSchema,
    }),
    400: z.object({
      error: z.string(),
    }),
  },
});
