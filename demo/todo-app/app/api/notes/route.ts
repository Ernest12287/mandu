import { Mandu } from "@mandujs/core";
import { noteService } from "../../../server/domain/note/note.service";

export default Mandu.filling()
  .get((ctx) => {
    const todoId = ctx.query.todoId as string | undefined;
    const notes = todoId ? noteService.getByTodoId(todoId) : noteService.list();
    const stats = noteService.stats();
    return ctx.ok({ notes, stats });
  })
  .post(async (ctx) => {
    const body = await ctx.body<{ title: string; content: string; todoId?: string; pinned?: boolean }>();

    if (!body.title?.trim()) return ctx.error("Title is required");
    if (!body.content?.trim()) return ctx.error("Content is required");

    const note = noteService.create({
      title: body.title,
      content: body.content,
      todoId: body.todoId ?? null,
      pinned: body.pinned,
    });
    return ctx.created({ note });
  });
