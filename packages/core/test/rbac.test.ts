import { describe, expect, it } from 'vitest';
import { can, scopesFor, isValidPermissionKey, type Principal } from '../src/rbac.js';

const ancestry = (sectionId: string, studentId: string) => ({
  ancestry: [
    { type: 'tenant' as const, id: 't1' },
    { type: 'department' as const, id: 'cse' },
    { type: 'section' as const, id: sectionId },
    { type: 'student' as const, id: studentId },
  ],
});

describe('rbac', () => {
  const teacher: Principal = {
    userId: 'u1', tenantId: 't1',
    grants: [{ permissions: new Set(['student:view', 'evaluation:evaluate']), scope: { type: 'section', id: 'A' } }],
  };

  it('grants within scope only', () => {
    expect(can(teacher, 'student:view', ancestry('A', 's1'))).toBe(true);
    expect(can(teacher, 'student:view', ancestry('B', 's2'))).toBe(false);
  });

  it('denies missing permission', () => {
    expect(can(teacher, 'student:delete', ancestry('A', 's1'))).toBe(false);
  });

  it('section-scoped grant cannot perform tenant-wide operations', () => {
    expect(can(teacher, 'student:view')).toBe(false);
  });

  it('supports wildcards and department scope', () => {
    const hod: Principal = { userId: 'u2', tenantId: 't1', grants: [{ permissions: new Set(['student:*']), scope: { type: 'department', id: 'cse' } }] };
    expect(can(hod, 'student:export', ancestry('B', 's2'))).toBe(true);
  });

  it('student self-scope', () => {
    const st: Principal = { userId: 'u3', tenantId: 't1', grants: [{ permissions: new Set(['growth:view']), scope: { type: 'student', id: 's1' } }] };
    expect(can(st, 'growth:view', ancestry('A', 's1'))).toBe(true);
    expect(can(st, 'growth:view', ancestry('A', 's9'))).toBe(false);
  });

  it('scopesFor lists scopes', () => {
    expect(scopesFor(teacher, 'student:view')).toEqual([{ type: 'section', id: 'A' }]);
  });

  it('validates permission keys', () => {
    expect(isValidPermissionKey('task:create')).toBe(true);
    expect(isValidPermissionKey('task:*')).toBe(true);
    expect(isValidPermissionKey('task:fly')).toBe(false);
    expect(isValidPermissionKey('nope:view')).toBe(false);
  });
});
