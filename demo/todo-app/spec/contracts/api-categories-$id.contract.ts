// 📜 Mandu Contract - api-categories-$id
// Pattern: /api/categories/:id
// Category single item API - get, update name/color, delete

import { z } from "zod";
import { Mandu } from "@mandujs/core";

// ============================================
// 🥟 Schema Definitions
// ============================================

const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});

// ============================================
// 📜 Contract Definition
// ============================================

export default Mandu.contract({
  description: "Category single item get/update/delete API",
  tags: ["categories"],

  request: {
    GET: {},

    PUT: {
      body: z.object({
        name: z.string().min(1).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be hex color").optional(),
      }),
    },

    DELETE: {},
  },

  response: {
    200: z.object({
      category: CategorySchema,
    }),
    204: z.undefined(),
    404: z.object({
      error: z.string(),
    }),
  },
});
