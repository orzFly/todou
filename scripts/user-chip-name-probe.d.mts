/** Independent seed/API expectation is mandatory; any ambiguity fails closed. */
export function findUserChipName(
  chip: Element | null | undefined,
  expectedText: string | undefined,
): HTMLElement | null;

export function probeUserChipNameLookup(options: {
  nameFinderSource: string;
}): Promise<{
  status: "pass" | "fail";
  reason?: string;
  oracle?: string;
  samples: Array<{
    id: string;
    expected: string;
    actual: string;
    mutationConfirmed: boolean;
    identityConfirmed: boolean;
    status: string;
  }>;
}>;
