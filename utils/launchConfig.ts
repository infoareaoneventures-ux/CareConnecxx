export interface ConfiguredPhone {
  e164: string;
  display: string;
  telHref: string;
}

function configuredPhone(raw: string | undefined): ConfiguredPhone | null {
  const value = raw?.trim();
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  const e164 = value.startsWith('+') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
  const us = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return {
    e164,
    display: us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164,
    telHref: `tel:${e164}`,
  };
}

export const supportPhone = configuredPhone(import.meta.env.VITE_SUPPORT_PHONE);
// linqPhone (2026-10-04): removed — Evia's number comes from the server via lib/eviaPhone.ts, never a build-time copy.
