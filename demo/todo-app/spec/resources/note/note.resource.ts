import { z } from "zod";

export const NoteSchema = z.object({
  id: z.string(),
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
  todoId: z.string().nullable().default(null),
  pinned: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateNoteSchema = NoteSchema.pick({
  title: true,
  content: true,
  todoId: true,
  pinned: true,
});

export const UpdateNoteSchema = CreateNoteSchema.partial();

export type Note = z.infer<typeof NoteSchema>;
export type CreateNoteInput = z.infer<typeof CreateNoteSchema>;
export type UpdateNoteInput = z.infer<typeof UpdateNoteSchema>;

export default {
  name: "note",
  description: "Quick notes attached to todos for additional context",
  schema: NoteSchema,
  createSchema: CreateNoteSchema,
  updateSchema: UpdateNoteSchema,
  tags: ["notes"],
  endpoints: {
    list: true,
    get: true,
    create: true,
    update: true,
    delete: true,
  },
};
