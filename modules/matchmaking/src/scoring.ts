import { z } from "zod";

/**
 * Module 1 (Make-a-Match) pure scoring logic.
 * Spec: docs/modules/module-1-matchmaking.md — care slider is −10..+10
 * (sign = same/opposite, magnitude = how much you care, 0 = don't care);
 * dealbreaker is a hard filter in either direction.
 */

/** Admin can lock any combination of {answer, care, dealbreaker} on a question. */
export const adminLocksSchema = z.object({
  /** Locked answer position (0-indexed into scaleLabels). */
  answer: z.number().int().min(0).optional(),
  /** Locked care value, −10..+10. */
  care: z.number().int().min(-10).max(10).optional(),
  /** Locked dealbreaker flag. */
  dealbreaker: z.boolean().optional(),
});

export const questionSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** 2..5 labeled scale points, e.g. ["Never", "Sometimes", "Daily"]. */
  scaleLabels: z.array(z.string()).min(2).max(5),
  adminLocks: adminLocksSchema.optional(),
});

export type Question = z.infer<typeof questionSchema>;

export const answerSchema = z.object({
  questionId: z.string(),
  /** The user's own position on the scale, 0-indexed into scaleLabels. */
  position: z.number().int().min(0),
  /** −10 (want opposite of me) .. 0 (don't care) .. +10 (want same as me). */
  care: z.number().int().min(-10).max(10),
  /** Hard filter: a match must sit exactly at my expected position. */
  dealbreaker: z.boolean().default(false),
  /** True for system-generated vanilla answers the user hasn't touched. */
  auto: z.boolean().default(false),
  /** Whether a potential match may see this answer pre-introduction. */
  shareWithMatch: z.boolean().default(false),
});

export type Answer = z.infer<typeof answerSchema>;

/**
 * Where I want a match to sit on the scale, given my own position and care sign.
 * care > 0 → same position as me; care < 0 → mirrored position.
 * care = 0 → irrelevant (callers skip care-0 answers); returns my own position.
 */
export function expectedPosition(myPosition: number, care: number, scaleSize: number): number {
  if (care < 0) {
    return scaleSize - 1 - myPosition;
  }
  return myPosition;
}

/**
 * Score in one direction: how well "their" answers satisfy "my" preferences.
 * Only questions both sides answered participate. care = 0 answers on my side
 * contribute nothing (so auto-answers demand nothing of others, per spec).
 * Returns score in 0..1, or null when there is no cared-about overlap.
 * dealbreakerFailed short-circuits: their position missed one of my dealbreakers.
 */
export function directionalScore(
  myAnswers: Answer[],
  theirAnswers: Answer[],
  questions: Map<string, Question>
): { score: number | null; dealbreakerFailed: boolean } {
  const theirsByQuestion = new Map<string, Answer>();
  for (const answer of theirAnswers) {
    theirsByQuestion.set(answer.questionId, answer);
  }

  let weightSum = 0;
  let weightedCloseness = 0;

  for (const mine of myAnswers) {
    const theirs = theirsByQuestion.get(mine.questionId);
    if (!theirs) continue; // they haven't answered this question

    const question = questions.get(mine.questionId);
    if (!question) continue; // unknown question — skip defensively

    if (mine.care === 0) continue; // don't care: contributes nothing (dealbreaker inert too, see SPEC.md)

    const scaleSize = question.scaleLabels.length;
    const expected = expectedPosition(mine.position, mine.care, scaleSize);

    if (mine.dealbreaker && theirs.position !== expected) {
      return { score: null, dealbreakerFailed: true };
    }

    const weight = Math.abs(mine.care);
    const closeness = 1 - Math.abs(theirs.position - expected) / (scaleSize - 1);
    weightedCloseness += weight * closeness;
    weightSum += weight;
  }

  if (weightSum === 0) {
    return { score: null, dealbreakerFailed: false };
  }
  return { score: weightedCloseness / weightSum, dealbreakerFailed: false };
}

/**
 * Combine the two directional scores into the pair's match percentage.
 * A failed dealbreaker in either direction excludes the pair entirely.
 * A null direction (no cared-about overlap) is simply absent from the average;
 * if both directions are null, percent is null.
 */
export function pairScore(
  aAnswers: Answer[],
  bAnswers: Answer[],
  questions: Map<string, Question>
): { percent: number | null; excluded: boolean } {
  const aToB = directionalScore(aAnswers, bAnswers, questions);
  const bToA = directionalScore(bAnswers, aAnswers, questions);

  if (aToB.dealbreakerFailed || bToA.dealbreakerFailed) {
    return { percent: null, excluded: true };
  }

  const present: number[] = [];
  if (aToB.score !== null) present.push(aToB.score);
  if (bToA.score !== null) present.push(bToA.score);

  if (present.length === 0) {
    return { percent: null, excluded: false };
  }

  const average = present.reduce((sum, s) => sum + s, 0) / present.length;
  return { percent: Math.round(100 * average), excluded: false };
}

/**
 * The vanilla answer every user gets for a question they haven't touched:
 * middle-of-scale position, care 0 (demands nothing of others), marked auto.
 * Admin locks are NOT applied here — see SPEC.md.
 */
export function autoAnswer(question: Question): Answer {
  return {
    questionId: question.id,
    position: Math.floor((question.scaleLabels.length - 1) / 2),
    care: 0,
    dealbreaker: false,
    auto: true,
    shareWithMatch: false,
  };
}

/**
 * A user's top matches from a precomputed pair-score list, highest percent
 * first, capped at `limit`. Excluded pairs and null percents are filtered out.
 */
export function topMatches(
  userId: string,
  allScores: { a: string; b: string; percent: number | null; excluded: boolean }[],
  limit: number
): { otherId: string; percent: number }[] {
  const mine: { otherId: string; percent: number }[] = [];

  for (const score of allScores) {
    if (score.excluded || score.percent === null) continue;
    if (score.a === userId) {
      mine.push({ otherId: score.b, percent: score.percent });
    } else if (score.b === userId) {
      mine.push({ otherId: score.a, percent: score.percent });
    }
  }

  mine.sort((x, y) => y.percent - x.percent);
  return mine.slice(0, limit);
}
