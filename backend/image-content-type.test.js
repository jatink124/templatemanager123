const test = require('node:test');
const assert = require('node:assert/strict');
const imageContentType = require('./image-content-type');

test('image content type follows the file signature instead of a wrong label', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

    assert.equal(imageContentType(jpeg, 'image/png'), 'image/jpeg');
});

test('image content type keeps the supplied type when the format is unknown', () => {
    assert.equal(imageContentType(Buffer.from('image bytes'), 'image/png'), 'image/png');
});
