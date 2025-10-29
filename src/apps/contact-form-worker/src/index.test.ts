import { fetchMock } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index';

// Mock the WorkerMailer module
vi.mock('worker-mailer', () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    const mockClose = vi.fn().mockResolvedValue(undefined);
    const mockConnect = vi.fn().mockResolvedValue({
        send: mockSend,
        close: mockClose
    } as any);

    return {
        WorkerMailer: {
            connect: mockConnect,
            send: mockSend,
            close: mockClose,
        }
    };
});

// Get references to the mocked functions after the module is mocked
const { WorkerMailer } = await import('worker-mailer');
const mockConnect = vi.mocked(WorkerMailer.connect);
const mockSend = vi.mocked(WorkerMailer.send);
// @ts-expect-error
const mockClose = vi.mocked(WorkerMailer.close);

// Mock environment
const mockEnv = {
    EMAIL_USERNAME: 'test-email',
    EMAIL_PASSWORD: 'test-password',
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
        
        // Reset WorkerMailer mocks for each test
        mockConnect.mockClear();
        mockSend.mockClear();
        mockClose.mockClear();
        
        // Set up default successful behavior
        mockConnect.mockResolvedValue({
            send: mockSend,
            close: mockClose
        } as any);
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
                    'Origin': 'https://joinez.co'
                }
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co');
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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co'); // Default to first allowed origin
            expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
            expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
        });

        it('should handle OPTIONS preflight requests without origin header', async () => {
            const request = new Request('https://example.com', {
                method: 'OPTIONS',
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co'); // Default to first allowed origin
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
                    'Origin': 'https://joinez.co'
                }
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(405);
            const text = await response.text();
            expect(text).toBe('Method not allowed');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co');
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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co'); // Default to first allowed origin
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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co'); // Default to first allowed origin
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
                    'Origin': 'https://www.joinez.co'
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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.joinez.co');
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
                    'Origin': 'https://joinez.co'
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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co');
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
                    'Origin': 'https://www.joinez.co'
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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.joinez.co');
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
                    'Origin': 'https://joinez.co'
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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co');
        });
    });

    describe('Email Sending', () => {

        it('should properly mock WorkerMailer and verify email sending', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
                turnstileToken: 'test-token',
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://joinez.co'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful Turnstile verification
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(200, { success: true });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: true,
                message: 'Form submitted successfully'
            });

            // Verify that WorkerMailer.connect was called with correct parameters
            expect(mockConnect).toHaveBeenCalledWith({
                credentials: {
                    username: 'test-email',
                    password: 'test-password',
                },
                authType: 'plain',
                host: 'smtp.migadu.com',
                port: 465,
                secure: true,
            });

            // Verify that send was called
            expect(mockSend).toHaveBeenCalledWith({
                from: { name: 'Mailatron 9000', email: 'contact@joinez.co' },
                to: { email: 'test@example.com' },
                subject: '[new project] [software-development] for John Doe',
                html: expect.stringContaining('John Doe'),
                reply: { email: 'john@example.com', name: 'John Doe' },
            });

            // Verify that close was called
            expect(mockClose).toHaveBeenCalled();
        });

        it('should handle WorkerMailer connection errors', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
                turnstileToken: 'test-token',
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://joinez.co'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful Turnstile verification
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(200, { success: true });

            // Mock WorkerMailer connection failure
            mockConnect.mockRejectedValueOnce(new Error('SMTP connection failed'));

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Failed to send email'
            });
        });

        it('should handle WorkerMailer send errors', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: 1000,
                maxBudget: 5000,
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
                turnstileToken: 'test-token',
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://joinez.co'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful Turnstile verification
            fetchMock.get('https://challenges.cloudflare.com')
                .intercept({ method: 'POST', path: '/turnstile/v0/siteverify' })
                .reply(200, { success: true });

            // Mock WorkerMailer send failure
            const mockFailingSend = vi.fn().mockRejectedValue(new Error('Failed to send'));
            mockConnect.mockResolvedValueOnce({
                send: mockFailingSend,
                close: mockClose
            } as any);

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Failed to send email'
            });

            // Verify that send was attempted
            expect(mockFailingSend).toHaveBeenCalled();
        });
    });

    describe('Error Handling', () => {
        it('should handle unexpected errors gracefully with proper CORS header', async () => {
            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Origin': 'https://joinez.co'
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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://joinez.co');
        });

        it('should handle malformed JSON data with proper CORS header', async () => {
            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.joinez.co'
                },
                body: '{ invalid json',
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            const typedResponseData = responseData as { success: boolean; error: string };
            expect(typedResponseData.success).toBe(false);
            expect(typedResponseData.error).toBe('Internal server error');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.joinez.co');
        });
    });
});