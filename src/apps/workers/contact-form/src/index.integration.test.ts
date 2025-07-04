import { fetchMock, SELF } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import worker from "./index";

// Mock environment for integration tests
const mockEnv = {
    MAILGUN_API_TOKEN: 'test-integration-token',
    RECIPIENT_EMAIL: 'integration-test@example.com',
    IP_RATE_LIMITER: {
        limit: async () => ({ success: true }),
    },
};

const mockCtx = {
    waitUntil: () => { },
    passThroughOnException: () => { },
    props: {},
} as ExecutionContext;

describe('Contact Form Worker - Integration Tests', () => {
    beforeAll(() => {
        // Enable outbound request mocking
        fetchMock.activate();
        fetchMock
            .get("https://api.mailgun.net")
            .intercept({
                path: "/v3/mail.ezdev.lol/messages",
                method: 'POST',
            })
            .reply(200, {
                id: '<integration-test-message-id@mail.ezdev.lol>',
                message: 'Queued. Thank you.'
            });
        // Throw errors if an outbound request isn't mocked
        fetchMock.disableNetConnect();
    });

    describe('Happy Path - Successful Form Submission', () => {
        it('should successfully process valid form data and send email', async () => {
            // Create valid JSON data
            const jsonData = {
                name: 'Integration Test User',
                email: 'integration@example.com',
                service: 'software-development',
                minBudget: '5000',
                maxBudget: '15000',
                currency: 'USD',
                message: 'This is an integration test message that meets the minimum length requirement for the contact form validation.',
                dateRange: ['2024-04-01T00:00:00.000Z', '2024-06-30T23:59:59.999Z']
            };

            const request = new Request('https://contact-form.example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': '192.168.1.1',
                    'Origin': 'https://ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('application/json');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol, https://www.ezdev.lol');

            const responseData = await response.json() as any;
            expect(responseData.success).toBe(true);
            expect(responseData.message).toBe('Form submitted successfully');
        });
    });

    describe('Invalid Path - Validation Errors', () => {
        it('should return validation errors for invalid form data', async () => {
            // Create invalid JSON data (missing required fields, invalid email, etc.)
            const jsonData = {
                name: '', // Empty name
                email: 'invalid-email-format', // Invalid email
                service: 'invalid-service', // Invalid service
                minBudget: '50', // Too low budget
                maxBudget: '25', // Max less than min
                currency: 'INVALID', // Invalid currency
                message: 'Short' // Too short message
            };

            const request = new Request('https://contact-form.example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(400);
            expect(response.headers.get('Content-Type')).toBe('application/json');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol, https://www.ezdev.lol');

            const responseData = await response.json() as any;
            expect(responseData.success).toBe(false);
            expect(responseData.error).toBeDefined();
            expect(responseData.fieldErrors).toBeDefined();

            // Should have validation errors for multiple fields
            expect(Object.keys(responseData.fieldErrors).length).toBeGreaterThan(0);
        });
    });

    describe('Rate Limiting Tests', () => {
        it('should block requests when IP rate limit is exceeded', async () => {
            // Create valid JSON data
            const jsonData = {
                name: 'Rate Limited User',
                email: 'user@example.com',
                service: 'consulting',
                minBudget: '2000',
                maxBudget: '8000',
                currency: 'USD',
                message: 'This is a test message for rate limiting that meets the minimum length requirement.'
            };

            // TODO: make this less flaky so that you can re-run the test multiple times without hitting the rate limit
            const request = new Request('https://contact-form.example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            });

            let response = await SELF.fetch(request);

            // First one should succeed
            expect(response.status).toBe(200);

            response = await SELF.fetch(new Request('https://contact-form.example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(jsonData),
            }));

            // Second one should hit the rate limit
            expect(response.status).toBe(429);
            expect(response.headers.get('Content-Type')).toBe('application/json');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol, https://www.ezdev.lol');

            const responseData = await response.json() as any;
            expect(responseData.success).toBe(false);
            expect(responseData.error).toBe('Rate limit exceeded. Please try again later.');
        });
    });

    describe('Email Sending Error Handling', () => {
        it('should handle Mailgun API errors gracefully', async () => {
            // Mock Mailgun API error response
            fetchMock
                .get("https://api.mailgun.net")
                .intercept({
                    path: "/v3/mail.ezdev.lol/messages",
                    headers: {
                        'Authorization': `Basic ${btoa('api:test-integration-token')}`
                    },
                    method: 'POST',
                })
                .reply(400, 'Bad Request - Invalid API key');

            // Create valid JSON data
            const jsonData = {
                name: 'Error Test User',
                email: 'error-test@example.com',
                service: 'software-development',
                minBudget: '4000',
                maxBudget: '12000',
                currency: 'USD',
                message: 'This is a test message for error handling that meets the minimum length requirement.'
            };

            const request = new Request('https://contact-form.example.com', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': '192.168.1.4',
                    'Origin': 'https://ezdev.lol'
                },
                body: JSON.stringify(jsonData),
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(500);
            expect(response.headers.get('Content-Type')).toBe('application/json');
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol, https://www.ezdev.lol');

            const responseData = await response.json() as any;
            expect(responseData.success).toBe(false);
            expect(responseData.error).toBe('Failed to send email');
        });
    });

    describe('CORS and Method Validation', () => {
        it('should handle OPTIONS preflight requests correctly', async () => {
            const request = new Request('https://contact-form.example.com', {
                method: 'OPTIONS',
                headers: {
                    'Origin': 'https://ezdev.lol',
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'Content-Type'
                }
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(200);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://ezdev.lol, https://www.ezdev.lol');
            expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
            expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
        });

        it('should reject non-POST requests', async () => {
            const request = new Request('https://contact-form.example.com', {
                method: 'GET',
                headers: {
                    'Origin': 'https://ezdev.lol'
                }
            });

            const response = await worker.fetch(request, mockEnv, mockCtx);

            expect(response.status).toBe(405);
            expect(response.headers.get('Access-Control-Allow-Origin')).toBe('ezdev.lol');

            const responseText = await response.text();
            expect(responseText).toBe('Method not allowed');
        });
    });
});