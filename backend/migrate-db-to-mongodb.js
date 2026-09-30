const fs = require('node:fs/promises');
const path = require('node:path');
const MongoDataStore = require('./mongo-data-store');

async function main() {
    if (!process.env.MONGODB_URI) {
        throw new Error('Set MONGODB_URI before running the migration');
    }

    const sourceFile = process.env.DB_SOURCE_FILE || path.join(__dirname, 'db.json');
    const data = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
    const store = new MongoDataStore(
        process.env.MONGODB_URI,
        process.env.MONGODB_DATABASE || 'codemarket'
    );

    await store.connect();
    try {
        for (const [key, value] of Object.entries(data)) {
            await store.write(key, value);
            console.log(`Migrated ${key}`);
        }
    } finally {
        await store.close();
    }
}

main().catch((error) => {
    console.error('MongoDB migration failed:', error.message);
    process.exitCode = 1;
});