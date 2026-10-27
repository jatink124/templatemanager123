function imageContentType(contents, fallback) {
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);

    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) ||
        bytes.subarray(0, 6).equals(Buffer.from('GIF89a'))) {
        return 'image/gif';
    }
    if (bytes.length >= 12 &&
        bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
        bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) {
        return 'image/webp';
    }
    if (bytes.subarray(0, 2).equals(Buffer.from('BM'))) {
        return 'image/bmp';
    }
    if (bytes.length >= 12 &&
        bytes.subarray(4, 8).equals(Buffer.from('ftyp')) &&
        (bytes.subarray(8, 12).equals(Buffer.from('avif')) ||
            bytes.subarray(8, 12).equals(Buffer.from('avis')))) {
        return 'image/avif';
    }

    return fallback;
}

module.exports = imageContentType;
