const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const net = require('net');
const bodyParser = require('body-parser');

const app = express();
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const allowedOrigins = (process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || allowedOrigins.includes(origin));
    }
}));
app.use(express.static(FRONTEND_DIR));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Increase the request size limit to 50MB to handle ZIPs and Base64 images
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

function writeDB(data) {
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, DB_FILE);
}

// Helper to read DB
function readDB() {
    if (!fs.existsSync(DB_FILE)) {
        writeDB({});
        return {};
    }

    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8').trim();
        if (!raw) return {};
        return JSON.parse(raw);
    } catch (error) {
        console.error('DB file was invalid or partially written. Resetting it to an empty state.', error.message);
        writeDB({});
        return {};
    }
}

// GET all data
app.get('/api/data', (req, res) => {
    try {
        res.json(readDB());
    } catch (error) {
        console.error('GET /api/data failed:', error);
        res.status(500).json({ error: 'Failed to read data store' });
    }
});

// POST to update a specific key (templates, categories, sales, etc.)
app.post('/api/data/:key', (req, res) => {
    try {
        const key = req.params.key;
        const data = req.body;

        const db = readDB();
        db[key] = data;
        writeDB(db);
        res.json({ success: true });
    } catch (error) {
        console.error('POST /api/data/:key failed:', error);
        res.status(500).json({ error: 'Failed to save data store' });
    }
});

app.use((err, req, res, next) => {
    console.error('Unhandled server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

const platformPort = process.env.PORT ? Number(process.env.PORT) : null;

function startServer(port) {
    const server = app.listen(port, () => {
        console.log(`API server listening on port ${port}`);
    });

    server.on('error', (error) => {
        if (!platformPort && error.code === 'EADDRINUSE') {
            startServer(port + 1);
            return;
        }

        console.error('Failed to start API server:', error);
        process.exitCode = 1;
    });
}

startServer(platformPort || 3000);