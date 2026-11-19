import { createServer } from 'node:http';
import { createNote, deleteNote, getNote, listNotes } from './notes.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const [, resource, id] = url.pathname.split('/');
  if (resource !== 'notes') return json(res, 404, { error: 'Not found' });

  if (req.method === 'GET' && !id) return json(res, 200, listNotes());
  if (req.method === 'GET' && id) {
    const note = getNote(id);
    return note ? json(res, 200, note) : json(res, 404, { error: 'Note not found' });
  }
  if (req.method === 'POST' && !id) {
    const { title, body } = await readBody(req);
    return json(res, 201, createNote(title, body));
  }
  if (req.method === 'DELETE' && id) {
    return deleteNote(id) ? json(res, 204, {}) : json(res, 404, { error: 'Note not found' });
  }
  json(res, 405, { error: 'Method not allowed' });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`notes-api listening on http://localhost:${port}`));
}
