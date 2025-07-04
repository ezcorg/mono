import { validateContactForm, getValidationErrorMessage, type ContactFormData } from '@ezdev/shared';

interface Env {
    MAILGUN_API_TOKEN: string;
    RECIPIENT_EMAIL?: string;
    IP_RATE_LIMITER: any;
}

const allowedOrigins = ['https://ezdev.lol', 'https://www.ezdev.lol'].join(', ');

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

        // Handle CORS preflight requests
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 200,
                headers: {
                    'Access-Control-Allow-Origin': allowedOrigins,
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
                    'Access-Control-Allow-Origin': 'ezdev.lol',
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
                        'Access-Control-Allow-Origin': allowedOrigins,
                    },
                });
            }

            const contactData = validationResult.data;

            // Get client IP for rate limiting
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
                        'Access-Control-Allow-Origin': allowedOrigins,
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
                        'Access-Control-Allow-Origin': allowedOrigins,
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
                        'Access-Control-Allow-Origin': allowedOrigins,
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
                    'Access-Control-Allow-Origin': allowedOrigins,
                },
            });
        }
    },
};

async function sendEmail(data: ContactFormData, env: Env) {
    const recipientEmail = env.RECIPIENT_EMAIL || 'dev@ezdev.lol';
    const senderEmail = `mailatron@mail.ezdev.lol`;

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
This email was sent from the ezdev.lol contact form.`.trim();

    const formData = new FormData();
    formData.append('from', `Mailatron 9000 <${senderEmail}>`);
    formData.append('to', recipientEmail);
    formData.append('subject', `[new project] [${data.service}] for ${data.name}`);
    formData.append('text', emailBody);
    formData.append('h:Reply-To', data.email);

    const response = await fetch(`https://api.mailgun.net/v3/mail.ezdev.lol/messages`, {
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