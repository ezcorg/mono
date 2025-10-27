import { validateContactForm, getValidationErrorMessage, type ContactFormData } from '@joinezco/shared';

interface Env {
    MAILGUN_API_TOKEN: string;
    RECIPIENT_EMAIL?: string;
    IP_RATE_LIMITER: any;
    TURNSTILE_SECRET_KEY: string;
    ALLOWED_ORIGINS?: string;
}

async function verifyTurnstile(token: string, secretKey: string, remoteIP?: string): Promise<boolean> {
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    if (remoteIP) {
        formData.append('remoteip', remoteIP);
    }

    try {
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            body: formData,
        });

        const result = await response.json() as { success: boolean; 'error-codes'?: string[] };
        return result.success;
    } catch (error) {
        console.error('Turnstile verification error:', error);
        return false;
    }
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const allowedOrigins = env.ALLOWED_ORIGINS || 'https://joinez.co, https://www.joinez.co';
        const allowedOriginsList = allowedOrigins.split(',').map(origin => origin.trim());

        // Get the client's origin
        const clientOrigin = request.headers.get('Origin');

        // Check if the client origin is allowed
        const isOriginAllowed = clientOrigin && allowedOriginsList.includes(clientOrigin);
        const corsOrigin = isOriginAllowed ? clientOrigin : allowedOriginsList[0]; // Default to first allowed origin

        // Handle CORS preflight requests
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': corsOrigin,
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                },
            });
        }

        // Only allow POST requests
        if (request.method !== 'POST') {
            return new Response('Method not allowed', {
                status: 405,
                headers: {
                    'Access-Control-Allow-Origin': corsOrigin,
                },
            });
        }

        try {
            // Parse and validate JSON data
            const jsonData = await request.json() as Record<string, any>;

            // Handle dateRange deserialization if present
            if (jsonData.dateRange && Array.isArray(jsonData.dateRange)) {
                jsonData.dateRange = jsonData.dateRange.map((dateStr: string) => new Date(dateStr));
            }

            const validationResult = validateContactForm(jsonData);

            if (!validationResult.success) {
                return new Response(JSON.stringify({
                    success: false,
                    error: getValidationErrorMessage(validationResult),
                    fieldErrors: validationResult.fieldErrors
                }), {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': corsOrigin,
                    },
                });
            }

            const contactData = validationResult.data;

            // Get client IP for rate limiting and Turnstile verification
            const clientIP = request.headers.get('CF-Connecting-IP') ||
                request.headers.get('X-Forwarded-For') ||
                'unknown';

            const ipRateLimit = await env.IP_RATE_LIMITER.limit({ key: clientIP });
            if (!ipRateLimit.success) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Rate limit exceeded. Please try again later.'
                }), {
                    status: 429,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': corsOrigin,
                    },
                });
            }

            // Verify Turnstile token
            const turnstileToken = jsonData.turnstileToken;
            if (!turnstileToken) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Captcha verification required'
                }), {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': corsOrigin,
                    },
                });
            }
            const turnstileValid = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, clientIP);
            if (!turnstileValid) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Captcha verification failed'
                }), {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': corsOrigin,
                    },
                });
            }

            try {
                await sendEmail(contactData, env);
                return new Response(JSON.stringify({
                    success: true,
                    message: 'Form submitted successfully'
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': corsOrigin,
                    },
                });
            } catch (emailError) {
                console.error('Error sending email:', emailError);
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Failed to send email'
                }), {
                    status: 500,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': corsOrigin,
                    },
                });
            }
        } catch (error) {
            console.error('Error processing form:', error);
            return new Response(JSON.stringify({
                success: false,
                error: 'Internal server error'
            }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': corsOrigin,
                },
            });
        }
    },
};

async function sendEmail(data: ContactFormData, env: Env) {
    const recipientEmail = env.RECIPIENT_EMAIL || 'dev@joinez.co';
    const senderEmail = `mailatron@mail.joinez.co`;

    // Format dateRange for display
    const formatDateRange = (dateRange?: [Date, Date]) => {
        if (!dateRange) return 'Not specified';
        const [start, end] = dateRange;
        return `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
    };

    const emailBody = `
New Project Inquiry from ${data.name}

Contact Information:
- Name: ${data.name}
- Email: ${data.email}

Project Details:
- Service: ${data.service}
- Timeline: ${formatDateRange(data.dateRange)}
- Budget: ${data.currency} ${data.minBudget} - ${data.maxBudget}

Message:
${data.message}

---
This email was sent from the joinez.co contact form.`.trim();

    const formData = new FormData();
    formData.append('from', `Mailatron 9000 <${senderEmail}>`);
    formData.append('to', recipientEmail);
    formData.append('subject', `[new project] [${data.service}] for ${data.name}`);
    formData.append('text', emailBody);
    formData.append('h:Reply-To', data.email);

    const response = await fetch(`https://api.mailgun.net/v3/mail.joinez.co/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${btoa(`api:${env.MAILGUN_API_TOKEN}`)}`,
        },
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Mailgun API error: ${response.status} - ${errorText}`);
    }

    return await response.json();
}