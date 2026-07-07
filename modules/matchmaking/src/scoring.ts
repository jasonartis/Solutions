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
 * One direction's raw terms: how well "their" answers satisfy "my" preferences.
 * Only questions both sides answered participate. care = 0 answers on my side
 * carry weight 0 and therefore contribute nothing (founder decision 2026-07-07:
 * "care zero mathematically becomes zero since it is a weight of zero" — so
 * auto-answers demand nothing of others).
 * dealbreakerFailed short-circuits: their position missed one of my dealbreakers.
 */
export function directionalScore(
  myAnswers: Answer[],
  theirAnswers: Answer[],
  questions: Map<string, Question>
): { weightedCloseness: number; weight: number; dealbreakerFailed: boolean } {
  const theirsByQuestion = new Map<string, Answer>();
  for (const answer of theirAnswers) {
    theirsByQuestion.set(answer.questionId, answer);
  }

  let weight = 0;
  let weightedCloseness = 0;

  for (const mine of myAnswers) {
    const theirs = theirsByQuestion.get(mine.questionId);
    if (!theirs) continue; // they haven't answered this question

    const question = questions.get(mine.questionId);
    if (!question) continue; // unknown question — skip defensively

    if (mine.care === 0) continue; // weight 0: contributes nothing (dealbreaker inert too, see SPEC.md)

    const scaleSize = question.scaleLabels.length;
    const expected = expectedPosition(mine.position, mine.care, scaleSize);

    if (mine.dealbreaker && theirs.position !== expected) {
      return { weightedCloseness: 0, weight: 0, dealbreakerFailed: true };
    }

    const w = Math.abs(mine.care);
    const closeness = 1 - Math.abs(theirs.position - expected) / (scaleSize - 1);
    weightedCloseness += w * closeness;
    weight += w;
  }

  return { weightedCloseness, weight, dealbreakerFailed: false };
}

/**
 * The pair's match percentage: ALL cared-about terms from BOTH directions are
 * pooled into one weighted average (founder decisions 2026-07-07: two
 * measurements per answer — position and care-about-their-answer; care-0 terms
 * are weight zero; there are NO nulls, because every user holds a numeric
 * default answer on every question). Zero pooled weight (two brand-new users)
 * scores 0 — "no signal yet", not undefined.
 * A failed dealbreaker in either direction excludes the pair entirely.
 */
export function pairScore(
  aAnswers: Answer[],
  bAnswers: Answer[],
  questions: Map<string, Question>
): { percent: number; excluded: boolean } {
  const aToB = directionalScore(aAnswers, bAnswers, questions);
  const bToA = directionalScore(bAnswers, aAnswers, questions);

  if (aToB.dealbreakerFailed || bToA.dealbreakerFailed) {
    return { percent: 0, excluded: true };
  }

  const totalWeight = aToB.weight + bToA.weight;
  if (totalWeight === 0) {
    return { percent: 0, excluded: false };
  }

  const pooled = (aToB.weightedCloseness + bToA.weightedCloseness) / totalWeight;
  return { percent: Math.round(100 * pooled), excluded: false };
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
 * first, capped at `limit`. Excluded pairs are filtered out.
 */
export function topMatches(
  userId: string,
  allScores: { a: string; b: string; percent: number; excluded: boolean }[],
  limit: number
): { otherId: string; percent: number }[] {
  const mine: { otherId: string; percent: number }[] = [];

  for (const score of allScores) {
    if (score.excluded) continue;
    if (score.a === userId) {
      mine.push({ otherId: score.b, percent: score.percent });
    } else if (score.b === userId) {
      mine.push({ otherId: score.a, percent: score.percent });
    }
  }

  mine.sort((x, y) => y.percent - x.percent);
  return mine.slice(0, limit);
}
