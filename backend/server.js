const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { randomUUID } = require('node:crypto');
const bodyParser = require('body-parser');
const MongoDataStore = require('./mongo-data-store');
const auth = require('./auth');
const customerAuth = require('./customer-auth');
const { createInquiry, InquiryValidationError } = require('./inquiries');

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
const publicTemplateAssets = new Map();

app.use(cors({
    origin(origin, callback) {
        callback(null, !origin || allowedOrigins.has(origin));
    }
}));
// Increase the request size limit to 50MB to handle ZIPs and Base64 images
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

function isAdminRequest(req) {
    return auth.isAuthenticated(req.headers.cookie);
}

function publicStoreData(data) {
    const publicData = {};
    publicTemplateAssets.clear();
    for (const key of ['cm_templates', 'cm_categories']) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        publicData[key] = key === 'cm_templates' && Array.isArray(data[key])
            ? data[key]
                .filter((template) => template && template.status === 'Published')
                .map((template) => {
                    const { appData, sales, views, ...publicTemplate } = template;
                    const templatePath = `/api/assets/${encodeURIComponent(String(template.id))}`;

                    if (typeof publicTemplate.image === 'string' &&
                        publicTemplate.image.startsWith('data:')) {
                        publicTemplateAssets.set(`${template.id}/image`, publicTemplate.image);
                        publicTemplate.image = `${templatePath}/image`;
                    }

                    if (Array.isArray(publicTemplate.gallery)) {
                        publicTemplate.gallery = publicTemplate.gallery.map((image, index) => {
                            if (typeof image !== 'string' || !image.startsWith('data:')) return image;
                            publicTemplateAssets.set(`${template.id}/gallery/${index}`, image);
                            return `${templatePath}/gallery/${index}`;
                        });
                    }

                    return publicTemplate;
                })
            : data[key];
    }
    return publicData;
}

function adminStoreData(data) {
    const { cm_customers, ...adminData } = data;
    return adminData;
}

app.post('/api/auth/login', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Expected an application/json request' });
    }
    const configurationError = auth.getConfigurationError();
    if (configurationError) {
        return res.status(503).json({ error: 'Authentication is not configured' });
    }
    if (!auth.credentialsAreValid(req.body?.username, req.body?.password)) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = auth.createSessionToken(process.env.SESSION_SECRET);
    res.set('Set-Cookie', auth.createSessionCookie(token));
    res.json({ success: true });
});

app.get('/api/auth/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (auth.getConfigurationError()) {
        return res.status(503).json({ error: 'Authentication is not configured' });
    }
    if (!isAdminRequest(req)) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true });
});

app.post('/api/auth/logout', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Expected an application/json request' });
    }
    res.set('Set-Cookie', auth.clearSessionCookie());
    res.json({ success: true });
});

function customerResponse(customer) {
    return {
        id: customer.id,
        name: customer.name,
        email: customer.email
    };
}

function readCustomers() {
    if (mongoStore) return mongoStore.read('cm_customers');
    const customers = readDB().cm_customers;
    return Promise.resolve(Array.isArray(customers) ? customers : []);
}

async function writeCustomers(customers) {
    if (mongoStore) return mongoStore.write('cm_customers', customers);
    const db = readDB();
    db.cm_customers = customers;
    writeDB(db);
}

async function findOrCreateGoogleCustomer(profile) {
    const customers = await readCustomers();
    let customer = customers.find((item) => item.googleSub === profile.googleSub);
    if (!customer) {
        customer = customers.find((item) => item.email === profile.email);
        if (customer && customer.googleSub && customer.googleSub !== profile.googleSub) {
            throw new customerAuth.CustomerAuthError('This email is linked to a different Google account', 409);
        }
    }
    if (customer) {
        customer.googleSub = profile.googleSub;
        customer.name = profile.name;
    } else {
        customer = {
            id: randomUUID(),
            name: profile.name,
            email: profile.email,
            googleSub: profile.googleSub,
            createdAt: new Date().toISOString()
        };
        customers.unshift(customer);
    }
    await writeCustomers(customers);
    return customer;
}

app.get('/api/customer/auth/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
});

app.get('/api/customer/auth/session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const customerId = customerAuth.customerIdFromCookie(req.headers.cookie);
    if (!customerId) return res.json({ authenticated: false });

    try {
        const customer = (await readCustomers()).find((item) => item.id === customerId);
        if (!customer) {
            res.set('Set-Cookie', customerAuth.clearSessionCookie());
            return res.json({ authenticated: false });
        }
        res.json({ authenticated: true, user: customerResponse(customer) });
    } catch (error) {
        console.error('GET /api/customer/auth/session failed:', error);
        res.status(500).json({ error: 'Could not load customer session' });
    }
});

app.post('/api/customer/auth/register', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Expected an application/json request' });
    }
    const configurationError = customerAuth.getConfigurationError();
    if (configurationError) return res.status(503).json({ error: configurationError });

    try {
        const input = customerAuth.validateRegistration(req.body);
        const customers = await readCustomers();
        if (customers.some((item) => item.email === input.email)) {
            return res.status(409).json({ error: 'An account with this email already exists' });
        }

        const customer = {
            id: randomUUID(),
            name: input.name,
            email: input.email,
            passwordHash: await customerAuth.hashPassword(input.password),
            createdAt: new Date().toISOString()
        };
        customers.unshift(customer);
        await writeCustomers(customers);
        res.set('Set-Cookie', customerAuth.createSessionCookie(customer.id));
        res.status(201).json({ success: true, user: customerResponse(customer) });
    } catch (error) {
        if (error instanceof customerAuth.CustomerAuthError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('POST /api/customer/auth/register failed:', error);
        res.status(500).json({ error: 'Could not create your account' });
    }
});

app.post('/api/customer/auth/login', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Expected an application/json request' });
    }
    const configurationError = customerAuth.getConfigurationError();
    if (configurationError) return res.status(503).json({ error: configurationError });

    try {
        const email = customerAuth.normalizeEmail(req.body?.email);
        const password = req.body?.password;
        const customer = (await readCustomers()).find((item) => item.email === email);
        if (!customer || !await customerAuth.passwordMatches(password, customer.passwordHash)) {
            return res.status(401).json({ error: 'Email or password is incorrect' });
        }
        res.set('Set-Cookie', customerAuth.createSessionCookie(customer.id));
        res.json({ success: true, user: customerResponse(customer) });
    } catch (error) {
        if (error instanceof customerAuth.CustomerAuthError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('POST /api/customer/auth/login failed:', error);
        res.status(500).json({ error: 'Could not sign in' });
    }
});

app.post('/api/customer/auth/google', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Expected an application/json request' });
    }
    const configurationError = customerAuth.getConfigurationError();
    if (configurationError) return res.status(503).json({ error: configurationError });

    try {
        const profile = await customerAuth.verifyGoogleCredential(req.body?.credential);
        const customer = await findOrCreateGoogleCustomer(profile);
        res.set('Set-Cookie', customerAuth.createSessionCookie(customer.id));
        res.json({ success: true, user: customerResponse(customer) });
    } catch (error) {
        if (error instanceof customerAuth.CustomerAuthError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('POST /api/customer/auth/google failed:', error);
        res.status(500).json({ error: 'Could not sign in with Google' });
    }
});

app.post('/api/customer/auth/logout', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Expected an application/json request' });
    }
    res.set('Set-Cookie', customerAuth.clearSessionCookie());
    res.json({ success: true });
});

app.use((req, res, next) => {
    let requestedPath;
    try {
        requestedPath = decodeURIComponent(req.path).replace(/\\/g, '/').toLowerCase();
    } catch (error) {
        return res.status(400).send('Invalid URL');
    }
    if (requestedPath !== '/dashboard.html') return next();
    if (!isAdminRequest(req)) return res.redirect(302, '/login.html');
    res.set('Cache-Control', 'no-store');
    next();
});

app.use(express.static(FRONTEND_DIR));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

function writeDB(data) {
    const tmpFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, DB_FILE);
    publicTemplateAssets.clear();
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
    res.set('Cache-Control', 'no-store');
    if (mongoStore) {
        const allowedKeys = isAdminRequest(req)
            ? null
            : new Set(['cm_templates', 'cm_categories']);
        return mongoStore.sendAll(res, allowedKeys).catch((error) => {
            console.error('GET /api/data failed:', error);
            if (res.headersSent) return res.destroy(error);
            res.status(500).json({ error: 'Failed to read data store' });
        });
    }

    try {
        const data = readDB();
        res.json(isAdminRequest(req) ? adminStoreData(data) : publicStoreData(data));
    } catch (error) {
        console.error('GET /api/data failed:', error);
        res.status(500).json({ error: 'Failed to read data store' });
    }
});

app.post('/api/inquiries', async (req, res) => {
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Expected an application/json request' });
    }

    try {
        const templates = mongoStore
            ? await mongoStore.read('cm_templates')
            : readDB().cm_templates;
        const template = Array.isArray(templates)
            ? templates.find((item) => String(item.id) === String(req.body?.templateId))
            : null;
        const inquiry = createInquiry(req.body, template);

        if (mongoStore) {
            await mongoStore.append('cm_inquiries', inquiry);
        } else {
            const db = readDB();
            db.cm_inquiries = [inquiry, ...(Array.isArray(db.cm_inquiries) ? db.cm_inquiries : [])];
            writeDB(db);
        }

        res.status(201).json({ success: true, inquiryId: inquiry.id });
    } catch (error) {
        if (error instanceof InquiryValidationError) {
            return res.status(error.statusCode).json({ error: error.message });
        }
        console.error('POST /api/inquiries failed:', error);
        res.status(500).json({ error: 'Failed to save inquiry' });
    }
});

app.get('/api/inquiries', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isAdminRequest(req)) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const inquiries = mongoStore
            ? await mongoStore.read('cm_inquiries')
            : readDB().cm_inquiries;
        res.json(Array.isArray(inquiries) ? inquiries : []);
    } catch (error) {
        console.error('GET /api/inquiries failed:', error);
        res.status(500).json({ error: 'Failed to read inquiries' });
    }
});

app.get(/^\/api\/assets\/([^/]+)\/(image|gallery\/\d+)$/, (req, res) => {
    let templateId;
    let assetPath;
    try {
        const requestPath = req.originalUrl.split('?')[0];
        const match = requestPath.match(/^\/api\/assets\/([^/]+)\/(image|gallery\/\d+)$/);
        templateId = decodeURIComponent(match[1]);
        assetPath = decodeURIComponent(match[2]);
    } catch (error) {
        return res.status(400).json({ error: 'Invalid asset path' });
    }

    if (mongoStore) {
        return mongoStore.getTemplateMedia(templateId, assetPath)
            .then((asset) => {
                if (!asset) return res.status(404).json({ error: 'Template asset not found' });
                res.type(asset.contentType);
                res.set('Cache-Control', 'public, max-age=3600');
                res.send(asset.body);
            })
            .catch((error) => {
                console.error('GET /api/assets/:id/image failed:', error);
                if (res.headersSent) return res.destroy(error);
                res.status(500).json({ error: 'Failed to read template image' });
            });
    }

    const dataUri = publicTemplateAssets.get(`${templateId}/${assetPath}`);
    if (!dataUri) return res.status(404).json({ error: 'Template asset not found' });

    const asset = getAsset(assetPath, dataUri);
    res.type(asset.contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(asset.body);
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
    if (!isAdminRequest(req)) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    if (!req.is('application/json')) {
        return res.status(415).json({ error: 'Expected an application/json request' });
    }

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

        if (process.env.NODE_ENV === 'production' || process.env.CI) {
            return;
        }

        const url = `http://localhost:${port}`;
        const command = process.platform === 'win32'
            ? ['cmd.exe', ['/c', 'start', '', url]]
            : process.platform === 'darwin'
                ? ['open', [url]]
                : ['xdg-open', [url]];

        execFile(command[0], command[1], (error) => {
            if (error) {
                console.error(`Failed to open ${url} in the browser:`, error);
            }
        });
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