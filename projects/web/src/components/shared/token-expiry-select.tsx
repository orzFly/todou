import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const DAY_MS = 24 * 60 * 60 * 1000;

const CHOICES = [
  { value: "never", label: "No expiration" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

/** Map a picker value to the API's expires_at (null = never expires). */
export function expiresAtFrom(choice: string): string | null {
  const days = Number(choice);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

/** Expiry picker shared by the personal and agent token issue forms. */
export function TokenExpirySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Token expiration" className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CHOICES.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
