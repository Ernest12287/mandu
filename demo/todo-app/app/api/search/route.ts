import { Mandu } from "@mandujs/core";
import { searchService } from "../../../server/domain/search/search.service";

export default Mandu.filling()
  .get((ctx) => {
    const q = (ctx.query.q as string) || "";
    const result = searchService.search(q);
    return ctx.ok(result);
  });
