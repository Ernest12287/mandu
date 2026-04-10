import { Mandu } from "@mandujs/core";
import { noteService } from "../../../../server/domain/note/note.service";

export default Mandu.filling()
  .get((ctx) => {
    const note = noteService.getById(ctx.params.id);
    if (!note) return ctx.notFound("Note not found");
    return ctx.ok({ note });
  })
  .put(async (ctx) => {
    const body = await ctx.body<{ title?: string; content?: string; todoId?: string | null; pinned?: boolean }>();
    const note = noteService.update(ctx.params.id, body);
    if (!note) return ctx.notFound("Note not found");
    return ctx.ok({ note });
  })
  .delete((ctx) => {
    const deleted = noteService.delete(ctx.params.id);
    if (!deleted) return ctx.notFound("Note not found");
    return ctx.noContent();
  });
