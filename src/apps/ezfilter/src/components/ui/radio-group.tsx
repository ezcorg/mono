import { RadioGroup as KRadioGroup } from "@kobalte/core/radio-group";
import { type JSX, splitProps, For } from "solid-js";
import { cn } from "../../lib/cn";

interface RadioGroupProps {
  options: { value: string; label: string; description?: string }[];
  value?: string;
  onChange?: (value: string) => void;
  class?: string;
}

export function RadioGroup(props: RadioGroupProps) {
  const [local, rest] = splitProps(props, [
    "options",
    "value",
    "onChange",
    "class",
  ]);

  return (
    <KRadioGroup value={local.value} onChange={local.onChange}>
      <div class={cn("flex flex-col gap-3", local.class)}>
        <For each={local.options}>
          {(option) => (
            <KRadioGroup.Item value={option.value} class="group">
              <KRadioGroup.ItemInput />
              <label
                class={cn(
                  "flex cursor-pointer items-start gap-3 rounded-2xl border-2 border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] p-4",
                  "transition-all duration-200",
                  "hover:border-[rgb(var(--color-primary))]/50 hover:shadow-md",
                  "group-data-[checked]:border-[rgb(var(--color-primary))] group-data-[checked]:bg-[rgb(var(--color-primary))]/5 group-data-[checked]:shadow-md"
                )}
              >
                <KRadioGroup.ItemControl
                  class={cn(
                    "mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-[rgb(var(--color-border))] transition-all",
                    "group-data-[checked]:border-[rgb(var(--color-primary))] group-data-[checked]:bg-[rgb(var(--color-primary))]"
                  )}
                >
                  <KRadioGroup.ItemIndicator class="flex h-full w-full items-center justify-center">
                    <div class="h-2 w-2 rounded-full bg-white" />
                  </KRadioGroup.ItemIndicator>
                </KRadioGroup.ItemControl>
                <div class="flex flex-col gap-0.5">
                  <KRadioGroup.ItemLabel class="text-sm font-bold font-display">
                    {option.label}
                  </KRadioGroup.ItemLabel>
                  {option.description && (
                    <span class="text-xs text-[rgb(var(--color-text-muted))]">
                      {option.description}
                    </span>
                  )}
                </div>
              </label>
            </KRadioGroup.Item>
          )}
        </For>
      </div>
    </KRadioGroup>
  );
}
