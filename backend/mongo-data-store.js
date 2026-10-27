const { MongoClient, GridFSBucket } = require('mongodb');
const { once } = require('node:events');

class MongoDataStore {
    constructor(uri, databaseName = 'codemarket') {
        this.client = new MongoClient(uri);
        this.databaseName = databaseName;
        this.bucket = null;
    }

    async connect() {
        await this.client.connect();
        this.bucket = new GridFSBucket(this.client.db(this.databaseName), {
            bucketName: 'app_data'
        });
    }

    async sendAll(res, allowedKeys = null) {
        const files = await this.bucket.find().sort({ uploadDate: 1 }).toArray();
        const latestByKey = new Map();
        for (const file of files) latestByKey.set(file.filename, file);

        res.type('application/json');
        res.write('{');
        let first = true;

        for (const [key, file] of latestByKey) {
            if (key === 'cm_customers') continue;
            if (allowedKeys && !allowedKeys.has(key)) continue;
            if (!first) res.write(',');
            first = false;
            res.write(`${JSON.stringify(key)}:`);

            if (allowedKeys && key === 'cm_templates') {
                const chunks = [];
                for await (const chunk of this.bucket.openDownloadStream(file._id)) {
                    chunks.push(chunk);
                }
                const templates = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const publicTemplates = Array.isArray(templates)
                    ? templates
                        .filter((template) => template && template.status === 'Published')
                        .map((template) => {
                            const { appData, sales, views, ...publicTemplate } = template;
                            return publicTemplate;
                        })
                    : templates;
                res.write(JSON.stringify(publicTemplates));
                continue;
            }

            for await (const chunk of this.bucket.openDownloadStream(file._id)) {
                if (!res.write(chunk)) await once(res, 'drain');
            }
        }

        res.end('}');
    }

    async write(key, value) {
        const upload = this.bucket.openUploadStream(key);
        const completed = new Promise((resolve, reject) => {
            upload.once('finish', resolve);
            upload.once('error', reject);
        });

        upload.end(JSON.stringify(value));
        await completed;

        const previousFiles = await this.bucket.find({
            filename: key,
            _id: { $ne: upload.id }
        }).toArray();
        await Promise.all(previousFiles.map((file) => this.bucket.delete(file._id)));
    }

    async read(key) {
        const files = await this.bucket.find({ filename: key }).sort({ uploadDate: -1 }).toArray();
        if (!files.length) return null;

        const chunks = [];
        for await (const chunk of this.bucket.openDownloadStream(files[0]._id)) {
            chunks.push(chunk);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }

    async append(key, value) {
        const current = await this.read(key);
        await this.write(key, [value, ...(Array.isArray(current) ? current : [])]);
    }

    async getTemplateAsset(templateId, assetPath) {
        const assetPrefix = `template-assets/${encodeURIComponent(templateId)}/app/`;
        const filenames = new Set([
            `${assetPrefix}${encodeURIComponent(assetPath)}`,
            `${assetPrefix}${assetPath}`,
            `${assetPrefix}${assetPath.split('/').map(encodeURIComponent).join('/')}`
        ]);

        for (const filename of filenames) {
            const files = await this.bucket.find({ filename }).sort({ uploadDate: -1 }).toArray();
            if (!files.length) continue;

            const file = files[0];
            const chunks = [];
            for await (const chunk of this.bucket.openDownloadStream(file._id)) {
                chunks.push(chunk);
            }

            return {
                contentType: file.metadata?.contentType || 'application/octet-stream',
                body: Buffer.concat(chunks)
            };
        }

        return null;
    }

    async getTemplateMedia(templateId, assetPath) {
        const filename = `template-assets/${encodeURIComponent(templateId)}/${assetPath}`;
        const files = await this.bucket.find({ filename }).sort({ uploadDate: -1 }).toArray();
        if (!files.length) return null;

        const file = files[0];
        const chunks = [];
        for await (const chunk of this.bucket.openDownloadStream(file._id)) {
            chunks.push(chunk);
        }

        return {
            contentType: file.metadata?.contentType || 'application/octet-stream',
            body: Buffer.concat(chunks)
        };
    }

    async close() {
        await this.client.close();
    }
}

module.exports = MongoDataStore;