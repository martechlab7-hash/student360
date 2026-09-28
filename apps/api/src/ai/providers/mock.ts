/**
 * Deterministic provider for development, CI and golden tests. It produces schema-valid,
 * plausible output without calling any external service, so the whole product loop can be
 * exercised offline. Outputs are derived from a hash of the inputs (same input → same output).
 */
import { createHash } from 'node:crypto';
import type { AIProvider, AIRequest, AIResponse } from '../types.js';

const TOPICS = [
  'Should college students be allowed to work part-time?',
  'Is online education better than classroom education?',
  'Should AI-generated content require disclosure?',
  'Should internships be mandatory for graduation?',
  'Are group projects a fair way to assess students?',
  'Should campuses go completely paperless?',
  'Is social media more helpful or harmful for learning?',
  'Should coding be taught to every engineering branch?',
];

function seed(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0);
}

function words(s: string) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export class MockProvider implements AIProvider {
  readonly name = 'mock';

  async generate<T>(req: AIRequest<T>): Promise<AIResponse<T>> {
    const v = req.vars as Record<string, any>;
    const h = seed(req.promptKey + JSON.stringify(v));
    let out: unknown;
    switch (req.promptKey) {
      case 'task.generate_variant': {
        const avoid: string[] = v.avoid ?? [];
        const available = TOPICS.filter((t) => !avoid.includes(t));
        const topic = available[h % Math.max(1, available.length)] ?? TOPICS[h % TOPICS.length]!;
        out = {
          title: `${v.targetLevel} practice: ${topic}`,
          prompt: v.type === 'audio' ? `Speak for 2 minutes on: "${topic}". State your position, give two reasons and a conclusion.`
            : `Write a structured response (150-200 words) on: "${topic}".`,
          content: { question: topic, hints: v.path === 'remediation' ? ['Start with a one-sentence position', 'Use "firstly/secondly" to structure reasons'] : [] },
          expectedDurationMinutes: 10,
          difficultyProfile: v.targetProfile,
          conceptsAssessed: (v.skills as { name: string }[]).map((s) => s.name),
        };
        break;
      }
      case 'evaluation.rubric': {
        const text = String(v.submission ?? '');
        const n = words(text);
        const coverage = Math.min(1, n / 120);
        const structure = /first|second|finally|because|therefore|in conclusion/i.test(text) ? 1 : 0.5;
        const criteria = (v.rubric as { name: string; maxPoints: number }[]).map((c, i) => {
          const f = i % 2 === 0 ? coverage : (coverage + structure) / 2;
          return { name: c.name, score: Math.round(c.maxPoints * f * 10) / 10, maxScore: c.maxPoints,
            evidence: text.slice(0, 80) || '(empty submission)', feedback: f > 0.7 ? 'Meets the criterion.' : 'Develop this further with specific examples.' };
        });
        out = {
          criteria, overallFeedback: n === 0 ? 'No response was submitted.' : 'Clear attempt. See criterion feedback for next steps.',
          strengths: n > 60 ? ['Adequate length and coverage'] : [], improvements: structure < 1 ? ['Use explicit structure (reasons, conclusion)'] : [],
          conceptsMissed: structure < 1 ? ['structured argument'] : [], confidence: n === 0 ? 0.3 : 0.8, flagForHumanReview: n === 0,
        };
        break;
      }
      case 'mentor.chat': {
        const ctx = v.context ?? {};
        const pending = (ctx.pendingTasks ?? []) as { id: string; title: string }[];
        const gap = (ctx.gaps ?? [])[0] as { skill: string; proficiency: number } | undefined;
        const actions = [] as unknown[];
        if (pending[0]) actions.push({ kind: 'start_task', title: pending[0].title, reason: 'It is due soonest among your tasks today.', refId: pending[0].id });
        if (gap) actions.push({ kind: 'practice', title: `Practice ${gap.skill}`, reason: `${gap.skill} is currently your lowest measured skill (${gap.proficiency}/100).` });
        if (actions.length === 0) actions.push({ kind: 'reflect', title: 'Write a short reflection on this week', reason: 'Reflection helps consolidate what you practised.' });
        out = { reply: gap ? `Today, focus on ${gap.skill}. Start with your pending task, then do one extra practice round.` : 'You are on track. Keep up your daily tasks.', actions };
        break;
      }
      case 'teacher.generate_tasks': {
        const count = Number(v.count ?? 3);
        out = {
          tasks: Array.from({ length: count }, (_, i) => ({
            title: `${v.level} ${v.type} activity ${i + 1}`,
            objective: String(v.request).slice(0, 200),
            type: v.type, instructions: 'Complete the activity and submit your answer.', difficultyLevel: v.level, estimatedMinutes: 15,
            content: v.type === 'mcq' ? { question: `Sample question ${i + 1}?`, options: ['A', 'B', 'C', 'D'], answerIndex: (h + i) % 4 } : {},
            rubric: [
              { name: 'Correctness', description: 'Accuracy of the answer', maxPoints: 50 },
              { name: 'Reasoning', description: 'Clarity of reasoning', maxPoints: 30 },
              { name: 'Communication', description: 'Clarity of expression', maxPoints: 20 },
            ],
          })),
        };
        break;
      }
      case 'interview.next_turn': {
        const turns = ((v.history ?? []) as unknown[]).filter((m: any) => m.role === 'assistant').length;
        const qs = ['Tell me about yourself.', 'Describe a project you are proud of.', 'What was the hardest bug you fixed?',
          'How do you handle disagreements in a team?', 'Where do you want to be in three years?', 'Do you have any questions for us?'];
        out = { question: qs[Math.min(turns, qs.length - 1)], followUpReason: turns === 0 ? 'Opening question' : 'Builds on your previous answer', done: turns >= qs.length - 1 };
        break;
      }
      case 'content.transform': {
        const sentences = String(v.source).split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 5);
        out = { title: `Generated ${v.mode}`, summary: sentences.slice(0, 2).join(' '), items: sentences.map((s) => ({ kind: v.mode === 'quiz' ? 'question' : 'point', text: s })) };
        break;
      }
      default:
        throw new Error(`mock provider has no generator for ${req.promptKey}`);
    }
    const output = req.schema.parse(out);
    return { output, model: `mock:${req.model}`, inputTokens: Math.ceil((req.system.length + JSON.stringify(req.messages).length) / 4), outputTokens: Math.ceil(JSON.stringify(out).length / 4) };
  }
}
