import { Mandu } from "@mandujs/core";
import { categoryService } from "../../../server/domain/category/category.service";

export default Mandu.filling()
  .get((ctx) => {
    const categories = categoryService.list();
    return ctx.ok({ categories });
  })
  .post(async (ctx) => {
    const body = await ctx.body<{ name: string; color?: string }>();

    if (!body.name?.trim()) {
      return ctx.error("Name is required");
    }

    const category = categoryService.create({ name: body.name, color: body.color });
    return ctx.created({ category });
  });
