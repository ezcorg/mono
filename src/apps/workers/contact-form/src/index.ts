import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

interface ContactFormData {
    name: string;
    email: string;
    service: string;
    dateRange?: string;
    minBudget: string;
    maxBudget: string;
    currency: string;
    message: string;
}

const allowedOrigins = ['https://ezdev.lol', 'https://www.ezdev.lol'].join(', ');

export default {
    async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {

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
            // Parse form data
            const formData = await request.formData();

            const contactData: ContactFormData = {
                name: formData.get('name') as string,
                email: formData.get('email') as string,
                service: formData.get('service') as string,
                dateRange: formData.get('dateRange') as string || '',
                minBudget: formData.get('minBudget') as string,
                maxBudget: formData.get('maxBudget') as string,
                currency: formData.get('currency') as string,
                message: formData.get('message') as string,
            };

            // Validate required fields
            if (!contactData.name || !contactData.email || !contactData.service ||
                !contactData.minBudget || !contactData.maxBudget || !contactData.message) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Missing required fields'
                }), {
                    status: 400,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': allowedOrigins,
                    },
                });
            }

            // Validate message length
            if (contactData.message.length < 50) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Message must be at least 50 characters long'
                }), {
                    status: 400,
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

async function sendEmail(data: ContactFormData, env: any) {
    const msg = createMimeMessage();
    msg.setSender({ name: "Mailatron 9000", addr: "mailatron@ezdev.lol" });
    msg.setRecipient("dev@ezdev.lol");
    msg.setSubject(`[new project] [${data.service}] for ${data.name}`);
    msg.addMessage({
        contentType: 'text/plain',
        data: `
New Project Inquiry from ${data.name}

Contact Information:
- Name: ${data.name}
- Email: ${data.email}

Project Details:
- Service: ${data.service}
- Timeline: ${data.dateRange || 'Not specified'}
- Budget: ${data.currency} ${data.minBudget} - ${data.maxBudget}

Message:
${data.message}

---
This email was sent from the ezdev.lol contact form.`.trim()
    });

    var message = new EmailMessage(
        "mailatron@ezdev.lol",
        "dev@ezdev.lol",
        msg.asRaw()
    );

    await env.SEB.send(message);
}