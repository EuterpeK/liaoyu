import type { DbOrTx } from '../db/client.ts';
import { auditLogs } from '../db/schema.ts';

export interface AuditEntry {
  adminId: number | null;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export async function audit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({ adminId: e.adminId, action: e.action, target: e.target, detail: e.detail ?? {} });
}
