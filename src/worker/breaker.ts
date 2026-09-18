/** Consecutive-failure circuit breaker for the decision backend. Pure apart from the injected clock. */
export class Breaker {
  #failures = 0;
  #openUntil = 0;
  #opened = 0;
  /** Set when the breaker has opened and no call has succeeded since: the next failure reopens it at once. */
  #probation = false;

  constructor(
    private readonly threshold = 3,
    private readonly openMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when a call may be made. After the open period one trial call is allowed (half-open). */
  get closed(): boolean {
    return this.now() >= this.#openUntil;
  }
  /** How many times the breaker has opened (for the log and `reflex doctor`). */
  get timesOpened(): number {
    return this.#opened;
  }

  success(): void {
    this.#failures = 0;
    this.#probation = false;
  }

  failure(): void {
    if (++this.#failures >= this.threshold || this.#probation) {
      this.#probation = true;
      this.#openUntil = this.now() + this.openMs;
      this.#failures = 0;
      this.#opened++;
    }
  }
}
