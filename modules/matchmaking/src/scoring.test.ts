import { describe, expect, it } from "vitest";
import {
  answerSchema,
  autoAnswer,
  directionalScore,
  expectedPosition,
  pairScore,
  questionSchema,
  topMatches,
  type Answer,
  type Question,
} from "./scoring";

/** Build a full Answer with explicit defaults so tests read unambiguously. */
function answer(questionId: string, position: number, care: number, overrides?: Partial<Answer>): Answer {
  return {
    questionId,
    position,
    care,
    dealbreaker: false,
    auto: false,
    shareWithMatch: false,
    ...overrides,
  };
}

function question(id: string, scaleLabels: string[], adminLocks?: Question["adminLocks"]): Question {
  return { id, text: `Question ${id}`, scaleLabels, adminLocks };
}

function questionMap(...qs: Question[]): Map<string, Question> {
  return new Map(qs.map((q) => [q.id, q]));
}

describe("schemas", () => {
  it("answerSchema applies defaults for dealbreaker/auto/shareWithMatch", () => {
    const parsed = answerSchema.parse({ questionId: "q1", position: 1, care: 5 });
    expect(parsed.dealbreaker).toBe(false);
    expect(parsed.auto).toBe(false);
    expect(parsed.shareWithMatch).toBe(false);
  });

  it("answerSchema rejects care outside −10..+10 and non-integers", () => {
    expect(answerSchema.safeParse({ questionId: "q1", position: 0, care: 11 }).success).toBe(false);
    expect(answerSchema.safeParse({ questionId: "q1", position: 0, care: -11 }).success).toBe(false);
    expect(answerSchema.safeParse({ questionId: "q1", position: 0, care: 2.5 }).success).toBe(false);
  });

  it("questionSchema requires 2..5 scale labels", () => {
    expect(questionSchema.safeParse(question("q1", ["only one"])).success).toBe(false);
    expect(questionSchema.safeParse(question("q1", ["a", "b"])).success).toBe(true);
    expect(questionSchema.safeParse(question("q1", ["a", "b", "c", "d", "e"])).success).toBe(true);
    expect(questionSchema.safeParse(question("q1", ["a", "b", "c", "d", "e", "f"])).success).toBe(false);
  });
});

describe("expectedPosition", () => {
  it("care > 0 wants the SAME position for every scale size 2..5", () => {
    for (let scaleSize = 2; scaleSize <= 5; scaleSize++) {
      for (let position = 0; position < scaleSize; position++) {
        expect(expectedPosition(position, 10, scaleSize)).toBe(position);
        expect(expectedPosition(position, 1, scaleSize)).toBe(position);
      }
    }
  });

  it("care < 0 wants the MIRRORED position for every scale size 2..5", () => {
    for (let scaleSize = 2; scaleSize <= 5; scaleSize++) {
      for (let position = 0; position < scaleSize; position++) {
        expect(expectedPosition(position, -10, scaleSize)).toBe(scaleSize - 1 - position);
        expect(expectedPosition(position, -1, scaleSize)).toBe(scaleSize - 1 - position);
      }
    }
  });

  it("mirroring is self-inverse and fixes the middle of odd scales", () => {
    expect(expectedPosition(expectedPosition(3, -10, 5), -10, 5)).toBe(3);
    expect(expectedPosition(1, -10, 3)).toBe(1); // middle of 3-scale mirrors to itself
    expect(expectedPosition(2, -10, 5)).toBe(2); // middle of 5-scale mirrors to itself
  });
});

describe("gender mechanic (spec: locked care −10 + dealbreaker on a 2-option question)", () => {
  const gender = question("gender", ["Male", "Female"], { care: -10, dealbreaker: true });
  const questions = questionMap(gender);
  // Locked values materialize as ordinary answer fields.
  const male = [answer("gender", 0, -10, { dealbreaker: true })];
  const maleToo = [answer("gender", 0, -10, { dealbreaker: true })];
  const female = [answer("gender", 1, -10, { dealbreaker: true })];

  it("male + male pair is excluded", () => {
    const result = pairScore(male, maleToo, questions);
    expect(result.excluded).toBe(true);
    expect(result.percent).toBe(0);
  });

  it("male + female pair is NOT excluded and scores perfectly on this question", () => {
    const result = pairScore(male, female, questions);
    expect(result.excluded).toBe(false);
    expect(result.percent).toBe(100);
  });

  it("directional view: the dealbreaker fails immediately for same-position pairs", () => {
    expect(directionalScore(male, maleToo, questions)).toEqual({
      weightedCloseness: 0,
      weight: 0,
      dealbreakerFailed: true,
    });
    expect(directionalScore(male, female, questions).dealbreakerFailed).toBe(false);
  });
});

describe("care = 0 / auto-answers", () => {
  const q = question("exercise", ["Never", "Sometimes", "Monthly", "Weekly", "Daily"]);
  const questions = questionMap(q);

  it("autoAnswer produces middle position, care 0, auto flag, no dealbreaker, no sharing", () => {
    expect(autoAnswer(q)).toEqual({
      questionId: "exercise",
      position: 2, // floor((5−1)/2)
      care: 0,
      dealbreaker: false,
      auto: true,
      shareWithMatch: false,
    });
    expect(autoAnswer(question("g", ["Male", "Female"])).position).toBe(0); // floor((2−1)/2)
    expect(autoAnswer(question("t", ["a", "b", "c", "d"])).position).toBe(1); // floor((4−1)/2)
  });

  it("care 0 contributes zero weight in the auto-answerer's direction", () => {
    const autoSide = [autoAnswer(q)];
    const caringSide = [answer("exercise", 4, 8)];
    expect(directionalScore(autoSide, caringSide, questions)).toEqual({
      weightedCloseness: 0,
      weight: 0,
      dealbreakerFailed: false,
    });
  });

  it("the auto-answerer's position still scores in the OTHER direction", () => {
    const autoSide = [autoAnswer(q)]; // position 2, care 0
    const caringSide = [answer("exercise", 4, 8)]; // wants same as 4
    const result = directionalScore(caringSide, autoSide, questions);
    // closeness = 1 − |2 − 4| / 4 = 0.5; weight 8
    expect(result.weightedCloseness / result.weight).toBeCloseTo(0.5);
    expect(result.dealbreakerFailed).toBe(false);
    // Pooled percent: only the caring direction carries weight.
    expect(pairScore(autoSide, caringSide, questions)).toEqual({ percent: 50, excluded: false });
  });

  it("a dealbreaker flag with care 0 is inert (no exclusion, no weight)", () => {
    const oddball = [answer("exercise", 0, 0, { dealbreaker: true })];
    const other = [answer("exercise", 4, 0)];
    expect(directionalScore(oddball, other, questions)).toEqual({
      weightedCloseness: 0,
      weight: 0,
      dealbreakerFailed: false,
    });
    expect(pairScore(oddball, other, questions)).toEqual({ percent: 0, excluded: false });
  });

  it("two all-auto users score 0 ('no signal yet') — never null (founder decision 2026-07-07)", () => {
    expect(pairScore([autoAnswer(q)], [autoAnswer(q)], questions)).toEqual({
      percent: 0,
      excluded: false,
    });
  });
});

describe("perfect and worst matches", () => {
  const q = question("q1", ["1", "2", "3", "4", "5"]);
  const questions = questionMap(q);

  it("perfect same-preference match scores 100", () => {
    const a = [answer("q1", 2, 10)];
    const b = [answer("q1", 2, 10)];
    expect(pairScore(a, b, questions)).toEqual({ percent: 100, excluded: false });
  });

  it("perfect opposite-preference match (care −10, mirrored positions) scores 100", () => {
    const a = [answer("q1", 0, -10)]; // expects 4
    const b = [answer("q1", 4, -10)]; // expects 0
    expect(pairScore(a, b, questions)).toEqual({ percent: 100, excluded: false });
  });

  it("maximal mismatch scores 0", () => {
    const a = [answer("q1", 0, 10)]; // expects 0, they're at 4
    const b = [answer("q1", 4, 10)]; // expects 4, they're at 0
    expect(pairScore(a, b, questions)).toEqual({ percent: 0, excluded: false });
  });

  it("weights by |care|: strongly-cared questions dominate the blend", () => {
    const q2 = question("q2", ["1", "2", "3", "4", "5"]);
    const qs = questionMap(q, q2);
    const a = [
      answer("q1", 0, 10), // perfect hit below (weight 10, closeness 1)
      answer("q2", 0, 1), // total miss below (weight 1, closeness 0)
    ];
    const b = [answer("q1", 0, 0), answer("q2", 4, 0)];
    const result = directionalScore(a, b, qs);
    expect(result.weightedCloseness / result.weight).toBeCloseTo(10 / 11);
  });
});

describe("asymmetric overlap", () => {
  const q1 = question("q1", ["a", "b", "c"]);
  const q2 = question("q2", ["a", "b", "c"]);
  const q3 = question("q3", ["a", "b", "c"]);
  const questions = questionMap(q1, q2, q3);

  it("only questions BOTH answered are scored", () => {
    const a = [
      answer("q1", 0, 10), // shared — B matches exactly
      answer("q2", 2, 10), // B never answered: must not drag the score down
      answer("q3", 2, 10), // B never answered
    ];
    const b = [answer("q1", 0, 5)];
    const aToB = directionalScore(a, b, questions);
    const bToA = directionalScore(b, a, questions);
    expect(aToB.weightedCloseness / aToB.weight).toBe(1);
    expect(bToA.weightedCloseness / bToA.weight).toBe(1);
    expect(pairScore(a, b, questions)).toEqual({ percent: 100, excluded: false });
  });

  it("an unanswered dealbreaker question cannot fail (no answer from them yet)", () => {
    const a = [answer("q2", 2, 10, { dealbreaker: true })];
    const b = [answer("q1", 0, 5)];
    expect(directionalScore(a, b, questions)).toEqual({
      weightedCloseness: 0,
      weight: 0,
      dealbreakerFailed: false,
    });
    // b→a still has no overlap either (a never answered q1) — zero pooled weight → 0%.
    expect(pairScore(a, b, questions)).toEqual({ percent: 0, excluded: false });
  });
});

describe("dealbreaker in one direction excludes the pair both ways", () => {
  const q = question("smoking", ["Never", "Sometimes", "Always"]);
  const questions = questionMap(q);
  // A demands a non-smoker (same as their own 0) as a dealbreaker; B smokes but is easygoing.
  const a = [answer("smoking", 0, 10, { dealbreaker: true })];
  const b = [answer("smoking", 2, 1)];

  it("A→B fails, B→A would score fine, pair excluded regardless of argument order", () => {
    expect(directionalScore(a, b, questions).dealbreakerFailed).toBe(true);
    expect(directionalScore(b, a, questions).dealbreakerFailed).toBe(false);
    expect(pairScore(a, b, questions)).toEqual({ percent: 0, excluded: true });
    expect(pairScore(b, a, questions)).toEqual({ percent: 0, excluded: true });
  });

  it("a dealbreaker that is satisfied does not exclude and still carries weight", () => {
    const nonSmoker = [answer("smoking", 0, 2)];
    expect(pairScore(a, nonSmoker, questions)).toEqual({ percent: 100, excluded: false });
  });
});

describe("topMatches", () => {
  const scores = [
    { a: "me", b: "u1", percent: 82, excluded: false },
    { a: "u2", b: "me", percent: 97, excluded: false }, // me on the b side
    { a: "me", b: "u3", percent: 97, excluded: true }, // excluded: filtered out
    { a: "me", b: "u4", percent: 0, excluded: false }, // 0% = "no signal yet": still listed, last
    { a: "me", b: "u5", percent: 40, excluded: false },
    { a: "u6", b: "u7", percent: 99, excluded: false }, // not my pair
  ];

  it("returns my matches sorted by percent descending, from either side of the pair", () => {
    expect(topMatches("me", scores, 10)).toEqual([
      { otherId: "u2", percent: 97 },
      { otherId: "u1", percent: 82 },
      { otherId: "u5", percent: 40 },
      { otherId: "u4", percent: 0 },
    ]);
  });

  it("applies the limit after sorting", () => {
    expect(topMatches("me", scores, 2)).toEqual([
      { otherId: "u2", percent: 97 },
      { otherId: "u1", percent: 82 },
    ]);
  });

  it("filters excluded pairs; zero-percent pairs remain listed", () => {
    const ids = topMatches("me", scores, 10).map((m) => m.otherId);
    expect(ids).not.toContain("u3");
    expect(ids).toContain("u4");
  });

  it("returns empty for a user with no pairs", () => {
    expect(topMatches("stranger", scores, 5)).toEqual([]);
  });
});
