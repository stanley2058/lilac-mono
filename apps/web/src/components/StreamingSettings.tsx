import type { NativeDeploymentSettings } from "@stanley2058/lilac-client-protocol";
import { Skeleton } from "./ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export type StreamingMode = NativeDeploymentSettings["outputStreaming"];
const options = [
  { value: "paragraph", label: "Paragraph" },
  { value: "complete", label: "Full" },
];

export function StreamingModeSelect({
  value,
  disabled,
  onChange,
}: {
  value: StreamingMode | null;
  disabled?: boolean;
  onChange: (mode: StreamingMode) => void;
}) {
  return (
    <Select
      items={options}
      value={value}
      disabled={disabled}
      onValueChange={(mode) => {
        if (mode === "paragraph" || mode === "complete") onChange(mode);
      }}
    >
      <SelectTrigger aria-label="Response streaming">
        <SelectValue
          placeholder={<Skeleton role="status" aria-label="Loading" className="h-3 w-20" />}
        />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
