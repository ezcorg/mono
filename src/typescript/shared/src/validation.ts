import { z } from 'zod';

// Valid service types
export const VALID_SERVICES = [
    'open-source',
    'software-development',
    'consulting',
    'other'
] as const;

export type ServiceType = typeof VALID_SERVICES[number];

// Contact form validation schema: what the room's "new project" forms send
export const ContactFormSchema = z.object({
    name: z
        .string()
        .min(1, 'Name is required')
        .max(100, 'Name must be less than 100 characters')
        .trim(),

    email: z
        .string()
        .min(1, 'Email is required')
        .email('Please enter a valid email address')
        .max(254, 'Email must be less than 254 characters')
        .toLowerCase()
        .trim(),

    service: z
        // @ts-expect-error
        .enum(VALID_SERVICES, {
            errorMap: () => ({ message: 'Please select a valid service type' })
        }),

    /* A single, optional budget in USD. */
    budget: z
        .number()
        .positive('Budget must be positive')
        .max(1e9, 'Budget must be less than $1,000,000,000')
        .optional(),

    message: z
        .string()
        .min(50, 'Message must be at least 50 characters long')
        .max(2000, 'Message must be less than 2000 characters')
        .trim(),

    turnstileToken: z
        .string()
        .optional()
});

export type ContactFormData = z.infer<typeof ContactFormSchema>;

/** The budget for humans: "$2,500 USD" or "Not specified". */
export function describeBudget(data: Pick<ContactFormData, 'budget'>): string {
    return data.budget === undefined ? 'Not specified' : `$${data.budget.toLocaleString('en-US')} USD`;
}

// Validation result types
export type ValidationSuccess<T> = {
    success: true;
    data: T;
};

export type ValidationError = {
    success: false;
    error: string;
    fieldErrors?: Record<string, string[]>;
};

export type ValidationResult<T> = ValidationSuccess<T> | ValidationError;

/**
 * Validate contact form data
 */
export function validateContactForm(data: Record<string, any>): ValidationResult<ContactFormData> {
    try {
        const result = ContactFormSchema.parse(data);
        return {
            success: true,
            data: result
        };
    } catch (error) {
        if (error instanceof z.ZodError) {
            const fieldErrors: Record<string, string[]> = {};

            error.issues.forEach((err: z.ZodIssue) => {
                const path = err.path.join('.');
                if (!fieldErrors[path]) {
                    fieldErrors[path] = [];
                }
                fieldErrors[path].push(err.message);
            });

            return {
                success: false,
                error: 'Validation failed',
                fieldErrors
            };
        }

        return {
            success: false,
            error: 'An unexpected validation error occurred'
        };
    }
}

/**
 * Get a user-friendly error message from validation errors
 */
export function getValidationErrorMessage(result: ValidationError): string {
    if (result.fieldErrors) {
        const firstError = Object.values(result.fieldErrors)[0];
        if (firstError && firstError.length > 0) {
            return firstError[0];
        }
    }
    return result.error;
}
