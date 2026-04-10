export interface Note {
  id: string;
  title: string;
  content: string;
  todoId: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNoteInput {
  title: string;
  content: string;
  todoId?: string | null;
  pinned?: boolean;
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;
  todoId?: string | null;
  pinned?: boolean;
}
