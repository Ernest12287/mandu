// Island-First: categories.client.tsx → CategoryManager island
import { categoryService } from "../../server/domain/category/category.service";

export default function CategoriesPage() {
  const categories = categoryService.list();

  return (
    <div>
      <h1
        className="text-4xl mb-1"
        style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}
      >
        Categories
      </h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-ink-muted)' }}>
        {categories.length} categories to organize your work
      </p>
      <div
        data-island="category-manager"
        data-props={JSON.stringify({ initialCategories: categories })}
      >
        {/* SSR fallback */}
        <div className="space-y-3">
          {categories.map((cat) => (
            <div key={cat.id} className="card p-4 flex items-center gap-4">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-semibold"
                style={{ backgroundColor: cat.color }}
              >
                {cat.name.charAt(0)}
              </div>
              <span className="text-sm font-medium" style={{ color: 'var(--color-ink)' }}>
                {cat.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
