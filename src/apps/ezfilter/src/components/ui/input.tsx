import { type JSX, splitProps } from "solid-js";
import { cn } from "../../lib/cn";

export type InputProps = JSX.InputHTMLAttributes<HTMLInputElement>;

export function Input(props: InputProps) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <input
      class={cn(
        "flex h-10 w-full rounded-xl border-2 border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-sm font-body",
        "placeholder:text-[rgb(var(--color-text-muted))]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-primary))] focus-visible:border-transparent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "transition-all duration-200",
        local.class
      )}
      {...rest}
    />
  );
}

export function Label(props: JSX.LabelHTMLAttributes<HTMLLabelElement>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <label
      class={cn(
        "text-sm font-semibold font-display leading-none",
        local.class
      )}
      {...rest}
    />
  );
}
