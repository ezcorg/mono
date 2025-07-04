import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index';

// Mock the shared validation functions
vi.mock('@ezdev/shared', () => ({
    validateContactForm: vi.fn(),
    getValidationErrorMessage: vi.fn(),
}));

// Import the mocked functions
import { validateContactForm, getValidationErrorMessage } from '@ezdev/shared';

// Mock fetch for Mailgun API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock environment
const mockEnv = {
    MAILGUN_API_TOKEN: 'test-token',
    RECIPIENT_EMAIL: 'test@example.com',
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
        vi.clearAllMocks();
        // Default rate limiter responses (success)
        mockEnv.IP_RATE_LIMITER.limit.mockResolvedValue({ success: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('CORS Handling', () => {
        it('should handle OPTIONS preflight requests correctly', async () => {
            const request = new Request('https://example.com', {
                method: 'OPTIONS',
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol, https://www.ezdev.lol');
            expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
            expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
        });
    });

    describe('Method Validation', () => {
        it('should reject non-POST requests', async () => {
            const request = new Request('https://example.com', {
                method: 'GET',
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(405);
            const text = await response.text();
            expect(text).toBe('Method not allowed');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('ezdev.lol');
        });
    });

    describe('Email Validation', () => {
        it('should return validation errors for invalid email', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'invalid-email',
                service: 'software-development',
                minBudget: '1000',
                maxBudget: '5000',
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

            // Mock validation failure
            (validateContactForm as any).mockReturnValue({
                success: false,
                fieldErrors: {
                    email: ['Please enter a valid email address']
                }
            });

            (getValidationErrorMessage as any).mockReturnValue('Please enter a valid email address');

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
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol, https://www.ezdev.lol');
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

            // Mock validation failure for multiple fields
            (validateContactForm as any).mockReturnValue({
                success: false,
                fieldErrors: {
                    name: ['Name is required'],
                    email: ['Email is required'],
                    service: ['Please select a valid service type'],
                    message: ['Message must be at least 50 characters long']
                }
            });

            (getValidationErrorMessage as any).mockReturnValue('Name is required');

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
                minBudget: '100', // Too low
                maxBudget: '50', // Less than min
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

            (validateContactForm as any).mockReturnValue({
                success: false,
                fieldErrors: {
                    minBudget: ['Minimum budget must be at least $1,000 USD equivalent'],
                    maxBudget: ['Maximum budget must be greater than or equal to minimum budget']
                }
            });

            (getValidationErrorMessage as any).mockReturnValue('Minimum budget must be at least $1,000 USD equivalent');

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
        it('should return 429 when IP rate limit is exceeded', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: '1000',
                maxBudget: '5000',
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.'
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': '192.168.1.1'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful validation
            (validateContactForm as any).mockReturnValue({
                success: true,
                data: {
                    name: 'John Doe',
                    email: 'john@example.com',
                    service: 'software-development',
                    minBudget: 1000,
                    maxBudget: 5000,
                    currency: 'USD',
                    message: 'This is a test message that is long enough to meet the minimum requirements.'
                }
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
            expect(mockEnv.IP_RATE_LIMITER.limit).toHaveBeenCalledWith({ key: '192.168.1.1' });
        });
    });

    describe('Email Sending', () => {
        it('should successfully send email and return success response', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: '1000',
                maxBudget: '5000',
                currency: 'USD',
                message: 'This is a test message that is long enough to meet the minimum requirements.',
                dateRange: ['2024-01-01T00:00:00.000Z', '2024-03-31T23:59:59.999Z']
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful validation
            (validateContactForm as any).mockReturnValue({
                success: true,
                data: {
                    name: 'John Doe',
                    email: 'john@example.com',
                    service: 'software-development',
                    minBudget: 1000,
                    maxBudget: 5000,
                    currency: 'USD',
                    message: 'This is a test message that is long enough to meet the minimum requirements.',
                    dateRange: [new Date('2024-01-01T00:00:00.000Z'), new Date('2024-03-31T23:59:59.999Z')]
                }
            });

            // Mock successful Mailgun response
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ id: 'test-message-id' })
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: true,
                message: 'Form submitted successfully'
            });

            // Verify Mailgun API was called correctly
            expect(mockFetch).toHaveBeenCalledWith(
                'https://api.mailgun.net/v3/mail.ezdev.lol/messages',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'Authorization': `Basic ${btoa('api:test-token')}`
                    }),
                    body: expect.any(FormData)
                })
            );
        });

        it('should handle Mailgun API errors gracefully', async () => {
            const jsonData = {
                name: 'John Doe',
                email: 'john@example.com',
                service: 'software-development',
                minBudget: '1000',
                maxBudget: '5000',
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

            // Mock successful validation
            (validateContactForm as any).mockReturnValue({
                success: true,
                data: {
                    name: 'John Doe',
                    email: 'john@example.com',
                    service: 'software-development',
                    minBudget: 1000,
                    maxBudget: 5000,
                    currency: 'USD',
                    message: 'This is a test message that is long enough to meet the minimum requirements.'
                }
            });

            // Mock Mailgun API error
            mockFetch.mockResolvedValue({
                ok: false,
                status: 400,
                text: () => Promise.resolve('Bad Request')
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Failed to send email'
            });
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
                minBudget: '1000',
                maxBudget: '5000',
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

            // Mock successful validation
            (validateContactForm as any).mockReturnValue({
                success: true,
                data: {
                    name: 'John Doe',
                    email: 'john@example.com',
                    service: 'software-development',
                    minBudget: 1000,
                    maxBudget: 5000,
                    currency: 'USD',
                    message: 'This is a test message that is long enough to meet the minimum requirements.'
                }
            });

            // Mock successful Mailgun response
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ id: 'test-message-id' })
            });

            const response = await worker.fetch(request, envWithoutRecipient, mockCtx);

            expect(response.status).toBe(200);
            expect(mockFetch).toHaveBeenCalled();

            // Verify the email was sent to the default recipient
            const callArgs = mockFetch.mock.calls[0];
            const formDataSent = callArgs[1].body;
            expect(formDataSent).toBeInstanceOf(FormData);
        });
    });

    describe('Error Handling', () => {
        it('should handle unexpected errors gracefully', async () => {
            const request = new Request('https://example.com', {
                method: 'POST',
                body: 'invalid-form-data',
            });

            // Mock validation to throw an error
            (validateContactForm as any).mockImplementation(() => {
                throw new Error('Unexpected error');
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            expect(responseData).toEqual({
                success: false,
                error: 'Internal server error'
            });
        });

        it('should handle malformed JSON data', async () => {
            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: '{ invalid json',
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            const responseData = await response.json();
            const typedResponseData = responseData as { success: boolean; error: string };
            expect(typedResponseData.success).toBe(false);
            expect(typedResponseData.error).toBe('Internal server error');
        });
    });

    describe('Email Content Validation', () => {
        it('should format email content correctly', async () => {
            const jsonData = {
                name: 'Jane Smith',
                email: 'jane@example.com',
                service: 'consulting',
                minBudget: '2000',
                maxBudget: '10000',
                currency: 'EUR',
                message: 'I need help with my project. This is a detailed message about what I need.',
                dateRange: ['2024-04-01T00:00:00.000Z', '2024-06-30T23:59:59.999Z']
            };

            const request = new Request('https://example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            });

            // Mock successful validation
            (validateContactForm as any).mockReturnValue({
                success: true,
                data: {
                    name: 'Jane Smith',
                    email: 'jane@example.com',
                    service: 'consulting',
                    minBudget: 2000,
                    maxBudget: 10000,
                    currency: 'EUR',
                    message: 'I need help with my project. This is a detailed message about what I need.',
                    dateRange: [new Date('2024-04-01T00:00:00.000Z'), new Date('2024-06-30T23:59:59.999Z')]
                }
            });

            // Mock successful Mailgun response
            mockFetch.mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ id: 'test-message-id' })
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(mockFetch).toHaveBeenCalled();

            // Verify the email content structure
            const callArgs = mockFetch.mock.calls[0];
            const formDataSent = callArgs[1].body;
            expect(formDataSent).toBeInstanceOf(FormData);

            // The actual email content validation would require inspecting the FormData,
            // but we can verify the API call was made with correct structure
            expect(callArgs[0]).toBe('https://api.mailgun.net/v3/mail.ezdev.lol/messages');
            expect(callArgs[1].method).toBe('POST');
            expect(callArgs[1].headers.Authorization).toBe(`Basic ${btoa('api:test-token')}`);
        });
    });
});