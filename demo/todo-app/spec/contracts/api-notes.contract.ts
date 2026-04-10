// 📜 Mandu Contract - api-notes
// Pattern: /api/notes
// Notes API - list with optional todoId filter, create with title/content/todoId/pinned

import { z } from "zod";
import { Mandu } from "@mandujs/core";

const NoteSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  todoId: z.string().nullable(),
  pinned: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const StatsSchema = z.object({
  total: z.number().int(),
  pinned: z.number().int(),
  linked: z.number().int(),
});

export default Mandu.contract({
  description: "Notes list/create API",
  tags: ["notes"],

  normalize: "strip",
  coerceQueryParams: true,
  request: {
    GET: {
      query: z.object({
        todoId: z.string().optional(),
      }),
    },

    POST: {
      body: z.object({
        title: z.string().min(1, "Title is required"),
        content: z.string().min(1, "Content is required"),
        todoId: z.string().optional(),
        pinned: z.boolean().optional().default(false),
      }),
    },
  },

  response: {
    200: z.object({
      notes: z.array(NoteSchema),
      stats: StatsSchema,
    }),
    201: z.object({
      note: NoteSchema,
    }),
    400: z.object({
      error: z.string(),
    }),
  },
});
