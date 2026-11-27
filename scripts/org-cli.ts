import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvironmentFiles } from '../src/config/index.ts';
import {
  compileNotificationLabels,
  summarizeOrganizationSpec,
} from '../src/config/organization-compiler.ts';
import { closeDbPool, getDbPool, withTransaction } from '../src/db/client.ts';
import { NORTHSTAR_BUSINESS_ID } from '../src/db/seed.ts';
import { type OrganizationSpec, parseOrganizationSpec } from '../src/models/organization-spec.ts';

function loadSpecFromPath(filePath: string): OrganizationSpec {
  const absPath = resolve(process.cwd(), filePath);
  const rawText = readFileSync(absPath, 'utf8');
  const rawJson = JSON.parse(rawText) as unknown;
  const parsed = parseOrganizationSpec(rawJson);
  if (!parsed.success) {
    console.error(`❌ Organization config validation failed for ${filePath}:`);
    for (const err of parsed.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

const DAY_INDEX_MAP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

async function applyOrganizationSpecToDb(spec: OrganizationSpec): Promise<void> {
  loadEnvironmentFiles();
  const businessId = spec.organization.id ?? process.env.ACTIVE_BUSINESS_ID ?? NORTHSTAR_BUSINESS_ID;

  await withTransaction(async (client) => {
    await client.query(
      `
      UPDATE aibitsol.businesses
      SET name = $2,
          receptionist_name = $3,
          description = $4,
          location = $5,
          timezone = $6,
          emergency_policy = $7,
          pricing_policy = $8,
          default_appointment_duration_minutes = $9,
          ai_voice = $10,
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        businessId,
        spec.organization.name,
        spec.aiInstructions.assistantName,
        spec.organization.description,
        spec.organization.location,
        spec.organization.timezone,
        spec.escalationRules.emergencyPolicy,
        spec.escalationRules.pricingPolicy,
        spec.availability.defaultDurationMinutes,
        spec.aiInstructions.voice,
      ],
    );

    // Sync services
    await client.query(`UPDATE aibitsol.services SET is_active = FALSE WHERE business_id = $1`, [
      businessId,
    ]);
    for (const svc of spec.services.filter((s) => s.isActive)) {
      await client.query(
        `
        INSERT INTO aibitsol.services (business_id, name, description, duration_minutes, is_active)
        VALUES ($1, $2, $3, $4, TRUE)
        ON CONFLICT (business_id, name)
        DO UPDATE SET description = EXCLUDED.description,
                      duration_minutes = EXCLUDED.duration_minutes,
                      is_active = TRUE
        `,
        [businessId, svc.name, svc.description ?? null, svc.durationMinutes],
      );
    }

    // Sync business hours
    for (const [dayKey, dayIndex] of Object.entries(DAY_INDEX_MAP)) {
      const label = spec.businessHours[dayKey as keyof typeof spec.businessHours];
      if (typeof label !== 'string') continue;
      const isClosed = /^closed$/i.test(label.trim());
      await client.query(
        `
        UPDATE aibitsol.business_hours
        SET display_label = $3, is_closed = $4
        WHERE business_id = $1 AND day_of_week = $2
        `,
        [businessId, dayIndex, label.trim(), isClosed],
      );
    }

    // Sync service areas
    await client.query(`DELETE FROM aibitsol.service_areas WHERE business_id = $1`, [businessId]);
    for (const area of spec.organization.serviceAreas) {
      await client.query(
        `
        INSERT INTO aibitsol.service_areas (business_id, area_name)
        VALUES ($1, $2)
        ON CONFLICT (business_id, area_name) DO NOTHING
        `,
        [businessId, area],
      );
    }

    // Persist full universal OrganizationSpec snapshot in workspace_settings
    await client.query(`
      CREATE TABLE IF NOT EXISTS aibitsol.workspace_settings (
        business_id UUID NOT NULL,
        setting_key TEXT NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (business_id, setting_key)
      )
    `);
    await client.query(
      `
      INSERT INTO aibitsol.workspace_settings (business_id, setting_key, payload, updated_at)
      VALUES ($1, 'organization_spec', $2::jsonb, NOW())
      ON CONFLICT (business_id, setting_key)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
      `,
      [businessId, JSON.stringify(spec)],
    );
  }, getDbPool());

  await closeDbPool();
}

async function main() {
  const [, , command = 'validate', maybePath, ...rest] = process.argv;
  const allFlags = [maybePath, ...rest].filter(Boolean) as string[];
  const confirmFlag = allFlags.includes('--confirm');
  const filePath =
    maybePath && !maybePath.startsWith('--') ? maybePath : 'config/organization.json';

  const spec = loadSpecFromPath(filePath);

  if (command === 'validate') {
    console.log(`✅ Valid OrganizationSpec (${filePath}):`);
    console.log(`   Organization : ${spec.organization.name} (${spec.organization.type})`);
    console.log(`   Active Svcs  : ${spec.services.filter((s) => s.isActive).length}`);
    console.log(`   Terminology  : ${spec.customerInfo.callerLabel} / ${spec.customerInfo.locationLabel} (${spec.customerInfo.fulfillmentMode})`);
    return;
  }

  if (command === 'preview') {
    console.log(`📋 Preview for ${filePath}:`);
    console.log(JSON.stringify(summarizeOrganizationSpec(spec), null, 2));
    console.log('📨 Notification Labels:', JSON.stringify(compileNotificationLabels(spec), null, 2));
    return;
  }

  if (command === 'apply') {
    console.log(`📋 Organization Config Preview (${filePath}):`);
    console.log(JSON.stringify(summarizeOrganizationSpec(spec), null, 2));
    if (!confirmFlag) {
      console.log(
        '\n⚠️  Dry-run only. Re-run with --confirm to apply this configuration to PostgreSQL:',
      );
      console.log(`   node scripts/org-cli.ts apply ${filePath} --confirm`);
      return;
    }
    await applyOrganizationSpecToDb(spec);
    console.log(
      `\n✅ Applied "${spec.organization.name}" (${spec.organization.type}) to PostgreSQL successfully.`,
    );
    return;
  }

  console.error(`Unknown command "${command}". Use: validate | preview | apply`);
  process.exit(1);
}

main().catch((err) => {
  console.error('❌ org-cli failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
