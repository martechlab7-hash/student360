/**
 * Demo seed: provisions "demo-college" and drives the REAL pipeline (outbox → jobs → mock AI →
 * evaluation → growth) so every screen has meaningful data. Historical skill signals are
 * backdated to produce 8 weeks of growth history.
 *
 *   npm run db:migrate && npm run db:seed
 */
import { fileURLToPath } from 'node:url';
import { closePools, many, one, withPlatform, withTenant, type Db } from './pool.js';
import { InlineBus } from '../jobs/bus.js';
import { handlers } from '../jobs/handlers.js';
import { relayOutbox } from '../jobs/relay.js';
import { deleteTenant, provisionTenant } from '../services/tenancy.js';
import { createStaff, createStudent, linkGuardian } from '../services/people.js';
import { createTemplate, publishTemplate, submit, TemplateInput } from '../services/tasks.js';
import { recalculateStudent } from '../services/growth.js';
import { newSessionSecret } from '../services/attendance.js';
import { loadPrincipal, type AuthContext } from '../auth/principal.js';

export const DEMO = { tenant: 'demo-college', password: 'Growth#Demo2026' };

async function drain(bus: InlineBus) {
  for (let i = 0; i < 50; i++) {
    const n = await relayOutbox(bus);
    const m = await bus.drain();
    if (n === 0 && m === 0) break;
  }
}

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

export async function seed(log = console.log, reset = process.argv.includes('--reset')) {
  const existing = await withPlatform((db) => one<{ id: string }>(db, `SELECT id FROM tenants WHERE slug = $1`, [DEMO.tenant]));
  if (existing && !reset) { log('demo tenant already exists — run with --reset to recreate it'); return; }
  if (existing) { await deleteTenant(existing.id); log('removed existing demo tenant'); }

  const { tenantId, adminUserId } = await provisionTenant({
    slug: DEMO.tenant, name: 'Demo Institute of Technology',
    admin: { email: 'admin@demo.edu', fullName: 'Asha Rao (Admin)', password: DEMO.password },
  });
  const sys = { userId: adminUserId };
  const bus = new InlineBus(() => handlers);
  const T = <R>(fn: (db: Db) => Promise<R>) => withTenant({ tenantId, userId: adminUserId }, fn);

  // ── Organisation hierarchy ────────────────────────────────────
  const org = await T(async (db) => {
    const ins = async (type: string, name: string, code: string, parentId: string | null) =>
      (await one<{ id: string }>(db, `INSERT INTO org_units (type, name, code, parent_id) VALUES ($1,$2,$3,$4) RETURNING id`, [type, name, code, parentId]))!.id;
    const campus = await ins('campus', 'Main Campus', 'MAIN', null);
    const cse = await ins('department', 'Computer Science & Engineering', 'CSE', campus);
    const ece = await ins('department', 'Electronics & Communication', 'ECE', campus);
    const btCse = await ins('program', 'B.Tech CSE', 'BT-CSE', cse);
    const btEce = await ins('program', 'B.Tech ECE', 'BT-ECE', ece);
    const bCse = await ins('batch', 'CSE 2024–28', 'CSE-2024', btCse);
    const bEce = await ins('batch', 'ECE 2024–28', 'ECE-2024', btEce);
    return { campus, cse, ece, cseA: await ins('section', 'CSE-A', 'CSE-2024-A', bCse), cseB: await ins('section', 'CSE-B', 'CSE-2024-B', bCse), eceA: await ins('section', 'ECE-A', 'ECE-2024-A', bEce) };
  });

  // ── Skill graph ──────────────────────────────────────────────
  const skills = await T(async (db) => {
    const dim = async (k: string) => (await one<{ id: string }>(db, `SELECT id FROM growth_dimensions WHERE key = $1`, [k]))!.id;
    const ins = async (key: string, name: string, dimKey: string, parentId: string | null = null) =>
      (await one<{ id: string }>(db, `INSERT INTO skills (key, name, dimension_id, parent_id) VALUES ($1,$2,$3,$4) RETURNING id`, [key, name, await dim(dimKey), parentId]))!.id;
    const python = await ins('python', 'Python', 'coding');
    const comm = await ins('communication', 'Communication', 'communication');
    const s = {
      python, comm,
      pySyntax: await ins('python.syntax', 'Python Syntax', 'coding', python), pyOop: await ins('python.oop', 'Object-Oriented Python', 'coding', python),
      pyDs: await ins('python.ds', 'Data Structures', 'coding', python), pyAlgo: await ins('python.algorithms', 'Algorithms', 'coding', python),
      pyDebug: await ins('python.debugging', 'Debugging', 'coding', python),
      speaking: await ins('communication.fluency', 'Spoken Fluency', 'communication', comm), grammar: await ins('communication.grammar', 'Grammar', 'english', comm),
      presentation: await ins('communication.presentation', 'Presentation', 'communication', comm),
      structured: await ins('communication.structured', 'Structured Thinking', 'critical_thinking', comm),
      aptitude: await ins('aptitude.quant', 'Quantitative Aptitude', 'problem_solving'), logic: await ins('aptitude.logic', 'Logical Reasoning', 'problem_solving'),
      sql: await ins('dbms.sql', 'SQL', 'technical'), dbms: await ins('dbms.concepts', 'DBMS Concepts', 'academics'),
      resume: await ins('career.resume', 'Resume & Profile', 'career'), interview: await ins('career.interview', 'Interview Skills', 'career'),
      teamwork: await ins('teamwork.collab', 'Collaboration', 'teamwork'), leadership: await ins('leadership.initiative', 'Initiative', 'leadership'),
    };
    return s;
  });

  // ── Staff ────────────────────────────────────────────────────
  const staff = await T(async (db) => ({
    teacher: (await createStaff(db, sys, { email: 'teacher@demo.edu', fullName: 'Ravi Kumar (Teacher)', password: DEMO.password,
      roles: [{ role: 'teacher', scopeType: 'section', scopeId: org.cseA }, { role: 'teacher', scopeType: 'section', scopeId: org.cseB }] }, tenantId)).userId,
    hod: (await createStaff(db, sys, { email: 'hod@demo.edu', fullName: 'Dr. Meera Iyer (HOD CSE)', password: DEMO.password,
      roles: [{ role: 'hod', scopeType: 'department', scopeId: org.cse }] }, tenantId)).userId,
    events: (await createStaff(db, sys, { email: 'events@demo.edu', fullName: 'Karan Shah (Events)', password: DEMO.password,
      roles: [{ role: 'event_coordinator', scopeType: 'tenant' }] }, tenantId)).userId,
  }));

  // ── Students (3 with logins) + a parent ─────────────────────
  const first = ['Aarav', 'Diya', 'Ishaan', 'Ananya', 'Vihaan', 'Saanvi', 'Kabir', 'Myra', 'Arjun', 'Kiara', 'Reyansh', 'Aadhya', 'Vivaan', 'Anika', 'Advik',
    'Navya', 'Dhruv', 'Pari', 'Aryan', 'Sara', 'Rohan', 'Isha', 'Krish', 'Tara', 'Neel', 'Riya', 'Yash', 'Zoya', 'Om', 'Meher'];
  const interests = [['cricket', 'music'], ['startups', 'design'], ['gaming', 'AI'], ['debate', 'reading'], ['robotics'], ['photography', 'travel']];
  const students = await T(async (db) => {
    const out: { id: string; section: string; idx: number }[] = [];
    for (let i = 0; i < first.length; i++) {
      const section = i < 12 ? org.cseA : i < 22 ? org.cseB : org.eceA;
      const withLogin = i < 3;
      const s = await createStudent(db, sys, {
        fullName: `${first[i]} ${['Sharma', 'Patel', 'Reddy', 'Nair', 'Gupta', 'Singh'][i % 6]}`, sectionId: section, rollNo: `24${section === org.eceA ? 'EC' : 'CS'}${String(i + 1).padStart(3, '0')}`,
        enrollmentYear: 2024, email: withLogin ? `student${i + 1}@demo.edu` : undefined, password: withLogin ? DEMO.password : undefined,
        interests: interests[i % interests.length], careerGoals: [i % 3 === 0 ? 'Software Engineer' : i % 3 === 1 ? 'Data Scientist' : 'Product Manager'],
      });
      out.push({ id: s.id, section, idx: i });
    }
    await linkGuardian(db, sys, out[0]!.id, { email: 'parent@demo.edu', fullName: 'Sunita Sharma (Parent)', password: DEMO.password });
    await db.query(`INSERT INTO consents (user_id, subject_student_id, purpose, granted, policy_version)
                    SELECT $1, id, 'ai_processing', true, '2026-01' FROM students`, [adminUserId]);
    return out;
  });

  // ── 8 weeks of backdated evidence + skill signals (varied trajectories) ──
  const r = rng(42);
  const leafSkills = [skills.pySyntax, skills.pyOop, skills.pyDs, skills.pyAlgo, skills.pyDebug, skills.speaking, skills.grammar, skills.presentation, skills.structured,
    skills.aptitude, skills.logic, skills.sql, skills.dbms, skills.resume, skills.interview, skills.teamwork, skills.leadership];
  await T(async (db) => {
    for (const st of students) {
      const talent = 35 + r() * 35;         // starting ability
      const slope = -2 + r() * 7;            // points per week (some decline, most improve)
      for (let week = 8; week >= 0; week--) {
        for (const sk of leafSkills) {
          if (r() < 0.55) continue;
          const at = new Date(Date.now() - week * 7 * 86400_000 - Math.floor(r() * 5) * 86400_000);
          const ability = talent + (8 - week) * slope + (r() - 0.5) * 10;
          const difficulty = Math.max(10, Math.min(90, ability - 5 + (r() - 0.5) * 20));
          const perf = Math.max(0, Math.min(1, 1 / (1 + Math.exp(-(ability - difficulty) / 15)) + (r() - 0.5) * 0.2));
          const verification = r() < 0.75 ? 'VERIFIED' : r() < 0.6 ? 'PARTIALLY_VERIFIED' : 'SELF_REPORTED';
          const ev = await one<{ id: string }>(db,
            `INSERT INTO evidence (student_id, source, activity_type, title, skill_ids, verification_level, confidence, occurred_at, data)
             VALUES ($1, $2, 'practice', 'Practice activity (historical)', ARRAY[$3]::uuid[], $4, 0.8, $5, '{"seed":true}') RETURNING id`,
            [st.id, verification === 'SELF_REPORTED' ? 'self_report' : 'system', sk, verification, at]);
          await db.query(`INSERT INTO skill_signals (student_id, skill_id, source_type, source_id, performance, difficulty, verification, weight, occurred_at)
                          VALUES ($1,$2,'seed',$3,$4,$5,$6,1,$7)`, [st.id, sk, ev!.id, perf.toFixed(4), difficulty.toFixed(1), verification, at]);
        }
      }
    }
  });
  for (const st of students) {
    for (let week = 8; week >= 1; week--) await recalculateStudent(tenantId, st.id, new Date(Date.now() - week * 7 * 86400_000));
    await recalculateStudent(tenantId, st.id);
  }
  await drain(bus);

  // ── Teacher-created growth tasks (published → AI personalised per student) ──
  const teacherActor = { userId: staff.teacher };
  const dimId = async (db: Db, k: string) => (await one<{ id: string }>(db, `SELECT id FROM growth_dimensions WHERE key = $1`, [k]))!.id;
  await withTenant({ tenantId, userId: staff.teacher }, async (db) => {
    const due = new Date(Date.now() + 2 * 86400_000);
    const speaking = await createTemplate(db, teacherActor, TemplateInput.parse({
      type: 'audio', title: 'Intermediate English Speaking', objective: 'Speak for two minutes taking a clear position on a debatable topic with reasons and a conclusion.',
      skillIds: [skills.speaking, skills.structured], dimensionId: await dimId(db, 'communication'), difficultyLevel: 'intermediate', mode: 'EQUIVALENT',
      config: { attempts: 2 }, target: { sectionIds: [org.cseA, org.cseB] }, dueAt: due,
    }));
    const apt = await createTemplate(db, teacherActor, TemplateInput.parse({
      type: 'mcq', title: 'Aptitude: Percentages', objective: 'Solve a percentage-change problem.', skillIds: [skills.aptitude],
      dimensionId: await dimId(db, 'problem_solving'), difficultyLevel: 'basic', mode: 'STANDARDIZED',
      content: { question: 'A price rises from 400 to 500. What is the percentage increase?', options: ['20%', '25%', '80%', '100%'], answerIndex: 1 },
      target: { sectionIds: [org.cseA, org.cseB] }, dueAt: due,
    }));
    const explain = await createTemplate(db, teacherActor, TemplateInput.parse({
      type: 'text_response', title: 'Explain a Python concept', objective: 'Explain a core Python concept clearly with an example.',
      skillIds: [skills.pyOop], dimensionId: await dimId(db, 'coding'), difficultyLevel: 'intermediate', mode: 'ADAPTIVE',
      target: { sectionIds: [org.cseA, org.cseB] }, dueAt: due,
    }));
    const baseline = await createTemplate(db, teacherActor, TemplateInput.parse({
      type: 'text_response', title: 'English Communication — Baseline', objective: 'Write a structured 150-word response on: "Should internships be mandatory?"',
      skillIds: [skills.structured], dimensionId: await dimId(db, 'communication'), difficultyLevel: 'intermediate', mode: 'STANDARDIZED', assessmentKind: 'baseline',
      target: { sectionIds: [org.cseA] },
    }));
    for (const id of [speaking, apt, explain, baseline]) await publishTemplate(db, teacherActor, id);
  });
  await drain(bus);

  // ── Student 1 completes some tasks through the real submission path ──
  const s1 = students[0]!;
  const s1User = (await T((db) => one<{ user_id: string }>(db, `SELECT user_id FROM students WHERE id = $1`, [s1.id])))!.user_id;
  const s1Auth: AuthContext = await withTenant({ tenantId, userId: s1User }, async (db) =>
    ({ principal: await loadPrincipal(db, s1User, tenantId), userId: s1User, tenantId, sessionId: 'seed', kind: 'student' }));
  await withTenant({ tenantId, userId: s1User }, async (db) => {
    const as = await many<{ id: string; type: string; title: string }>(db,
      `SELECT a.id, t.type, t.title FROM task_assignments a JOIN task_templates t ON t.id = a.template_id WHERE a.student_id = $1`, [s1.id]);
    for (const a of as) {
      if (a.type === 'mcq') await submit(db, s1Auth, a.id, { answerIndex: 1 });
      if (a.title.includes('Baseline')) await submit(db, s1Auth, a.id, { text: 'Firstly, internships give real experience. Secondly, they help students choose careers because they see real work. However, they must be paid and flexible. In conclusion, internships should be strongly encouraged and supported, and mandatory where the institution can guarantee quality placements for everyone.' });
    }
  });
  await drain(bus);

  // ── A live event with dynamic-QR attendance ─────────────────
  await withTenant({ tenantId, userId: staff.events }, async (db) => {
    const e = await one<{ id: string }>(db,
      `INSERT INTO events (name, organizer, category, venue, capacity, dimension_id, skill_ids, status, created_by)
       VALUES ('Tech Talk: Building on the Cloud', 'CSE Tech Club', 'technical', 'Seminar Hall 2', 120, (SELECT id FROM growth_dimensions WHERE key = 'technical'), $1, 'published', $2) RETURNING id`,
      [[skills.sql], staff.events]);
    await db.query(`INSERT INTO event_sessions (event_id, title, starts_at, ends_at, attendance_secret) VALUES ($1, 'Main session', now() - interval '10 minutes', now() + interval '2 hours', $2)`,
      [e!.id, newSessionSecret()]);
    await db.query(`INSERT INTO event_registrations (event_id, student_id) SELECT $1, id FROM students WHERE section_id = $2`, [e!.id, org.cseA]);
    await db.query(`INSERT INTO events (name, organizer, category, venue, dimension_id, status, created_by)
                    VALUES ('Inter-college Debate', 'Literary Club', 'cultural', 'Auditorium', (SELECT id FROM growth_dimensions WHERE key = 'communication'), 'published', $1)`, [staff.events]);
    await db.query(`INSERT INTO event_sessions (event_id, starts_at, ends_at, attendance_secret)
                    SELECT id, now() + interval '5 days', now() + interval '5 days 3 hours', $1 FROM events WHERE name = 'Inter-college Debate'`, [newSessionSecret()]);
  });
  await drain(bus);

  log(`\nSeeded tenant "${DEMO.tenant}" (${tenantId}). Log in with institution "${DEMO.tenant}" and password "${DEMO.password}":`);
  log('  admin@demo.edu    — College Admin');
  log('  hod@demo.edu      — HOD, CSE department');
  log('  teacher@demo.edu  — Teacher, sections CSE-A and CSE-B');
  log('  events@demo.edu   — Event Coordinator');
  log('  student1@demo.edu — Student (also student2, student3)');
  log('  parent@demo.edu   — Parent of student1');
  if (bus.failures.length) log(`  (${bus.failures.length} background jobs failed: ${bus.failures.map((f) => `${f.name}: ${(f.error as Error).message}`).join('; ')})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed().then(async () => { await closePools(); process.exit(0); }, async (e) => { console.error(e); await closePools(); process.exit(1); });
}
