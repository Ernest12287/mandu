import { Mandu } from "@mandujs/core";
import { categoryService } from "../../../../server/domain/category/category.service";

export default Mandu.filling()
  .get((ctx) => {
    const category = categoryService.getById(ctx.params.id);
    if (!category) return ctx.notFound("Category not found");
    return ctx.ok({ category });
  })
  .put(async (ctx) => {
    const body = await ctx.body<{ name?: string; color?: string }>();
    const category = categoryService.update(ctx.params.id, body);
    if (!category) return ctx.notFound("Category not found");
    return ctx.ok({ category });
  })
  .delete((ctx) => {
    const deleted = categoryService.delete(ctx.params.id);
    if (!deleted) return ctx.notFound("Category not found");
    return ctx.noContent();
  });
