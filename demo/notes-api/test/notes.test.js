import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createNote, deleteNote, getNote, listNotes, resetNotes } from '../src/notes.js';

beforeEach(() => resetNotes());

test('creates and lists notes', () => {
  createNote('Groceries', 'milk, eggs');
  createNote('Ideas');
  assert.equal(listNotes().length, 2);
});

test('gets a note by the id from the URL', () => {
  const note = createNote('Groceries');
  assert.deepEqual(getNote(String(note.id)), note);
});

test('deletes a note', () => {
  const note = createNote('Temp');
  assert.equal(deleteNote(String(note.id)), true);
  assert.equal(listNotes().length, 0);
});
