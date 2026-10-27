const test = require('node:test');
const assert = require('node:assert/strict');
const { createInquiry, InquiryValidationError } = require('./inquiries');

const template = { id: 'template-1', title: 'Landing Page', status: 'Published' };
const validInput = {
    templateId: template.id,
    name: '  Casey Example ',
    email: 'CASEY@example.com ',
    phone: '+1 555 0100',
    message: 'Can you help customize this?'
};

test('inquiry records include sanitized contact details and template metadata', () => {
    const inquiry = createInquiry(validInput, template);

    assert.match(inquiry.id, /^inq_[0-9a-f-]{36}$/);
    assert.equal(inquiry.templateId, template.id);
    assert.equal(inquiry.templateTitle, template.title);
    assert.equal(inquiry.name, 'Casey Example');
    assert.equal(inquiry.email, 'casey@example.com');
    assert.equal(inquiry.phone, '+1 555 0100');
    assert.equal(inquiry.message, validInput.message);
    assert.equal(inquiry.status, 'New');
    assert.equal(Number.isNaN(Date.parse(inquiry.createdAt)), false);
});

test('inquiries require a published template and valid contact information', () => {
    assert.throws(
        () => createInquiry(validInput, { ...template, status: 'Draft' }),
        (error) => error instanceof InquiryValidationError && error.statusCode === 404
    );
    assert.throws(
        () => createInquiry({ ...validInput, email: 'not-an-email' }, template),
        /valid email address/
    );
    assert.throws(
        () => createInquiry({ ...validInput, message: '  ' }, template),
        /Message is required/
    );
    assert.throws(
        () => createInquiry(null, template),
        /Invalid inquiry details/
    );
});
