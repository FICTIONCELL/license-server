const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Database Setup
const db = new Database(path.join(__dirname, 'licenses.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    key TEXT PRIMARY KEY,
    machine_id TEXT,
    activated_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- API Endpoints ---

// 1. Activate License (Called by the App)
app.post('/activate', (req, res) => {
  const { key, machineId } = req.body;

  if (!key || !machineId) {
    return res.status(400).json({ success: false, message: "Clé et ID Machine requis." });
  }

  const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(key);

  if (!row) {
    return res.status(404).json({ success: false, message: "Clé de licence invalide." });
  }

  if (row.machine_id && row.machine_id !== machineId) {
    return res.status(403).json({ success: false, message: "Cette clé est déjà liée à une autre machine." });
  }

  // Bind key to machine if not already bound
  if (!row.machine_id) {
    db.prepare('UPDATE licenses SET machine_id = ?, activated_at = ? WHERE key = ?')
      .run(machineId, new Date().toISOString(), key);
    return res.json({ success: true, message: "Licence activée et liée avec succès !" });
  }

  // Already bound to THIS machine
  return res.json({ success: true, message: "Licence déjà active sur cette machine." });
});

// 2. Add Keys (Called by the Developer / Generator)
// NOTE: In a real production environment, this should be protected by an API Key
app.post('/add-keys', (req, res) => {
  const { keys } = req.body; // Array of strings

  if (!keys || !Array.isArray(keys)) {
    return res.status(400).json({ success: false, message: "Liste de clés requise." });
  }

  const insert = db.prepare('INSERT OR IGNORE INTO licenses (key) VALUES (?)');
  const insertMany = db.transaction((ks) => {
    for (const k of ks) insert.run(k);
  });

  insertMany(keys);
  res.json({ success: true, message: `${keys.length} clés ajoutées à la base.` });
});

// 3. Status (Check all keys - for the Dev)
app.get('/status', (req, res) => {
  const rows = db.prepare('SELECT * FROM licenses').all();
  res.json(rows);
});

app.listen(port, () => {
  console.log(`License Server running on port ${port}`);
});
