import { categoryRepository } from "./category.repository";
import type { Category, CreateCategoryInput, UpdateCategoryInput } from "./category.types";

export const categoryService = {
  list(): Category[] {
    return categoryRepository.findAll();
  },

  getById(id: string): Category | undefined {
    return categoryRepository.findById(id);
  },

  create(input: CreateCategoryInput): Category {
    return categoryRepository.create(input.name.trim(), input.color);
  },

  update(id: string, input: UpdateCategoryInput): Category | undefined {
    return categoryRepository.update(id, input);
  },

  delete(id: string): boolean {
    return categoryRepository.delete(id);
  },
};
