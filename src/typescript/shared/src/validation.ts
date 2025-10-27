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

    minBudget: z.number().positive('Minimum budget must be positive'),

    maxBudget: z.number().positive('Maximum budget must be positive'),

    currency: z
        .string()
        .min(3, 'Currency code must be 3 characters')
        .max(3, 'Currency code must be 3 characters')
        .toUpperCase()
        .refine(isSupportedCurrency, {
            message: 'Unsupported currency code'
        }) as z.ZodType<CurrencyCode>,

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
        // Ensure maxBudget >= minBudget
        return data.maxBudget >= data.minBudget;
    },
    {
        message: 'Maximum budget must be greater than or equal to minimum budget',
        path: ['maxBudget']
    }
).refine(
    (data: any) => {
        // Ensure minimum budget is at least $1000 USD equivalent
        try {
            const minBudgetUSD = convertBudgetToUSD(data.minBudget, data.currency);
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

            // @ts-expect-error
            error.errors.forEach((err: any) => {
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