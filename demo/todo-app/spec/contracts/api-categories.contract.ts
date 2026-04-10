// 📜 Mandu Contract - api-categories
// Pattern: /api/categories
// Category CRUD API - list all, create with name and color

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
  description: "Category list/create API",
  tags: ["categories"],

  normalize: "strip",
  coerceQueryParams: true,
  request: {
    GET: {},

    POST: {
      body: z.object({
        name: z.string().min(1, "Name is required"),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be hex color").optional(),
      }),
    },
  },

  response: {
    200: z.object({
      categories: z.array(CategorySchema),
    }),
    201: z.object({
      category: CategorySchema,
    }),
    400: z.object({
      error: z.string(),
    }),
  },
});
