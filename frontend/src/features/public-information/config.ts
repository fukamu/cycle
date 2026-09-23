export type PublicInformationConfiguration = Readonly<{
  operatorName: string;
  contactUrl: string;
  accountDeletionBackupMaxDays: number;
}>;

export function readPublicInformationConfiguration():
  | PublicInformationConfiguration
  | undefined {
  const operatorName = import.meta.env.VITE_PRIVACY_OPERATOR_NAME?.trim();
  const contactUrl = parseContactUrl(import.meta.env.VITE_PRIVACY_CONTACT_URL);
  const accountDeletionBackupMaxDays = parsePositiveInteger(
    import.meta.env.VITE_ACCOUNT_DELETION_BACKUP_MAX_DAYS,
  );

  if (
    !operatorName ||
    contactUrl === undefined ||
    accountDeletionBackupMaxDays === undefined
  ) {
    return undefined;
  }

  return {
    operatorName,
    contactUrl,
    accountDeletionBackupMaxDays,
  };
}

function parseContactUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;

  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || !/^[1-9][0-9]*$/u.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
