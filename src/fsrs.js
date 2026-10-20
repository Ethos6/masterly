// @ts-check
/**
 * FSRS-6 spaced-repetition scheduler.
 *
 * Implements the published Free Spaced Repetition Scheduler model: each card has a
 * stability S (days until recall probability falls to 90%) and a difficulty D (1..10).
 * After every review, S and D are updated from the rating and from how likely recall
 * was at that moment; the next review is placed where recall probability reaches the
 * requested retention. Default parameters are the FSRS-6 defaults trained on
 * hundreds of millions of reviews.
 *
 * Ratings: 1 Again (forgot), 2 Hard, 3 Good, 4 Easy.
 */

export const DEFAULT_W = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729,
  0.5425, 0.0912, 0.0658, 0.1542,
]);

export const Rating = Object.freeze({ Again: 1, Hard: 2, Good: 3, Easy: 4 });
const DAY = 86_400_000;
const S_MIN = 0.001;
const S_MAX = 36_500;

/**
 * @typedef {object} Card
 * @property {"new"|"review"} state
 * @property {number} stability    days
 * @property {number} difficulty   1..10
 * @property {number} reps
 * @property {number} lapses
 * @property {number|null} last    epoch ms of the last review
 * @property {number} due          epoch ms
 */

/** @returns {Card} */
export function newCard(now = Date.now()) {
  return { state: "new", stability: 0, difficulty: 0, reps: 0, lapses: 0, last: null, due: now };
}

const clamp = (/** @type {number} */ x, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, x));

export class Scheduler {
  /**
   * @param {object} [opts]
   * @param {readonly number[]} [opts.w]
   * @param {number} [opts.retention]   requested recall probability at review time
   * @param {number} [opts.maxInterval] days
   */
  constructor(opts = {}) {
    this.w = opts.w || DEFAULT_W;
    if (this.w.length !== 21) throw new Error("FSRS-6 needs 21 parameters");
    this.retention = opts.retention ?? 0.9;
    if (!(this.retention > 0 && this.retention < 1)) throw new Error("retention must be between 0 and 1");
    this.maxInterval = opts.maxInterval ?? 36_500;
    this.decay = -this.w[20];
    this.factor = Math.pow(0.9, 1 / this.decay) - 1;
  }

  /** Probability of recall after `t` days with stability `s`. */
  retrievability(/** @type {number} */ t, /** @type {number} */ s) {
    if (s <= 0) return 0;
    return Math.pow(1 + (this.factor * Math.max(0, t)) / s, this.decay);
  }

  /** Days until recall probability falls to the requested retention. */
  interval(/** @type {number} */ s) {
    const raw = (s / this.factor) * (Math.pow(this.retention, 1 / this.decay) - 1);
    return clamp(Math.round(raw), 1, this.maxInterval);
  }

  initStability(/** @type {number} */ g) {
    return Math.max(this.w[g - 1], 0.1);
  }

  initDifficulty(/** @type {number} */ g) {
    return clamp(this.w[4] - Math.exp(this.w[5] * (g - 1)) + 1, 1, 10);
  }

  nextDifficulty(/** @type {number} */ d, /** @type {number} */ g) {
    const delta = -this.w[6] * (g - 3);
    const damped = d + (delta * (10 - d)) / 9; // linear damping: changes shrink near 10
    const target = this.w[4] - Math.exp(this.w[5] * 3) + 1; // D0(Easy), unclamped
    return clamp(this.w[7] * target + (1 - this.w[7]) * damped, 1, 10); // mean reversion
  }

  recallStability(/** @type {number} */ d, /** @type {number} */ s, /** @type {number} */ r, /** @type {number} */ g) {
    const hard = g === Rating.Hard ? this.w[15] : 1;
    const easy = g === Rating.Easy ? this.w[16] : 1;
    const inc = Math.exp(this.w[8]) * (11 - d) * Math.pow(s, -this.w[9]) * (Math.exp((1 - r) * this.w[10]) - 1) * hard * easy;
    return clamp(s * (1 + inc), S_MIN, S_MAX);
  }

  forgetStability(/** @type {number} */ d, /** @type {number} */ s, /** @type {number} */ r) {
    const f = this.w[11] * Math.pow(d, -this.w[12]) * (Math.pow(s + 1, this.w[13]) - 1) * Math.exp((1 - r) * this.w[14]);
    const ceiling = s / Math.exp(this.w[17] * this.w[18]);
    return clamp(Math.min(f, ceiling), S_MIN, S_MAX);
  }

  /** Same-day review: the short-term stability formula. */
  shortTermStability(/** @type {number} */ s, /** @type {number} */ g) {
    let inc = Math.exp(this.w[17] * (g - 3 + this.w[18])) * Math.pow(s, -this.w[19]);
    if (g >= Rating.Good) inc = Math.max(inc, 1);
    return clamp(s * inc, S_MIN, S_MAX);
  }

  /**
   * Apply one review and return the updated card (the input is not modified).
   * @param {Card} card
   * @param {1|2|3|4} rating
   * @param {number} [now] epoch ms
   * @returns {Card}
   */
  review(card, rating, now = Date.now()) {
    if (![1, 2, 3, 4].includes(rating)) throw new Error(`rating must be 1..4, got ${rating}`);
    const { s, d } = this.next(card, rating, now);
    let days = 0;
    if (rating !== Rating.Again) {
      // Keep the buttons in order: Hard < Good < Easy, so a better rating never
      // schedules a card sooner.
      const iv = (/** @type {number} */ g) => this.interval(this.next(card, /** @type {1|2|3|4} */ (g), now).s);
      const hardRaw = iv(2);
      const again = Math.min(iv(1), hardRaw);
      const hard = Math.max(hardRaw, again + 1);
      const good = Math.max(iv(3), hard + 1);
      days = rating === Rating.Hard ? hard : rating === Rating.Good ? good : Math.max(iv(4), good + 1);
    }
    // A forgotten card comes back in ten minutes; everything else on a day boundary.
    const due = rating === Rating.Again ? now + 10 * 60_000 : startOfDay(now) + days * DAY + (now - startOfDay(now));
    return {
      state: "review",
      stability: round(s),
      difficulty: round(d),
      reps: card.reps + 1,
      lapses: card.lapses + (rating === Rating.Again && card.state !== "new" ? 1 : 0),
      last: now,
      due,
    };
  }

  /**
   * Stability and difficulty after a rating, before scheduling.
   * @param {Card} card @param {1|2|3|4} rating @param {number} now
   */
  next(card, rating, now) {
    if (card.state === "new" || !card.last) return { s: this.initStability(rating), d: this.initDifficulty(rating) };
    const elapsed = Math.max(0, Math.floor((startOfDay(now) - startOfDay(card.last)) / DAY));
    const d = this.nextDifficulty(card.difficulty, rating);
    if (elapsed === 0) return { s: this.shortTermStability(card.stability, rating), d };
    const r = this.retrievability(elapsed, card.stability);
    return { s: rating === Rating.Again ? this.forgetStability(card.difficulty, card.stability, r) : this.recallStability(card.difficulty, card.stability, r, rating), d };
  }

  /** Recall probability for a card right now (0 for cards never reviewed). */
  recallNow(/** @type {Card} */ card, now = Date.now()) {
    if (card.state === "new" || !card.last) return 0;
    return this.retrievability((now - card.last) / DAY, card.stability);
  }

  /** What each rating would schedule, for showing "Good: 3 days" on the buttons. */
  preview(/** @type {Card} */ card, now = Date.now()) {
    /** @type {Record<number, number>} */
    const out = {};
    for (const g of [1, 2, 3, 4]) out[g] = this.review(card, /** @type {1|2|3|4} */ (g), now).due - now;
    return out;
  }
}

/** UTC day boundary, so intervals don't drift with the time of day. @param {number} t */
function startOfDay(t) {
  return Math.floor(t / DAY) * DAY;
}

/** @param {number} x */
function round(x) {
  return Math.round(x * 1e8) / 1e8;
}
