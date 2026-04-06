import { type JSX, splitProps } from "solid-js";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97] font-display",
  {
    variants: {
      variant: {
        default:
          "bg-[rgb(var(--color-primary))] text-white hover:bg-[rgb(var(--color-primary-hover))] shadow-md hover:shadow-lg",
        secondary:
          "bg-[rgb(var(--color-surface))] text-[rgb(var(--color-text))] border-2 border-[rgb(var(--color-border))] hover:bg-[rgb(var(--color-surface-hover))]",
        accent:
          "bg-[rgb(var(--color-accent))] text-[rgb(var(--color-text))] hover:bg-[rgb(var(--color-accent-hover))] shadow-md",
        ghost:
          "hover:bg-[rgb(var(--color-surface-hover))] text-[rgb(var(--color-text-muted))]",
        link: "text-[rgb(var(--color-primary))] underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-5 text-base",
        lg: "h-12 px-8 text-lg",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
);

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["class", "variant", "size"]);
  return (
    <button
      class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class)}
      {...rest}
    />
  );
}
