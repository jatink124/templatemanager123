const { MongoClient, GridFSBucket } = require('mongodb');

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

function jsonResponse(statusCode, value) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  };
}

function getRoutePath(event) {
  const requestPath = event.path || '';
  const functionPrefix = '/.netlify/functions/api';

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
      image: typeof template.image === 'string'
        ? template.image.slice(0, 2000)
        : undefined,
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

async function writeValue(bucket, key, value) {
  if (key === 'cm_templates') {
    value = await mergeTemplateAssets(bucket, value);
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

  if (event.httpMethod === 'GET' && routePath === '/data') {
    try {
      return jsonResponse(200, summarizeData(await readAll(await getBucket())));
    } catch (error) {
      console.error('GET /api/data failed:', error);
      return jsonResponse(500, { error: 'Failed to read data store' });
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

      const filename = `template-assets/${encodeURIComponent(templateId)}/${assetPath === 'image'
        ? 'image'
        : assetPath.startsWith('gallery/')
          ? assetPath
          : `app/${encodeURIComponent(assetPath.slice('app/'.length))}`}`;
      const bucket = await getBucket();
      const files = await bucket.find({ filename }).sort({ uploadDate: -1 }).toArray();
      if (!files.length) {
        return jsonResponse(404, { error: 'Template asset not found' });
      }

      const chunks = [];
      for await (const chunk of bucket.openDownloadStream(files[0]._id)) {
        chunks.push(chunk);
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': files[0].metadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600'
        },
        isBase64Encoded: true,
        body: Buffer.concat(chunks).toString('base64')
      };
    } catch (error) {
      console.error('GET /api/assets/:id/* failed:', error);
      return jsonResponse(500, { error: 'Failed to read template asset' });
    }
  }

  const dataKeyMatch = routePath.match(/^\/data\/([^/]+)$/);
  if (event.httpMethod === 'POST' && dataKeyMatch) {
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
