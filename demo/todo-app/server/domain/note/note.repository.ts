import type { Note, UpdateNoteInput } from "./note.types";

const notes: Note[] = [
  {
    id: "1",
    title: "Mandu 프레임워크 메모",
    content: "Island hydration과 SSR이 자동으로 동작한다. Mandu.island() API 참고.",
    todoId: "1",
    pinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "2",
    title: "API 테스트 결과",
    content: "GET/POST/PUT/DELETE 모든 메서드 정상 동작 확인.",
    todoId: "3",
    pinned: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

let nextId = 3;

export const noteRepository = {
  findAll(): Note[] {
    return [...notes].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
  },

  findById(id: string): Note | undefined {
    return notes.find((n) => n.id === id);
  },

  findByTodoId(todoId: string): Note[] {
    return notes.filter((n) => n.todoId === todoId);
  },

  create(title: string, content: string, todoId: string | null = null, pinned = false): Note {
    const now = new Date().toISOString();
    const note: Note = {
      id: String(nextId++),
      title,
      content,
      todoId,
      pinned,
      createdAt: now,
      updatedAt: now,
    };
    notes.push(note);
    return note;
  },

  update(id: string, data: UpdateNoteInput): Note | undefined {
    const note = notes.find((n) => n.id === id);
    if (!note) return undefined;
    if (data.title !== undefined) note.title = data.title;
    if (data.content !== undefined) note.content = data.content;
    if (data.todoId !== undefined) note.todoId = data.todoId;
    if (data.pinned !== undefined) note.pinned = data.pinned;
    note.updatedAt = new Date().toISOString();
    return note;
  },

  delete(id: string): boolean {
    const index = notes.findIndex((n) => n.id === id);
    if (index === -1) return false;
    notes.splice(index, 1);
    return true;
  },
};
