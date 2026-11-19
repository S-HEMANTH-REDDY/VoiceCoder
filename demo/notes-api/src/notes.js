// In-memory note store.

const notes = new Map();
let nextId = 1;

export function createNote(title, body = '') {
  const note = { id: nextId++, title, body, createdAt: new Date().toISOString() };
  notes.set(note.id, note);
  return note;
}

export function listNotes() {
  return [...notes.values()];
}

export function getNote(id) {
  // Bug for the demo: ids arrive from the URL as strings, but the map is keyed by numbers.
  return notes.get(id) ?? null;
}

export function deleteNote(id) {
  return notes.delete(Number(id));
}

export function resetNotes() {
  notes.clear();
  nextId = 1;
}
