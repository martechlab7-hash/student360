/**
 * Central, event-driven notification service. Business modules only emit domain events; this
 * service decides who is told what, on which channels, with de-duplication.
 */
import { many, one, withTenant, type Db } from '../db/pool.js';
import type { JobPayload } from '../jobs/bus.js';

export type Channel = 'in_app' | 'push' | 'email' | 'sms' | 'whatsapp';

export interface ChannelAdapter { send(to: { userId: string; email?: string }, msg: { title: string; body: string }): Promise<void> }

/** External channel adapters are registered at startup (SES/SendGrid, FCM, SMS/WhatsApp gateways). */
const adapters: Partial<Record<Channel, ChannelAdapter>> = {};
export function registerChannel(ch: Channel, a: ChannelAdapter) { adapters[ch] = a; }

interface Message { userIds: string[]; kind: string; title: string; body: string; data?: Record<string, unknown> }

async function studentUser(db: Db, studentId: string) {
  return (await one<{ user_id: string | null }>(db, `SELECT user_id FROM students WHERE id = $1`, [studentId]))?.user_id ?? null;
}

async function staffForStudent(db: Db, studentId: string, permission: string) {
  const rows = await many<{ user_id: string }>(db,
    `SELECT DISTINCT ra.user_id FROM role_assignments ra
       JOIN role_permissions rp ON rp.role_id = ra.role_id AND rp.permission_key IN ($2, split_part($2, ':', 1) || ':*')
       JOIN users u ON u.id = ra.user_id AND u.kind = 'staff'
       JOIN students s ON s.id = $1 JOIN org_units sec ON sec.id = s.section_id
      WHERE ra.scope_type <> 'tenant' AND ra.scope_id = ANY(sec.path)`, [studentId, permission]);
  return rows.map((r) => r.user_id);
}

async function route(db: Db, p: JobPayload): Promise<Message | null> {
  const studentId = p.studentId as string | undefined;
  switch (p.eventType) {
    case 'task.assigned': {
      const u = studentId && (await studentUser(db, studentId));
      return u ? { userIds: [u], kind: 'task', title: 'New task', body: String(p.title ?? 'You have a new growth task'), data: { assignmentId: p.aggregateId } } : null;
    }
    case 'evaluation.finalized': {
      const u = studentId && (await studentUser(db, studentId));
      return u ? { userIds: [u], kind: 'evaluation', title: 'Your task was evaluated', body: 'See your feedback and what to do next.', data: { submissionId: p.submissionId } } : null;
    }
    case 'evaluation.needs_review':
      return studentId ? { userIds: await staffForStudent(db, studentId, 'evaluation:evaluate'), kind: 'review', title: 'Submission awaiting review', body: 'A submission needs your evaluation.', data: { submissionId: p.submissionId } } : null;
    case 'recommendation.created': {
      const u = studentId && (await studentUser(db, studentId));
      return u ? { userIds: [u], kind: 'recommendation', title: 'Suggested next step', body: String(p.title), data: { recommendationId: p.aggregateId } } : null;
    }
    case 'growth.updated': {
      const u = studentId && (await studentUser(db, studentId));
      return u ? { userIds: [u], kind: 'milestone', title: 'Growth milestone', body: `Your growth score passed ${p.milestone}.`, data: {} } : null;
    }
    case 'attendance.flagged': {
      const organisers = await many<{ user_id: string }>(db,
        `SELECT DISTINCT ra.user_id FROM role_assignments ra JOIN role_permissions rp ON rp.role_id = ra.role_id
          WHERE rp.permission_key IN ('attendance:approve','attendance:*','*:*')`);
      return { userIds: organisers.map((o) => o.user_id), kind: 'attendance_review', title: 'Attendance needs review', body: `Check-in flagged: ${(p.flags as string[]).join(', ')}`, data: { attendanceId: p.aggregateId } };
    }
    case 'intervention.changed': {
      const users = [p.assigneeId, p.ownerId].filter((x): x is string => typeof x === 'string');
      return { userIds: users, kind: 'intervention', title: 'Intervention updated', body: `Status: ${p.state}`, data: { interventionId: p.aggregateId } };
    }
    default:
      return null;
  }
}

export async function fanout(p: JobPayload) {
  await withTenant({ tenantId: p.tenantId }, async (db) => {
    const msg = await route(db, p);
    if (!msg || msg.userIds.length === 0) return;
    for (const userId of new Set(msg.userIds)) {
      const u = await one<{ email: string; settings: any }>(db, `SELECT email, settings FROM users WHERE id = $1 AND status = 'active'`, [userId]);
      if (!u) continue;
      const channels: Channel[] = ['in_app', ...((u.settings?.notificationChannels ?? []) as Channel[]).filter((c) => c !== 'in_app')];
      for (const ch of channels) {
        const r = await db.query(
          `INSERT INTO notifications (user_id, channel, kind, title, body, data, status, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, user_id, channel, dedupe_key) DO NOTHING RETURNING id`,
          [userId, ch, msg.kind, msg.title, msg.body, JSON.stringify(msg.data ?? {}), ch === 'in_app' ? 'sent' : 'pending', `evt:${p.eventId}`]);
        if (r.rowCount && ch !== 'in_app' && adapters[ch]) {
          try {
            await adapters[ch]!.send({ userId, email: u.email }, msg);
            await db.query(`UPDATE notifications SET status = 'sent' WHERE id = $1`, [r.rows[0].id]);
          } catch {
            await db.query(`UPDATE notifications SET status = 'failed' WHERE id = $1`, [r.rows[0].id]);
          }
        }
      }
    }
  });
}
