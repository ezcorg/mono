import { Select as KSelect } from "@kobalte/core/select";
import { type JSX, splitProps, For } from "solid-js";
import { ChevronDown, Check } from "lucide-solid";
import { cn } from "../../lib/cn";

interface SelectProps {
  options: string[];
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  class?: string;
  disabled?: boolean;
}

export function Select(props: SelectProps) {
  const [local, rest] = splitProps(props, [
    "options",
    "value",
    "onChange",
    "placeholder",
    "class",
    "disabled",
  ]);

  return (
    <KSelect
      options={local.options}
      value={local.value}
      onChange={local.onChange}
      disabled={local.disabled}
      itemComponent={(itemProps) => (
        <KSelect.Item
          item={itemProps.item}
          class="relative flex cursor-pointer select-none items-center rounded-xl py-2 px-3 text-sm font-body outline-none transition-colors hover:bg-[rgb(var(--color-surface-hover))] data-[highlighted]:bg-[rgb(var(--color-surface-hover))]"
        >
          <KSelect.ItemLabel>{itemProps.item.rawValue}</KSelect.ItemLabel>
          <KSelect.ItemIndicator class="ml-auto">
            <Check class="h-4 w-4" />
          </KSelect.ItemIndicator>
        </KSelect.Item>
      )}
    >
      <KSelect.Trigger
        class={cn(
          "flex h-10 w-full items-center justify-between rounded-xl border-2 border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] px-3 py-2 text-sm font-body",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--color-primary))]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "transition-all duration-200",
          local.class
        )}
      >
        <KSelect.Value<string>>
          {(state) => state.selectedOption() ?? local.placeholder ?? "Select..."}
        </KSelect.Value>
        <KSelect.Icon>
          <ChevronDown class="h-4 w-4 opacity-50" />
        </KSelect.Icon>
      </KSelect.Trigger>
      <KSelect.Portal>
        <KSelect.Content class="z-50 min-w-[8rem] overflow-hidden rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface))] shadow-lg animate-fade-in">
          <KSelect.Listbox class="p-1" />
        </KSelect.Content>
      </KSelect.Portal>
    </KSelect>
  );
}
