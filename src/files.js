// Uploaded photos, receipts and documents are stored in the `files` table (Vercel has no persistent disk).
// A multer storage engine keeps route code unchanged: each file still gets `f.filename`, served at /uploads/<filename>.
const crypto = require('node:crypto');
const path = require('node:path');

function dbStorage(getH) {
  return {
    _handleFile(req, file, cb) {
      const chunks = [];
      let size = 0;
      file.stream.on('data', (c) => { chunks.push(c); size += c.length; });
      file.stream.on('error', cb);
      file.stream.on('end', async () => {
        try {
          const filename = crypto.randomBytes(10).toString('hex') + path.extname(file.originalname).toLowerCase().slice(0, 6);
          await getH().run('INSERT INTO files (name, mime, size, data) VALUES (?,?,?,?)', filename, file.mimetype, size, Buffer.concat(chunks));
          cb(null, { filename, size });
        } catch (e) { cb(e); }
      });
    },
    _removeFile(req, file, cb) {
      getH().run('DELETE FROM files WHERE name=?', file.filename).then(() => cb(null), cb);
    },
  };
}

// Express handler for GET /uploads/:name (staff and customers only, as before).
const serveFile = (h) => async (req, res, next) => {
  if (!req.user) return res.status(403).end();
  const f = await h.get('SELECT mime, data FROM files WHERE name=?', req.params.name);
  if (!f) return next();
  res.set('Cache-Control', 'private, max-age=86400').type(f.mime).send(f.data);
};

module.exports = { dbStorage, serveFile };
