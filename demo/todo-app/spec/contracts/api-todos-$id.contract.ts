// 📜 Mandu Contract - api-todos-$id
// Pattern: /api/todos/:id
// Todo single item API - get, update, delete

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

// ============================================
// 📜 Contract Definition
// ============================================

export default Mandu.contract({
  description: "Todo single item get/update/delete API",
  tags: ["todos"],

  request: {
    GET: {},

    PUT: {
      body: z.object({
        title: z.string().min(1).optional(),
        completed: z.boolean().optional(),
        priority: PrioritySchema.optional(),
        dueDate: z.string().nullable().optional(),
        categoryId: z.string().nullable().optional(),
      }),
    },

    DELETE: {},
  },

  response: {
    200: z.object({
      todo: TodoSchema,
    }),
    204: z.undefined(),
    404: z.object({
      error: z.string(),
    }),
  },
});
