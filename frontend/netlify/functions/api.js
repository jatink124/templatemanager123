const { MongoClient, GridFSBucket } = require('mongodb');
const { randomUUID } = require('node:crypto');
const fs = require('fs');
const path = require('path');
const auth = require('../../../backend/auth');
const customerAuth = require('../../../backend/customer-auth');
const imageContentType = require('../../../backend/image-content-type');
const { createInquiry, InquiryValidationError } = require('../../../backend/inquiries');

const DATABASE_NAME = process.env.MONGODB_DATABASE || 'codemarket';
let bucketPromise;

function getBucket() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required');
  }

  if (!bucketPromise) {
    const client = new MongoClient(process.env.MONGODB_URI);
    bucketPromise = client.connect()
      .then(() => new GridFSBucket(client.db(DATABASE_NAME), { bucketName: 'app_data' }))
      .catch((error) => {
        bucketPromise = null;
        throw error;
      });
  }

  return bucketPromise;
}

function jsonResponse(statusCode, value, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers
    },
    body: JSON.stringify(value)
  };
}

function getRoutePath(event) {
  const requestPath = event.path || '';
  const functionPrefix = '/.netlify/functions/api';

  if (['/dashboard', '/dashboard/', '/dashboard.html'].includes(requestPath)) {
    return '/dashboard';
  }

  if (requestPath.startsWith(functionPrefix)) {
    return requestPath.slice(functionPrefix.length) || '/';
  }

  if (requestPath.startsWith('/api')) {
    return requestPath.slice('/api'.length) || '/';
  }

  return '/';
}

function parseRequestBody(event) {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : event.body || '';
  return JSON.parse(body);
}

function getCookieHeader(event) {
  return event.headers?.cookie || event.headers?.Cookie || '';
}

function isAdminRequest(event) {
  return auth.isAuthenticated(getCookieHeader(event));
}

function customerIdFromEvent(event) {
  return customerAuth.customerIdFromCookie(getCookieHeader(event));
}

function publicCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email
  };
}

async function readCustomers(bucket) {
  const customers = await readLatestFile(bucket, 'cm_customers');
  return Array.isArray(customers) ? customers : [];
}

async function writeCustomers(bucket, customers) {
  await writeValue(bucket, 'cm_customers', customers);
}

function isJsonRequest(event) {
  const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || '';
  return /^application\/json(?:\s*;|$)/i.test(contentType);
}

function parseDataUri(value) {
  const match = typeof value === 'string'
    ? value.match(/^data:([^;,]+);base64,([\s\S]*)$/)
    : null;
  return match
    ? { contentType: match[1], contents: Buffer.from(match[2], 'base64') }
    : null;
}

function contentTypeFor(fileName) {
  const extension = fileName.split('.').pop().toLowerCase();
  return ({
    css: 'text/css; charset=utf-8',
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    ico: 'image/x-icon',
    svg: 'image/svg+xml',
    txt: 'text/plain; charset=utf-8',
    xml: 'application/xml; charset=utf-8'
  })[extension] || 'application/octet-stream';
}

async function writeAsset(bucket, filename, contents, contentType) {
  const upload = bucket.openUploadStream(filename, {
    metadata: { contentType }
  });
  const completed = new Promise((resolve, reject) => {
    upload.once('finish', resolve);
    upload.once('error', reject);
  });

  upload.end(contents);
  await completed;

  const previousFiles = await bucket.find({
    filename,
    _id: { $ne: upload.id }
  }).toArray();
  await Promise.all(previousFiles.map((file) => bucket.delete(file._id)));
}

async function readAll(bucket) {
  const files = await bucket.find().sort({ uploadDate: 1 }).toArray();
  const latestByKey = new Map();
  for (const file of files) {
    if (!file.filename.startsWith('template-assets/')) {
      latestByKey.set(file.filename, file);
    }
  }

  const data = {};
  for (const [key, file] of latestByKey) {
    data[key] = await readFile(bucket, file);
  }
  return data;
}

async function readFile(bucket, file) {
  const chunks = [];
  for await (const chunk of bucket.openDownloadStream(file._id)) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readLatestFile(bucket, filename) {
  const files = await bucket.find({ filename }).sort({ uploadDate: -1 }).toArray();
  if (!files.length) return null;
  return readFile(bucket, files[0]);
}

function normalizeAssetPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

function findMatchingAssetPath(paths, requestedPath) {
  const normalizedRequested = normalizeAssetPath(requestedPath);
  const exactMatch = paths.find((filePath) =>
    normalizeAssetPath(filePath) === normalizedRequested
  );
  if (exactMatch !== undefined) return exactMatch;

  const lowerRequested = normalizedRequested.toLowerCase();
  const caseInsensitiveMatch = paths.filter((filePath) =>
    normalizeAssetPath(filePath).toLowerCase() === lowerRequested
  );
  if (caseInsensitiveMatch.length === 1) return caseInsensitiveMatch[0];

  const requestedName = normalizedRequested.split('/').pop().toLowerCase();
  const basenameMatches = paths.filter((filePath) =>
    normalizeAssetPath(filePath).split('/').pop().toLowerCase() === requestedName
  );
  return basenameMatches.length === 1 ? basenameMatches[0] : undefined;
}

async function findTemplateAsset(bucket, templateId, assetPath) {
  const assetPrefix = `template-assets/${encodeURIComponent(templateId)}`;
  const relativePath = normalizeAssetPath(assetPath.slice('app/'.length));
  const filenames = [
    `${assetPrefix}/app/${encodeURIComponent(relativePath)}`,
    `${assetPrefix}/app/${relativePath}`,
    `${assetPrefix}/app/${relativePath.split('/').map(encodeURIComponent).join('/')}`
  ];

  for (const filename of new Set(filenames)) {
    const files = await bucket.find({ filename }).sort({ uploadDate: -1 }).toArray();
    if (files.length) return { file: files[0] };
  }

  const escapedPrefix = assetPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const storedFiles = await bucket.find({
    filename: { $regex: `^${escapedPrefix}/app/` }
  }).toArray();
  const storedPaths = new Map();
  for (const file of storedFiles) {
    const storedPath = file.filename.slice(`${assetPrefix}/app/`.length);
    let decodedPath = storedPath;
    try {
      decodedPath = decodeURIComponent(storedPath);
    } catch (error) {
      // Keep the stored path as-is when it is not URI-encoded.
    }
    const normalizedPath = normalizeAssetPath(decodedPath);
    if (!storedPaths.has(normalizedPath)) storedPaths.set(normalizedPath, file);
  }
  const matchedPath = findMatchingAssetPath([...storedPaths.keys()], relativePath);
  if (matchedPath !== undefined) return { file: storedPaths.get(matchedPath) };

  const templates = await readLatestFile(bucket, 'cm_templates');
  const template = Array.isArray(templates)
    ? templates.find((item) => String(item.id) === templateId)
    : null;
  const appData = template && template.appData;
  if (!appData || typeof appData !== 'object' || Array.isArray(appData)) return null;

  const matchingKey = findMatchingAssetPath(Object.keys(appData), relativePath);
  if (matchingKey === undefined) return null;

  const contents = appData[matchingKey];
  if (typeof contents !== 'string') return null;
  const embeddedAsset = parseDataUri(contents);
  return {
    contents: embeddedAsset ? embeddedAsset.contents : Buffer.from(contents),
    contentType: embeddedAsset ? embeddedAsset.contentType : contentTypeFor(matchingKey)
  };
}

function summarizeData(data) {
  if (!Array.isArray(data.cm_templates)) return data;

  return {
    ...data,
    cm_templates: data.cm_templates.map((template) => ({
      id: template.id,
      title: typeof template.title === 'string' ? template.title.slice(0, 200) : '',
      description: typeof template.description === 'string' ? template.description.slice(0, 2000) : '',
      category: typeof template.category === 'string' ? template.category.slice(0, 200) : 'Others',
      price: Number.isFinite(Number(template.price)) ? Number(template.price) : 0,
      status: typeof template.status === 'string' ? template.status.slice(0, 40) : 'Draft',
      badge: typeof template.badge === 'string' ? template.badge.slice(0, 40) : '',
      image: typeof template.image === 'string' ? template.image : undefined,
      gallery: Array.isArray(template.gallery)
        ? template.gallery.filter((item) => typeof item === 'string').slice(0, 12)
        : [],
      demoUrl: typeof template.demoUrl === 'string' ? template.demoUrl.slice(0, 2000) : '',
      fileName: typeof template.fileName === 'string' ? template.fileName.slice(0, 255) : '',
      hasAppData: template.hasAppData === true,
      appEntry: typeof template.appEntry === 'string' ? template.appEntry.slice(0, 255) : '',
      createdAt: template.createdAt,
      views: Number(template.views) || 0,
      sales: Number(template.sales) || 0
    }))
  };
}

async function mergeTemplateAssets(bucket, incomingTemplates) {
  if (!Array.isArray(incomingTemplates)) return incomingTemplates;

  const existingTemplates = await readLatestFile(bucket, 'cm_templates');
  if (!Array.isArray(existingTemplates)) return incomingTemplates;

  const existingById = new Map(existingTemplates.map((template) => [String(template.id), template]));
  return incomingTemplates.map((template) => {
    const existing = existingById.get(String(template.id));
    if (!existing) return template;

    const merged = { ...existing, ...template };
    if (template.image === undefined || template.image === null) {
      merged.image = existing.image;
    }
    if (template.appData === undefined) {
      merged.appData = existing.appData;
    }
    return merged;
  });
}

async function storeTemplateAssets(bucket, templates) {
  if (!Array.isArray(templates)) return templates;

  const storedTemplates = [];
  for (const template of templates) {
    const id = String(template.id);
    const assetPrefix = `template-assets/${encodeURIComponent(id)}`;
    const summary = { ...template };

    const image = parseDataUri(template.image);
    if (image) {
      await writeAsset(bucket, `${assetPrefix}/image`, image.contents, image.contentType);
      summary.image = `/api/assets/${encodeURIComponent(id)}/image`;
    }

    if (Array.isArray(template.gallery)) {
      summary.gallery = [];
      for (let index = 0; index < template.gallery.length; index += 1) {
        const galleryImage = parseDataUri(template.gallery[index]);
        if (!galleryImage) {
          if (typeof template.gallery[index] === 'string') {
            summary.gallery.push(template.gallery[index]);
          }
          continue;
        }

        await writeAsset(
          bucket,
          `${assetPrefix}/gallery/${index}`,
          galleryImage.contents,
          galleryImage.contentType
        );
        summary.gallery.push(`/api/assets/${encodeURIComponent(id)}/gallery/${index}`);
      }
    }

    const appData = template.appData;
    const appFiles = appData && typeof appData === 'object' && !Array.isArray(appData)
      ? Object.entries(appData)
      : [];
    const htmlEntry = appFiles.find(([fileName]) => fileName.toLowerCase() === 'index.html')
      || appFiles.find(([fileName]) => /\.html?$/i.test(fileName));

    if (appFiles.length) {
      summary.hasAppData = true;
      if (!template.appEntry && htmlEntry) summary.appEntry = htmlEntry[0];
    } else if (appData !== undefined) {
      summary.hasAppData = false;
      if (appData === null) summary.appEntry = '';
    }

    for (const [fileName, contents] of appFiles) {
      if (typeof contents !== 'string') {
        throw new TypeError(`Template asset "${fileName}" must be a string`);
      }

      const embeddedAsset = parseDataUri(contents);
      await writeAsset(
        bucket,
        `${assetPrefix}/app/${encodeURIComponent(fileName)}`,
        embeddedAsset ? embeddedAsset.contents : Buffer.from(contents),
        embeddedAsset ? embeddedAsset.contentType : contentTypeFor(fileName)
      );
    }

    delete summary.appData;
    storedTemplates.push(summary);
  }
  return storedTemplates;
}

async function writeValue(bucket, key, value) {
  if (key === 'cm_templates') {
    value = await mergeTemplateAssets(bucket, value);
    value = await storeTemplateAssets(bucket, value);
  }

  const upload = bucket.openUploadStream(key);
  const completed = new Promise((resolve, reject) => {
    upload.once('finish', resolve);
    upload.once('error', reject);
  });

  upload.end(JSON.stringify(value));
  await completed;

  const previousFiles = await bucket.find({
    filename: key,
    _id: { $ne: upload.id }
  }).toArray();
  await Promise.all(previousFiles.map((file) => bucket.delete(file._id)));
}

exports.handler = async (event) => {
  let routePath;
  try {
    routePath = decodeURIComponent(getRoutePath(event));
  } catch (error) {
    return jsonResponse(400, { error: 'Invalid API path' });
  }

  if (routePath === '/dashboard' && event.httpMethod === 'GET') {
    if (!isAdminRequest(event)) {
      return {
        statusCode: 302,
        headers: { Location: '/login.html', 'Cache-Control': 'no-store' },
        body: ''
      };
    }

    try {
      const dashboardPath = [
        path.join(__dirname, '..', '..', 'dashboard.html'),
        path.join(process.cwd(), 'frontend', 'dashboard.html'),
        path.join(process.cwd(), 'dashboard.html')
      ].find((candidate) => fs.existsSync(candidate));
      if (!dashboardPath) throw new Error('Dashboard file was not included in the function bundle');
      const dashboard = fs.readFileSync(dashboardPath, 'utf8');
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        },
        body: dashboard
      };
    } catch (error) {
      console.error('GET /dashboard.html failed:', error);
      return jsonResponse(500, { error: 'Failed to load dashboard' });
    }
  }

  if (routePath === '/auth/login' && event.httpMethod === 'POST') {
    if (!isJsonRequest(event)) {
      return jsonResponse(415, { error: 'Expected an application/json request' });
    }
    if (auth.getConfigurationError()) {
      return jsonResponse(503, { error: 'Authentication is not configured' });
    }

    let credentials;
    try {
      credentials = parseRequestBody(event);
    } catch (error) {
      return jsonResponse(400, { error: 'Invalid JSON request body' });
    }
    if (!auth.credentialsAreValid(credentials?.username, credentials?.password)) {
      return jsonResponse(401, { error: 'Invalid username or password' });
    }

    const token = auth.createSessionToken(process.env.SESSION_SECRET);
    return jsonResponse(200, { success: true }, {
      'Set-Cookie': auth.createSessionCookie(token)
    });
  }

  if (routePath === '/auth/session' && event.httpMethod === 'GET') {
    if (auth.getConfigurationError()) {
      return jsonResponse(503, { error: 'Authentication is not configured' });
    }
    if (!isAdminRequest(event)) return jsonResponse(401, { authenticated: false });
    return jsonResponse(200, { authenticated: true });
  }

  if (routePath === '/auth/logout' && event.httpMethod === 'POST') {
    if (!isJsonRequest(event)) {
      return jsonResponse(415, { error: 'Expected an application/json request' });
    }
    return jsonResponse(200, { success: true }, {
      'Set-Cookie': auth.clearSessionCookie()
    });
  }

  if (routePath === '/customer/auth/config' && event.httpMethod === 'GET') {
    return jsonResponse(200, { googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
  }

  if (routePath === '/customer/auth/session' && event.httpMethod === 'GET') {
    const customerId = customerIdFromEvent(event);
    if (!customerId) return jsonResponse(200, { authenticated: false });

    try {
      const customers = await readCustomers(await getBucket());
      const customer = customers.find((item) => item.id === customerId);
      if (!customer) {
        return jsonResponse(200, { authenticated: false }, {
          'Set-Cookie': customerAuth.clearSessionCookie()
        });
      }
      return jsonResponse(200, { authenticated: true, user: publicCustomer(customer) });
    } catch (error) {
      console.error('GET /api/customer/auth/session failed:', error);
      return jsonResponse(500, { error: 'Could not load customer session' });
    }
  }

  const customerAuthRoute = routePath.match(/^\/customer\/auth\/(register|login|google|logout)$/);
  if (customerAuthRoute && event.httpMethod === 'POST') {
    if (!isJsonRequest(event)) {
      return jsonResponse(415, { error: 'Expected an application/json request' });
    }
    if (customerAuthRoute[1] === 'logout') {
      return jsonResponse(200, { success: true }, {
        'Set-Cookie': customerAuth.clearSessionCookie()
      });
    }

    if (customerAuth.getConfigurationError()) {
      return jsonResponse(503, { error: customerAuth.getConfigurationError() });
    }
    let input;
    try {
      input = parseRequestBody(event);
    } catch (error) {
      return jsonResponse(400, { error: 'Invalid JSON request body' });
    }

    try {
      const bucket = await getBucket();
      const customers = await readCustomers(bucket);
      const method = customerAuthRoute[1];
      let customer;

      if (method === 'register') {
        const details = customerAuth.validateRegistration(input);
        if (customers.some((item) => item.email === details.email)) {
          return jsonResponse(409, { error: 'An account with this email already exists' });
        }
        customer = {
          id: randomUUID(),
          name: details.name,
          email: details.email,
          passwordHash: await customerAuth.hashPassword(details.password),
          createdAt: new Date().toISOString()
        };
        customers.unshift(customer);
        await writeCustomers(bucket, customers);
        return jsonResponse(201, { success: true, user: publicCustomer(customer) }, {
          'Set-Cookie': customerAuth.createSessionCookie(customer.id)
        });
      }

      if (method === 'login') {
        const email = customerAuth.normalizeEmail(input?.email);
        customer = customers.find((item) => item.email === email);
        if (!customer || !await customerAuth.passwordMatches(input?.password, customer.passwordHash)) {
          return jsonResponse(401, { error: 'Email or password is incorrect' });
        }
      } else {
        const profile = await customerAuth.verifyGoogleCredential(input?.credential);
        let googleCustomer = customers.find((item) => item.googleSub === profile.googleSub);
        if (!googleCustomer) {
          googleCustomer = customers.find((item) => item.email === profile.email);
          if (googleCustomer && googleCustomer.googleSub
            && googleCustomer.googleSub !== profile.googleSub) {
            return jsonResponse(409, {
              error: 'This email is linked to a different Google account'
            });
          }
        }
        if (googleCustomer) {
          googleCustomer.googleSub = profile.googleSub;
          googleCustomer.name = profile.name;
          customer = googleCustomer;
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
        await writeCustomers(bucket, customers);
      }

      return jsonResponse(200, { success: true, user: publicCustomer(customer) }, {
        'Set-Cookie': customerAuth.createSessionCookie(customer.id)
      });
    } catch (error) {
      if (error instanceof customerAuth.CustomerAuthError) {
        return jsonResponse(error.statusCode, { error: error.message });
      }
      console.error(`POST /api${routePath} failed:`, error);
      return jsonResponse(500, { error: 'Could not complete sign-in' });
    }
  }

  if (event.httpMethod === 'GET' && routePath === '/data') {
    try {
      const data = summarizeData(await readAll(await getBucket()));
      if (isAdminRequest(event)) {
        delete data.cm_customers;
        return jsonResponse(200, data);
      }
      const publicData = {};
      for (const key of ['cm_templates', 'cm_categories']) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        publicData[key] = key === 'cm_templates' && Array.isArray(data[key])
          ? data[key]
            .filter((template) => template.status === 'Published')
            .map((template) => {
              const { sales, views, ...publicTemplate } = template;
              return publicTemplate;
            })
          : data[key];
      }
      return jsonResponse(200, publicData);
    } catch (error) {
      console.error('GET /api/data failed:', error);
      return jsonResponse(500, { error: 'Failed to read data store' });
    }
  }

  if (event.httpMethod === 'POST' && routePath === '/inquiries') {
    if (!isJsonRequest(event)) {
      return jsonResponse(415, { error: 'Expected an application/json request' });
    }

    let input;
    try {
      input = parseRequestBody(event);
    } catch (error) {
      return jsonResponse(400, { error: 'Invalid JSON request body' });
    }

    try {
      const bucket = await getBucket();
      const templates = await readLatestFile(bucket, 'cm_templates');
      const template = Array.isArray(templates)
        ? templates.find((item) => String(item.id) === String(input?.templateId))
        : null;
      const inquiry = createInquiry(input, template);
      const current = await readLatestFile(bucket, 'cm_inquiries');
      await writeValue(bucket, 'cm_inquiries', [
        inquiry,
        ...(Array.isArray(current) ? current : [])
      ]);
      return jsonResponse(201, { success: true, inquiryId: inquiry.id });
    } catch (error) {
      if (error instanceof InquiryValidationError) {
        return jsonResponse(error.statusCode, { error: error.message });
      }
      console.error('POST /api/inquiries failed:', error);
      return jsonResponse(500, { error: 'Failed to save inquiry' });
    }
  }

  if (event.httpMethod === 'GET' && routePath === '/inquiries') {
    if (!isAdminRequest(event)) {
      return jsonResponse(401, { error: 'Authentication required' });
    }

    try {
      const inquiries = await readLatestFile(await getBucket(), 'cm_inquiries');
      return jsonResponse(200, Array.isArray(inquiries) ? inquiries : []);
    } catch (error) {
      console.error('GET /api/inquiries failed:', error);
      return jsonResponse(500, { error: 'Failed to read inquiries' });
    }
  }

  const assetMatch = routePath.match(/^\/assets\/([^/]+)\/(image|gallery\/\d+|app\/.+)$/);
  if (event.httpMethod === 'GET' && assetMatch) {
    try {
      const templateId = assetMatch[1];
      const assetPath = assetMatch[2];
      if (assetPath.split('/').includes('..')) {
        return jsonResponse(400, { error: 'Invalid asset path' });
      }

      const bucket = await getBucket();
      let asset;
      if (assetPath.startsWith('app/')) {
        asset = await findTemplateAsset(bucket, templateId, assetPath);
      } else {
        const filename = `template-assets/${encodeURIComponent(templateId)}/${assetPath}`;
        const files = await bucket.find({ filename }).sort({ uploadDate: -1 }).toArray();
        if (files.length) asset = { file: files[0] };
      }

      if (!asset) return jsonResponse(404, { error: 'Template asset not found' });

      let contents;
      let contentType;
      if (asset.file) {
        const chunks = [];
        for await (const chunk of bucket.openDownloadStream(asset.file._id)) {
          chunks.push(chunk);
        }
        contents = Buffer.concat(chunks);
        contentType = asset.file.metadata?.contentType || 'application/octet-stream';
      } else {
        contents = asset.contents;
        contentType = asset.contentType;
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': imageContentType(contents, contentType),
          'Cache-Control': 'public, max-age=3600'
        },
        isBase64Encoded: true,
        body: contents.toString('base64')
      };
    } catch (error) {
      console.error('GET /api/assets/:id/* failed:', error);
      return jsonResponse(500, { error: 'Failed to read template asset' });
    }
  }

  const dataKeyMatch = routePath.match(/^\/data\/([^/]+)$/);
  if (event.httpMethod === 'POST' && dataKeyMatch) {
    if (!isAdminRequest(event)) {
      return jsonResponse(401, { error: 'Authentication required' });
    }
    if (!isJsonRequest(event)) {
      return jsonResponse(415, { error: 'Expected an application/json request' });
    }

    let value;
    try {
      value = parseRequestBody(event);
    } catch (error) {
      return jsonResponse(400, { error: 'Invalid JSON request body' });
    }

    try {
      await writeValue(await getBucket(), dataKeyMatch[1], value);
      return jsonResponse(200, { success: true });
    } catch (error) {
      console.error('POST /api/data/:key failed:', error);
      return jsonResponse(500, { error: 'Failed to save data store' });
    }
  }

  return jsonResponse(404, { error: 'Not found' });
};
