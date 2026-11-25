import type { ParsedEnv } from './env.ts';

export type CalendarCredentialSource = 'env_pair' | 'env_json' | 'file_path' | 'none';

export type CalendarConfig = {
  calendarId: string | undefined;
  timeZone: string;
  clientEmail: string | undefined;
  privateKey: string | undefined;
  credentialsJson: string | undefined;
  credentialsPath: string | undefined;
  credentialSource: CalendarCredentialSource;
  isConfigured: boolean;
};

export function buildCalendarConfig(env: ParsedEnv): CalendarConfig {
  let credentialSource: CalendarCredentialSource = 'none';
  if (env.GOOGLE_CALENDAR_CLIENT_EMAIL && env.GOOGLE_CALENDAR_PRIVATE_KEY) {
    credentialSource = 'env_pair';
  } else if (env.GOOGLE_CALENDAR_CREDENTIALS_JSON) {
    credentialSource = 'env_json';
  } else if (env.GOOGLE_CALENDAR_CREDENTIALS_PATH) {
    credentialSource = 'file_path';
  }

  return {
    calendarId: env.GOOGLE_CALENDAR_ID,
    timeZone: env.GOOGLE_CALENDAR_TIME_ZONE,
    clientEmail: env.GOOGLE_CALENDAR_CLIENT_EMAIL,
    privateKey: env.GOOGLE_CALENDAR_PRIVATE_KEY,
    credentialsJson: env.GOOGLE_CALENDAR_CREDENTIALS_JSON,
    credentialsPath: env.GOOGLE_CALENDAR_CREDENTIALS_PATH,
    credentialSource,
    isConfigured: Boolean(env.GOOGLE_CALENDAR_ID && credentialSource !== 'none'),
  };
}
