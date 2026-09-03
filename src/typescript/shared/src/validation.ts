import { z } from 'zod';
import { CurrencyCode, convertBudgetToUSD, MIN_USD_VALUE, isSupportedCurrency } from './currency';

// Valid service types
export const VALID_SERVICES = [
    'open-source',
    'software-development',
    'consulting',
    'other'
] as const;

export type ServiceType = typeof VALID_SERVICES[number];

// Contact form validation schema
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
    dateRange: z
        .tuple([z.date(), z.date()])
        .refine(([start, end]) => start <= end, {
            message: 'Start date must be before or equal to end date',
            path: ['dateRange']
        })
        .optional(),

    /* A single, optional budget in USD (the room's forms). */
    budget: z
        .number()
        .positive('Budget must be positive')
        .optional(),

    /* Legacy range fields (the flat /newproject form); still accepted. */
    minBudget: z.number().positive('Minimum budget must be positive').optional(),

    maxBudget: z.number().positive('Maximum budget must be positive').optional(),

    currency: (z
        .string()
        .min(3, 'Currency code must be 3 characters')
        .max(3, 'Currency code must be 3 characters')
        .toUpperCase()
        .refine(isSupportedCurrency, {
            message: 'Unsupported currency code'
        }) as z.ZodType<CurrencyCode>).optional(),

    message: z
        .string()
        .min(50, 'Message must be at least 50 characters long')
        .max(2000, 'Message must be less than 2000 characters')
        .trim(),

    turnstileToken: z
        .string()
        .optional()
}).refine(
    (data: any) => {
        // A range needs both ends
        return (data.minBudget === undefined) === (data.maxBudget === undefined);
    },
    {
        message: 'Provide both a minimum and a maximum budget',
        path: ['maxBudget']
    }
).refine(
    (data: any) => {
        // Ensure maxBudget >= minBudget
        return data.maxBudget === undefined || data.minBudget === undefined || data.maxBudget >= data.minBudget;
    },
    {
        message: 'Maximum budget must be greater than or equal to minimum budget',
        path: ['maxBudget']
    }
).refine(
    (data: any) => {
        // Ensure a minimum budget, when given, is at least $1000 USD equivalent
        if (data.minBudget === undefined) return true;
        try {
            const minBudgetUSD = convertBudgetToUSD(data.minBudget, data.currency ?? 'USD');
            return minBudgetUSD >= MIN_USD_VALUE;
        } catch {
            return false;
        }
    },
    {
        message: `Minimum budget must be at least $${MIN_USD_VALUE.toLocaleString()} USD equivalent`,
        path: ['minBudget']
    }
);

export type ContactFormData = z.infer<typeof ContactFormSchema>;

/** A one-line description of the budget for humans: the single figure, the legacy range, or nothing. */
export function describeBudget(data: Pick<ContactFormData, 'budget' | 'minBudget' | 'maxBudget' | 'currency'>): string {
    if (data.budget !== undefined) return `$${data.budget.toLocaleString()} USD`;
    if (data.minBudget !== undefined && data.maxBudget !== undefined) return `${data.currency ?? 'USD'} ${data.minBudget.toLocaleString()} - ${data.maxBudget.toLocaleString()}`;
    return 'Not specified';
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
            error: 'Unknown validation error'
        };
    }
}

/**
 * Get user-friendly error message from validation result
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