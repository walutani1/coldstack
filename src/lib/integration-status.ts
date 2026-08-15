import "server-only";

import { getEmailTransportStatus } from "@/lib/notifications/email";
import { encryptionAvailable, getSecretStatus, type SecretName } from "@/lib/secrets";
import { resolveSmartleadConfig } from "@/lib/smartlead";
import { resolveZapmailConfig } from "@/lib/zapmail";
import type { EmailTransportStatus } from "@/lib/types";

export type IntegrationStatus = {
  encryptionAvailable: boolean;
  secrets: Record<SecretName, boolean>;
  smartlead: {
    configured: boolean;
    source: "app" | "env" | "none";
    baseUrl: string;
  };
  zapmail: {
    configured: boolean;
    workspaceId: string | null;
    serviceProvider: "GOOGLE" | "MICROSOFT";
  };
  email: EmailTransportStatus;
};

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  const [secrets, smartlead, zapmail, email] = await Promise.all([
    getSecretStatus(),
    resolveSmartleadConfig(),
    resolveZapmailConfig(),
    getEmailTransportStatus(),
  ]);
  return {
    encryptionAvailable: encryptionAvailable(),
    secrets,
    smartlead: {
      configured: Boolean(smartlead.apiKey),
      source: smartlead.source,
      baseUrl: smartlead.baseUrl,
    },
    zapmail: {
      configured: Boolean(zapmail.apiKey),
      workspaceId: zapmail.workspaceId,
      serviceProvider: zapmail.serviceProvider,
    },
    email,
  };
}
