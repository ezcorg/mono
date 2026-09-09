import { validateContactForm, getValidationErrorMessage, type ContactFormData, describeBudget } from '@joinezco/shared';
import { WorkerMailer } from 'worker-mailer';

interface Env {
    EMAIL_USERNAME: string;
    EMAIL_PASSWORD: string;
    RECIPIENT_EMAIL?: string;
    IP_RATE_LIMITER: RateLimit;
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

            // Only now does the attempt count against the sender: a request that failed validation or the captcha never
            // gets this far, so it costs nothing. The binding can't hand a token back, so the budget in wrangler.toml
            // is a few per minute rather than one — a send that fails leaves room to try again straight away.
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
                        'Retry-After': '60',
                    },
                });
            }

            try {
                await sendEmailWithRetry(contactData, env);
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

/** One more go when a send fails: SMTP connections drop, and the sender's rate-limit token is already spent. */
async function sendEmailWithRetry(data: ContactFormData, env: Env, tries = 2) {
    let last: unknown;
    for (let i = 1; i <= tries; i++) {
        try { await sendEmail(data, env); return; }
        catch (e) { last = e; console.warn(`sendEmail attempt ${i} of ${tries} failed:`, e); }
    }
    throw last;
}

async function sendEmail(data: ContactFormData, env: Env) {
    const recipientEmail = env.RECIPIENT_EMAIL || 'dev@joinez.co';
    const senderEmail = `contact@joinez.co`;

    // Connect to SMTP server
    const mailer = await WorkerMailer.connect({
        credentials: {
            username: env.EMAIL_USERNAME,
            password: env.EMAIL_PASSWORD,
        },
        authType: 'plain',
        host: 'smtp.migadu.com',
        port: 465,
        secure: true,
    })

    const emailBody = `
<h2>Project details:</h2>
<ul>
    <li><strong>Budget:</strong> ${describeBudget(data)}</li>
</ul>

<h2>Message:</h2>
<p>${data.message}</p>

<hr>
<p><em>This email was sent from the joinez.co contact form.</em></p>`.trim();

    await mailer.send({
        from: { name: 'Mailatron 9000', email: senderEmail },
        to: { email: recipientEmail },
        subject: `[new project] [${data.service}] for ${data.name}`,
        html: emailBody,
        reply: { email: data.email, name: data.name },
    });
    await mailer.close();
}