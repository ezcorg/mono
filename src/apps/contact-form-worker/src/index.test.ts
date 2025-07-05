import { fetchMock } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index';

// Mock environment
const mockEnv = {
    MAILGUN_API_TOKEN: 'test-token',
    RECIPIENT_EMAIL: 'test@example.com',
    TURNSTILE_SECRET_KEY: 'test-turnstile-key',
    IP_RATE_LIMITER: {
        limit: vi.fn(),
    },
};

// Mock execution context
const mockCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
} as ExecutionContext;

describe('Contact Form Worker', () => {
    beforeEach(() => {
        fetchMock.activate();
        fetchMock.disableNetConnect();
        vi.clearAllMocks();
        // Default rate limiter responses (success)
        mockEnv.IP_RATE_LIMITER.limit.mockResolvedValue({ success: true });
    });

    afterEach(() => {
        fetchMock.deactivate();
        vi.restoreAllMocks();
    });

    describe('CORS Handling', () => {
        it('should handle OPTIONS preflight requests with allowed origin', async () => {
            const request = new Request('https://example.com', {
                method: 'OPTIONS',
                headers: {
                    'Origin': 'https://ezdev.lol'
                }
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol');
            expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
            expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
        });

        it('should handle OPTIONS preflight requests with disallowed origin', async () => {
            const request = new Request('https://example.com', {
                method: 'OPTIONS',
                headers: {
                    'Origin': 'https://malicious.com'
                }
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol'); // Default to first allowed origin
            expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
            expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
        });

        it('should handle OPTIONS preflight requests without origin header', async () => {
            const request = new Request('https://example.com', {
                method: 'OPTIONS',
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol'); // Default to first allowed origin
            expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
            expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
        });

        it('should use custom allowed origins from environment', async () => {
            const customEnv = {
                ...mockEnv,
                ALLOWED_ORIGINS: 'https://custom1.com, https://custom2.com'
            };

            const request = new Request('https://example.com', {
                method: 'OPTIONS',
                headers: {
                    'Origin': 'https://custom2.com'
                }
            });

            const response = await worker.fetch(request, customEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://custom2.com');
        });
    });

    describe('Method Validation', () => {
        it('should reject non-POST requests with allowed origin', async () => {
            const request = new Request('https://example.com', {
                method: 'GET',
                headers: {
                    'Origin': 'https://ezdev.lol'
                }
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(405);
            const text = await response.text();
            expect(text).toBe('Method not allowed');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol');
        });

        it('should reject non-POST requests with disallowed origin', async () => {
            const request = new Request('https://example.com', {
                method: 'GET',
                headers: {
                    'Origin': 'https://malicious.com'
                }
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(405);
            const text = await response.text();
            expect(text).toBe('Method not allowed');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol'); // Default to first allowed origin
        });
    });

    describe('Email Validation', () => {
        it('should return validation errors for invalid email', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'invalid-email',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements for the message field.'
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(400);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Please enter a valid email address',
                fieldErrors: {
                    email: ['Please enter a valid email address']
                }
            });
            expect(response.headers.get('Content-Type')).toBe('application/json');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol'); // Default to first allowed origin
        });

        it('should return validation errors for missing required fields', async () => {
            const jsonData = {
                name: '',
                email: ''
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(400);
            const responseData = await response.json() as {
                success: boolean;
                fieldErrors: Record<string, string[]>;
            };
            expect(responseData.success).toBe(false);
            expect(responseData.fieldErrors).toBeDefined();
            expect(responseData.fieldErrors.name).toContain('Name is required');
            expect(responseData.fieldErrors.email).toContain('Email is required');
        });

        it('should return validation errors for invalid budget values', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 100, // Too low
                maxBudget: 50, // Less than min
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.'
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(400);
            const responseData = await response.json() as {
                success: boolean;
                fieldErrors: Record<string, string[]>;
            };
            expect(responseData.success).toBe(false);
            expect(responseData.fieldErrors.minBudget).toBeDefined();
            expect(responseData.fieldErrors.maxBudget).toBeDefined();
        });
    });

    describe('Rate Limiting', () => {
        it('should return 429 when IP rate limit is exceeded with proper CORS header', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                turnstileToken: 'test-token',
                message: 'This is a test message that is long enough to meet the minimum requirements.'
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': '192.168.1.1',
                    'Origin': 'https://www.ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock IP rate limit exceeded
            mockEnv.IP_RATE_LIMITER.limit.mockResolvedValue({ success: false });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(429);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Rate limit exceeded. Please try again later.'
            });
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.ezdev.lol');
            expect(mockEnv.IP_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: '192.168.1.1' });
        });
    });

    describe('Turnstile Verification', () => {
        it('should reject requests with invalid Turnstile token and proper CORS header', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
                turnstileToken: 'invalid-token'
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock failed Turnstile verification
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(200, { success: false });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(400);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Captcha verification failed'
            });
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol');
        });

        it('should handle missing Turnstile token with proper CORS header', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.'
                // Missing turnstileToken
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(400);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Captcha verification required'
            });
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.ezdev.lol');
        });

        it('should handle Turnstile API errors gracefully with proper CORS header', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
                turnstileToken: 'test-token'
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock Turnstile API error
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(500, 'Internal Server Error');

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(400);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Captcha verification failed'
            });
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol');
        });
    });

    describe('Email Sending', () => {
        it('should successfully send email and return success response with proper CORS header', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
                turnstileToken: 'test-token',
                dateRange: ['2024-01-01T00:00:00.000Z', '2024-03-31T23:59:59.999Z'],
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful Turnstile verification
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(200, { success: true });

            // Mock successful Mailgun response
            fetchMock.get('https://api.mailgun.net')
                .intercept({ method: 'POST', path: '/v3/mail.ezdev.lol/messages' })
                .reply(200, { id: 'test-message-id' });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: true,
                message: 'Form submitted successfully'
            });

            // Verify the response has the correct CORS header
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.ezdev.lol');
        });

        it('should handle Mailgun API errors gracefully with proper CORS header', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                turnstileToken: 'test-token',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful Turnstile verification
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(200, { success: true });

            // Mock Mailgun API error
            fetchMock.get('https://api.mailgun.net')
                .intercept({ method: 'POST', path: '/v3/mail.ezdev.lol/messages' })
                .reply(400, 'Bad Request');

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Failed to send email'
            });
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol');
        });

        it('should use default recipient email when not provided in env', async () => {
            const envWithoutRecipient = {
                ...mockEnv,
                RECIPIENT_EMAIL: undefined
            };

            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                turnstileToken: 'test-token',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful Turnstile verification
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(200, { success: true });

            // Mock successful Mailgun response
            fetchMock.get('https://api.mailgun.net')
                .intercept({ method: 'POST', path: '/v3/mail.ezdev.lol/messages' })
                .reply(200, { id: 'test-message-id', ok: true });

            const response = await worker.fetch(request, envWithoutRecipient, mockCtx);

            expect(response.status).toBe(200);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: true,
                message: 'Form submitted successfully'
            });
        });
    });

    describe('Error Handling', () => {
        it('should handle unexpected errors gracefully with proper CORS header', async () => {
            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Origin': 'https://ezdev.lol'
                },
                body: 'invalid-form-data',
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Internal server error'
            });
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol');
        });

        it('should handle malformed JSON data with proper CORS header', async () => {
            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.ezdev.lol'
                },
                body: '{ invalid json',
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            const typedResponseData = responseData as { success: boolean; error: string };
            expect(typedResponseData.success).toBe(false);
            expect(typedResponseData.error).toBe('Internal server error');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.ezdev.lol');
        });
    });

    describe('Email Content Validation', () => {
        it('should format email content correctly', async () => {
            const jsonData = {
                name: 'Jane Smith',
                email: 'jane@example.com',
                service: 'consulting',
                minBudget: 2000,
                maxBudget: 10000,
                currency: 'EUR',
                message: 'I need help with my project. This is a detailed message about what I need.',
                dateRange: ['2024-04-01T00:00:00.000Z', '2024-06-30T23:59:59.999Z'],
                turnstileToken: 'test-token'
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful Turnstile verification
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(200, { success: true });

            // Mock successful Mailgun response
            fetchMock.get('https://api.mailgun.net')
                .intercept({ method: 'POST', path: '/v3/mail.ezdev.lol/messages' })
                .reply(200, { id: 'test-message-id' });

            const response = await worker.fetch(request, mockEnv, mockCtx);
            const responseData = await response.json();

            expect(response.status).toBe(200);

            expect(responseData).toEqual({
                success: true,
                message: 'Form submitted successfully'
            });
        });
    });
});