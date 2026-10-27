const { randomUUID } = require('node:crypto');

class InquiryValidationError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'InquiryValidationError';
        this.statusCode = statusCode;
    }
}

function createInquiry(input, template) {
    if (!template || template.status !== 'Published') {
        throw new InquiryValidationError('Template not found', 404);
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new InquiryValidationError('Invalid inquiry details');
    }

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
    const message = typeof input.message === 'string' ? input.message.trim() : '';

    if (!name || name.length > 120) {
        throw new InquiryValidationError('Name is required and must be 120 characters or fewer');
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new InquiryValidationError('Enter a valid email address');
    }
    if (phone.length > 40) {
        throw new InquiryValidationError('Phone number must be 40 characters or fewer');
    }
    if (!message || message.length > 5000) {
        throw new InquiryValidationError('Message is required and must be 5000 characters or fewer');
    }

    return {
        id: `inq_${randomUUID()}`,
        templateId: String(template.id),
        templateTitle: String(template.title || 'Untitled template'),
        name,
        email,
        phone,
        message,
        status: 'New',
        createdAt: new Date().toISOString()
    };
}

module.exports = { createInquiry, InquiryValidationError };
