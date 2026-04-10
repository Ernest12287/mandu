import { noteRepository } from "./note.repository";
import type { Note, CreateNoteInput, UpdateNoteInput } from "./note.types";

export const noteService = {
  list(): Note[] {
    return noteRepository.findAll();
  },

  getById(id: string): Note | undefined {
    return noteRepository.findById(id);
  },

  getByTodoId(todoId: string): Note[] {
    return noteRepository.findByTodoId(todoId);
  },

  create(input: CreateNoteInput): Note {
    return noteRepository.create(
      input.title.trim(),
      input.content.trim(),
      input.todoId ?? null,
      input.pinned ?? false,
    );
  },

  update(id: string, input: UpdateNoteInput): Note | undefined {
    return noteRepository.update(id, input);
  },

  delete(id: string): boolean {
    return noteRepository.delete(id);
  },

  stats() {
    const all = noteRepository.findAll();
    return {
      total: all.length,
      pinned: all.filter((n) => n.pinned).length,
      linked: all.filter((n) => n.todoId).length,
    };
  },
};
