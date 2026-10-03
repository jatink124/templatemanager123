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
  for (const file of files) latestByKey.set(file.filename, file);

  const data = {};
  for (const [key, file] of latestByKey) {
    const chunks = [];
    for await (const chunk of bucket.openDownloadStream(file._id)) {
      chunks.push(chunk);
    }
    data[key] = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return data;
}

async function writeValue(bucket, key, value) {
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
      return jsonResponse(200, await readAll(await getBucket()));
    } catch (error) {
      console.error('GET /api/data failed:', error);
      return jsonResponse(500, { error: 'Failed to read data store' });
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
