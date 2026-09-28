/** Generic, auditable state machines for interventions and task assignments. */

export const INTERVENTION_STATES = ['created', 'assigned', 'accepted', 'in_progress', 'completed', 'evaluated', 'closed', 'cancelled'] as const;
export type InterventionState = (typeof INTERVENTION_STATES)[number];

const INTERVENTION_TRANSITIONS: Record<InterventionState, InterventionState[]> = {
  created: ['assigned', 'cancelled'],
  assigned: ['accepted', 'cancelled'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['evaluated'],
  evaluated: ['closed'],
  closed: [],
  cancelled: [],
};

export const ASSIGNMENT_STATES = ['pending_generation', 'assigned', 'in_progress', 'submitted', 'evaluated', 'expired', 'cancelled'] as const;
export type AssignmentState = (typeof ASSIGNMENT_STATES)[number];

const ASSIGNMENT_TRANSITIONS: Record<AssignmentState, AssignmentState[]> = {
  pending_generation: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'submitted', 'expired', 'cancelled'],
  in_progress: ['submitted', 'expired', 'cancelled'],
  submitted: ['evaluated', 'assigned' /* re-attempt allowed */],
  evaluated: ['assigned' /* re-attempt */],
  expired: [],
  cancelled: [],
};

export function canTransitionIntervention(from: InterventionState, to: InterventionState): boolean {
  return INTERVENTION_TRANSITIONS[from].includes(to);
}
export function canTransitionAssignment(from: AssignmentState, to: AssignmentState): boolean {
  return ASSIGNMENT_TRANSITIONS[from].includes(to);
}
