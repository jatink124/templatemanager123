const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const net = require('net');
const bodyParser = require('body-parser');
const MongoDataStore = require('./mongo-data-store');

const app = express();
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const STORAGE_DRIVER = process.env.STORAGE_DRIVER || (process.env.MONGODB_URI ? 'mongodb' : 'file');
const allowedOrigins = new Set([
    'https://templatemanager.netlify.app',
    ...(process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
].map((origin) => origin.replace(/\/$/, '')));

app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || allowedOrigins.has(origin));
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

function getAsset(assetPath, content) {
    const dataUri = typeof content === 'string'
        ? content.match(/^data:([^;,]+);base64,([\s\S]*)$/)
        : null;
    const extension = path.extname(assetPath).toLowerCase();
    const contentType = dataUri ? dataUri[1] : ({
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.txt': 'text/plain; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8'
    })[extension] || 'application/octet-stream';

    return {
        contentType,
        body: dataUri ? Buffer.from(dataUri[2], 'base64') : Buffer.from(String(content))
    };
}

// GET all data
app.get('/api/data', (req, res) => {
    if (mongoStore) {
        return mongoStore.sendAll(res).catch((error) => {
            console.error('GET /api/data failed:', error);
            if (res.headersSent) return res.destroy(error);
            res.status(500).json({ error: 'Failed to read data store' });
        });
    }

    try {
        res.json(readDB());
    } catch (error) {
        console.error('GET /api/data failed:', error);
        res.status(500).json({ error: 'Failed to read data store' });
    }
});

app.get(/^\/api\/assets\/([^/]+)\/app\/(.+)$/, (req, res) => {
    let templateId;
    let assetPath;
    try {
        const requestPath = req.originalUrl.split('?')[0];
        const match = requestPath.match(/^\/api\/assets\/([^/]+)\/app\/(.+)$/);
        templateId = decodeURIComponent(match[1]);
        assetPath = decodeURIComponent(match[2]);
    } catch (error) {
        return res.status(400).json({ error: 'Invalid asset path' });
    }

    if (!assetPath || assetPath.split(/[\\/]/).includes('..') || path.isAbsolute(assetPath)) {
        return res.status(400).json({ error: 'Invalid asset path' });
    }

    if (mongoStore) {
        return mongoStore.getTemplateAsset(templateId, assetPath)
            .then((asset) => {
                if (!asset) return res.status(404).json({ error: 'Template asset not found' });
                res.type(asset.contentType);
                res.set('Cache-Control', 'public, max-age=3600');
                res.send(asset.body);
            })
            .catch((error) => {
                console.error('GET /api/assets/:id/app/* failed:', error);
                if (res.headersSent) return res.destroy(error);
                res.status(500).json({ error: 'Failed to read template asset' });
            });
    }

    try {
        const templates = readDB().cm_templates;
        const template = Array.isArray(templates)
            ? templates.find((item) => String(item.id) === templateId)
            : null;
        const appData = template && template.appData;
        if (!appData || typeof appData !== 'object' || Array.isArray(appData)) {
            return res.status(404).json({ error: 'Template asset not found' });
        }

        let storedPath = assetPath;
        if (!Object.prototype.hasOwnProperty.call(appData, storedPath)) {
            const basename = path.posix.basename(assetPath.replace(/\\/g, '/'));
            const matches = Object.keys(appData).filter((filePath) =>
                path.posix.basename(filePath.replace(/\\/g, '/')) === basename
            );
            if (matches.length !== 1) {
                return res.status(404).json({ error: 'Template asset not found' });
            }
            [storedPath] = matches;
        }

        const asset = getAsset(storedPath, appData[storedPath]);
        res.type(asset.contentType);
        res.send(asset.body);
    } catch (error) {
        console.error('GET /api/assets/:id/app/* failed:', error);
        res.status(500).json({ error: 'Failed to read template asset' });
    }
});

// POST to update a specific key (templates, categories, sales, etc.)
app.post('/api/data/:key', (req, res) => {
    if (mongoStore) {
        return mongoStore.write(req.params.key, req.body)
            .then(() => res.json({ success: true }))
            .catch((error) => {
                console.error('POST /api/data/:key failed:', error);
                res.status(500).json({ error: 'Failed to save data store' });
            });
    }

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
let mongoStore = null;

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

async function start() {
    if (STORAGE_DRIVER === 'mongodb') {
        if (!process.env.MONGODB_URI) {
            throw new Error('MONGODB_URI is required when STORAGE_DRIVER=mongodb');
        }

        mongoStore = new MongoDataStore(
            process.env.MONGODB_URI,
            process.env.MONGODB_DATABASE || 'codemarket'
        );
        await mongoStore.connect();
        console.log(`Connected to MongoDB database ${process.env.MONGODB_DATABASE || 'codemarket'}`);
    } else if (STORAGE_DRIVER !== 'file') {
        throw new Error(`Unsupported STORAGE_DRIVER: ${STORAGE_DRIVER}`);
    }

    startServer(platformPort || 3000);
}

start().catch((error) => {
    console.error('Failed to initialize data store:', error);
    process.exitCode = 1;
});