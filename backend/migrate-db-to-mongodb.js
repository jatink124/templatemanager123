const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns');
const { MongoClient, GridFSBucket } = require('mongodb');

if (process.env.MONGODB_DNS_SERVERS) {
    dns.setServers(process.env.MONGODB_DNS_SERVERS.split(',').map((server) => server.trim()));
}

const DATABASE_NAME = process.env.MONGODB_DATABASE || 'codemarket';
const BUCKET_NAME = 'app_data';

function dataUri(value) {
    const match = typeof value === 'string'
        ? value.match(/^data:([^;,]+);base64,([\s\S]*)$/)
        : null;
    return match
        ? { contentType: match[1], contents: Buffer.from(match[2], 'base64') }
        : null;
}

function contentTypeFor(fileName) {
    const extension = path.extname(fileName).toLowerCase();
    return ({
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.txt': 'text/plain; charset=utf-8',
        '.xml': 'application/xml; charset=utf-8'
    })[extension] || 'application/octet-stream';
}

async function removePreviousFiles(bucket, filename, keepId) {
    const previousFiles = await bucket.find({
        filename,
        _id: { $ne: keepId }
    }).toArray();
    await Promise.all(previousFiles.map((file) => bucket.delete(file._id)));
}

async function writeFile(bucket, filename, contents, contentType) {
    const upload = bucket.openUploadStream(filename, {
        metadata: { contentType }
    });
    const completed = new Promise((resolve, reject) => {
        upload.once('finish', resolve);
        upload.once('error', reject);
    });

    upload.end(contents);
    await completed;
    await removePreviousFiles(bucket, filename, upload.id);
}

async function writeValue(bucket, key, value) {
    const upload = bucket.openUploadStream(key, {
        metadata: { contentType: 'application/json; charset=utf-8' }
    });
    const completed = new Promise((resolve, reject) => {
        upload.once('finish', resolve);
        upload.once('error', reject);
    });

    upload.end(JSON.stringify(value));
    await completed;
    await removePreviousFiles(bucket, key, upload.id);
}

async function migrateTemplates(bucket, templates) {
    if (!Array.isArray(templates)) {
        await writeValue(bucket, 'cm_templates', templates);
        return;
    }

    const summaries = [];
    for (const template of templates) {
        const id = String(template.id);
        const assetPrefix = `template-assets/${encodeURIComponent(id)}`;
        const summary = { ...template };
        delete summary.appData;

        const image = dataUri(template.image);
        if (image) {
            await writeFile(bucket, `${assetPrefix}/image`, image.contents, image.contentType);
            summary.image = `/api/assets/${encodeURIComponent(id)}/image`;
        }

        if (Array.isArray(template.gallery)) {
            summary.gallery = [];
            for (let index = 0; index < template.gallery.length; index += 1) {
                const galleryImage = dataUri(template.gallery[index]);
                if (!galleryImage) {
                    if (typeof template.gallery[index] === 'string') {
                        summary.gallery.push(template.gallery[index]);
                    }
                    continue;
                }

                const filename = `${assetPrefix}/gallery/${index}`;
                await writeFile(bucket, filename, galleryImage.contents, galleryImage.contentType);
                summary.gallery.push(`/api/assets/${encodeURIComponent(id)}/gallery/${index}`);
            }
        }

        const appData = template.appData;
        const appFiles = appData && typeof appData === 'object' && !Array.isArray(appData)
            ? Object.entries(appData)
            : [];
        const htmlEntry = appFiles.find(([fileName]) => fileName.toLowerCase() === 'index.html')
            || appFiles.find(([fileName]) => /\.html?$/i.test(fileName));

        summary.hasAppData = appFiles.length > 0;
        if (htmlEntry) summary.appEntry = htmlEntry[0];

        for (const [fileName, contents] of appFiles) {
            if (fileName.split(/[\\/]/).includes('..') || path.isAbsolute(fileName)) {
                throw new Error(`Unsafe app data path in template ${id}`);
            }

            const assetName = `${assetPrefix}/app/${encodeURIComponent(fileName)}`;
            const embeddedAsset = dataUri(contents);
            await writeFile(
                bucket,
                assetName,
                embeddedAsset ? embeddedAsset.contents : Buffer.from(String(contents)),
                embeddedAsset ? embeddedAsset.contentType : contentTypeFor(fileName)
            );
        }

        summaries.push(summary);
        console.log(`Prepared template ${template.title || id}`);
    }

    await writeValue(bucket, 'cm_templates', summaries);
}

async function main() {
    if (!process.env.MONGODB_URI) {
        throw new Error('Set MONGODB_URI before running the migration');
    }

    const sourceFile = process.env.DB_SOURCE_FILE || path.join(__dirname, 'db.json');
    const data = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
    const client = new MongoClient(process.env.MONGODB_URI);

    await client.connect();
    try {
        const bucket = new GridFSBucket(client.db(DATABASE_NAME), {
            bucketName: BUCKET_NAME
        });

        for (const [key, value] of Object.entries(data)) {
            if (key === 'cm_templates') {
                await migrateTemplates(bucket, value);
            } else {
                await writeValue(bucket, key, value);
            }
            console.log(`Migrated ${key}`);
        }
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error('MongoDB migration failed:', error.message);
    process.exitCode = 1;
});
