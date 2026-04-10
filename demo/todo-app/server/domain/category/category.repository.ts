import type { Category, UpdateCategoryInput } from "./category.types";

const DEFAULT_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

const categories: Category[] = [
  { id: "1", name: "Work", color: "#3b82f6" },
  { id: "2", name: "Personal", color: "#10b981" },
  { id: "3", name: "Study", color: "#f59e0b" },
];

let nextId = 4;

export const categoryRepository = {
  findAll(): Category[] {
    return [...categories];
  },

  findById(id: string): Category | undefined {
    return categories.find((c) => c.id === id);
  },

  create(name: string, color?: string): Category {
    const category: Category = {
      id: String(nextId++),
      name,
      color: color || DEFAULT_COLORS[(nextId - 1) % DEFAULT_COLORS.length],
    };
    categories.push(category);
    return category;
  },

  update(id: string, data: UpdateCategoryInput): Category | undefined {
    const category = categories.find((c) => c.id === id);
    if (!category) return undefined;
    if (data.name !== undefined) category.name = data.name;
    if (data.color !== undefined) category.color = data.color;
    return category;
  },

  delete(id: string): boolean {
    const index = categories.findIndex((c) => c.id === id);
    if (index === -1) return false;
    categories.splice(index, 1);
    return true;
  },
};
