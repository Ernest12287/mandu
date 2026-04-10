// Island-First: notes.client.tsx → NoteEditor island
import { noteService } from "../../server/domain/note/note.service";
import { todoService } from "../../server/domain/todo/todo.service";

export default function NotesPage() {
  const notes = noteService.list();
  const todos = todoService.list("all");
  const stats = noteService.stats();

  return (
    <div>
      <h1
        className="text-4xl mb-1"
        style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic' }}
      >
        Notes
      </h1>
      <p className="text-sm mb-8" style={{ color: 'var(--color-ink-muted)' }}>
        {stats.total} notes, {stats.pinned} pinned
      </p>
      <div
        data-island="note-editor"
        data-props={JSON.stringify({ initialNotes: notes, todos })}
      >
        {/* SSR fallback */}
        {notes.length === 0 ? (
          <div className="card p-10 text-center">
            <div className="text-3xl mb-3">📝</div>
            <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>No notes yet. Create one above!</p>
          </div>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <div
                key={note.id}
                className="card p-5"
                style={note.pinned ? { borderLeftColor: 'var(--color-amber)', borderLeftWidth: '4px' } : {}}
              >
                <div className="flex items-center gap-2 mb-2">
                  {note.pinned && <span style={{ color: 'var(--color-amber)' }}>★</span>}
                  <h3 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-ink)' }}>{note.title}</h3>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-ink-light)' }}>{note.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
