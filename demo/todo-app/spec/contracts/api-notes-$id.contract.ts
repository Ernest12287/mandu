// 📜 Mandu Contract - api-notes-$id
// Pattern: /api/notes/:id
// Note single item API - get, update, delete

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

export default Mandu.contract({
  description: "Note single item get/update/delete API",
  tags: ["notes"],

  request: {
    GET: {},

    PUT: {
      body: z.object({
        title: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
        todoId: z.string().nullable().optional(),
        pinned: z.boolean().optional(),
      }),
    },

    DELETE: {},
  },

  response: {
    200: z.object({
      note: NoteSchema,
    }),
    204: z.undefined(),
    404: z.object({
      error: z.string(),
    }),
  },
});
