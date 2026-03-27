const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 4000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'restauos-dev-secret';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

// Database Setup
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Neon/Render
});

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Initialize Database Tables
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        key TEXT PRIMARY KEY,
        machine_id TEXT,
        activated_at TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        days_remaining INTEGER DEFAULT NULL,
        released_at TEXT DEFAULT NULL
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS license_logs (
        id SERIAL PRIMARY KEY,
        key TEXT,
        action TEXT,
        machine_id TEXT,
        admin TEXT,
        timestamp TEXT,
        note TEXT
      )
    `);
    console.log('PostgreSQL Tables Initialized');
  } catch (err) {
    console.error('Database Initialization Error:', err);
  }
}
initDb();

// --- API Endpoints ---

// 0. Verify License (Called by the App periodically)
app.get('/verify/:key/:machineId', async (req, res) => {
  const { key, machineId } = req.params;

  if (!key || !machineId) {
    return res.status(400).json({ success: false, message: "Clé et ID Machine requis." });
  }

  try {
    const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
    const row = result.rows[0];

    if (!row) {
      return res.status(404).json({ success: false, message: "Licence supprimée ou invalide." });
    }

    if (row.machine_id !== machineId) {
      return res.status(403).json({ success: false, message: "Licence liée à une autre machine." });
    }

    return res.json({ 
      success: true, 
      message: "Licence valide.", 
      days_remaining: row.days_remaining 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur serveur." });
  }
});

// 1. Activate License (Called by the App)
app.post('/activate', async (req, res) => {
  const { key, machineId } = req.body;

  if (!key || !machineId) {
    return res.status(400).json({ success: false, message: "Clé et ID Machine requis." });
  }

  try {
    const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
    const row = result.rows[0];

    if (!row) {
      return res.status(404).json({ success: false, message: "Clé de licence invalide." });
    }

    if (row.machine_id && row.machine_id !== machineId) {
      return res.status(403).json({ success: false, message: "Cette clé est déjà liée à une autre machine." });
    }

    // Bind key to machine if not already bound
    if (!row.machine_id) {
      await pool.query('UPDATE licenses SET machine_id = $1, activated_at = $2 WHERE key = $3', 
        [machineId, new Date().toISOString(), key]);

      return res.json({ 
        success: true, 
        message: "Licence activée et liée avec succès !",
        days_remaining: row.days_remaining 
      });
    }

    // Already bound to THIS machine
    return res.json({ success: true, message: "Licence déjà active sur cette machine." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur lors de l'activation." });
  }
});

// 2. Add Keys (Called by the Developer / Generator)
app.post('/add-keys', async (req, res) => {
  const apiKey = req.headers['x-api-key'];

  if (apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Non autorisé. Clé API invalide." });
  }

  const { keys } = req.body;

  if (!keys || !Array.isArray(keys)) {
    return res.status(400).json({ success: false, message: "Liste de clés requise." });
  }

  try {
    for (const key of keys) {
      await pool.query('INSERT INTO licenses (key) VALUES ($1) ON CONFLICT (key) DO NOTHING', [key]);
    }
    res.json({ success: true, message: `${keys.length} clés ajoutées à la base.` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur lors de l'ajout des clés." });
  }
});

// 3. Release License (Called by Admin App)
app.post('/release', async (req, res) => {
  const { key, secret, admin } = req.body;
  const apiKey = req.headers['x-api-key'] || secret;

  if (apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Non autorisé. Clé API invalide." });
  }

  if (!key) {
    return res.status(400).json({ success: false, message: "Clé requise." });
  }

  try {
    const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
    const row = result.rows[0];

    if (!row) {
      return res.status(404).json({ success: false, message: "Clé de licence introuvable." });
    }

    if (!row.machine_id) {
      return res.status(400).json({ success: false, message: "Licence déjà libre." });
    }

    let daysRemaining = row.days_remaining;

    if (daysRemaining === null && row.activated_at) {
      let ttlMs = 365 * 24 * 60 * 60 * 1000;
      if (key.startsWith('R30D')) ttlMs = 30 * 24 * 60 * 60 * 1000;
      else if (key.startsWith('RLIF')) ttlMs = 100 * 365 * 24 * 60 * 60 * 1000;

      const activatedAtMs = new Date(row.activated_at).getTime();
      const elapsedMs = Date.now() - activatedAtMs;
      daysRemaining = Math.max(0, Math.ceil((ttlMs - elapsedMs) / (1000 * 60 * 60 * 24)));
    }

    await pool.query('UPDATE licenses SET machine_id = NULL, days_remaining = $1, released_at = $2 WHERE key = $3', 
      [daysRemaining, new Date().toISOString(), key]);

    await pool.query('INSERT INTO license_logs (key, action, machine_id, admin, timestamp, note) VALUES ($1, $2, $3, $4, $5, $6)', 
      [key, 'release', row.machine_id, admin || 'admin', new Date().toISOString(), `Licence libérée (dissociée). Jours restants: ${daysRemaining}`]);

    res.json({ success: true, message: "Licence libérée avec succès.", days_remaining: daysRemaining });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur lors de la libération." });
  }
});

// 4. Delete Key (Called by Developer)
app.post('/delete-key', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Non autorisé. Clé API invalide." });
  }

  const { key, admin } = req.body;
  if (!key) {
    return res.status(400).json({ success: false, message: "Clé requise." });
  }

  try {
    const result = await pool.query('SELECT * FROM licenses WHERE key = $1', [key]);
    const row = result.rows[0];

    if (!row) {
      return res.status(404).json({ success: false, message: "Clé non trouvée." });
    }

    await pool.query('INSERT INTO license_logs (key, action, machine_id, admin, timestamp, note) VALUES ($1, $2, $3, $4, $5, $6)', 
      [key, 'delete', row.machine_id, admin || 'admin', new Date().toISOString(), 'Clé supprimée définitivement']);

    await pool.query('DELETE FROM licenses WHERE key = $1', [key]);
    res.json({ success: true, message: "Clé supprimée avec succès." });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur lors de la suppression." });
  }
});

// 5. Status (Check all keys)
app.get('/status', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Non autorisé. Clé API invalide." });
  }
  try {
    const result = await pool.query('SELECT * FROM licenses ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ success: false, message: "Erreur de base de données." });
  }
});

app.listen(port, () => {
  console.log(`License Server (PostgreSQL) running on port ${port}`);
});
