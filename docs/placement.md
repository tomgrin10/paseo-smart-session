# Placing sessions on accounts

How Smart Session would place Claude sessions across several accounts, why, and how the rule was
tested before anything uses it. The code is `shared/placement.ts`; `placement.test.ts` holds each
rule to a small fictional scenario.

## The problem

Each account has two budgets. The **weekly** window resets at a fixed time, and whatever is unused
then is lost. The **5-hour** window opens on first use and resets 5 hours later. A session draws
from both on the account it runs on, and stays there until something moves it. A move costs one
prompt-cache miss: the whole context is read again at the full input price.

The goal, in order: **no waiting**, then **no Extra usage**, then **as few moves as possible**.

Units: one *point* is 1% of one standard account's weekly window. A 5-hour window holds
`100 × size ÷ ratio` points, where `ratio` is the account's 5-hour percent per weekly point.

## The rule

1. **Spend what expires first.** Rank accounts by the pace score: weekly points left ÷ hours to the
   weekly reset. This is today's score.
2. **Never into an imminent 5-hour wall.** An account whose 5-hour window would fill within the hour
   (`WALL_HOURS`), at its last half hour's burn plus one more session, goes behind the ones that
   wouldn't. The check is `forecastWindow`'s (`shared/forecast.ts`), the same rule every meter uses.
   When no account passes, the pace score still decides.
3. **New sessions** go to the first account in that order.
4. **Moves.** A session on an account whose wall comes within the hour moves now, smallest context
   first, when the gain beats the cost. Otherwise today's rebalance: move one session when the best
   account's pace score is at least 1.5× its own. Today's guards stay: idle sessions only, at a turn
   boundary, never one with background jobs, at most one move per 10 minutes, 6 hours between moves
   of one session, and a manual pin always wins.
5. **Extra usage only when every account is out.** The rule never offers an account at its limit.

## Why expiring-first (the exchange argument)

Take the weekly windows alone and a schedule that, at some moment, serves work from account B while
account A, whose budget expires earlier, still has room that later expires unused (or is spent on
work that B could have taken). Swap one unit: serve it from A now, and give B the unit A would have
spent later. A's unit was going to expire or be spent anyway; B's saved unit is still valid at that
later time because B expires later. Nothing got worse, and if A's unit was going to expire, one unit
of work no longer waits. Repeat until no such pair is left. So spending the earliest deadline first
is never worse.

Strictly that is earliest-deadline-first (EDF). The pace score (room ÷ hours) is a hedge: when demand
is steady it spends each account by its own reset, almost as EDF does, but when demand stops (nights,
weekends) it hasn't poured everything into the earliest account and left the later ones untouched.
In the benchmark below, pure EDF was clearly worse than pace.

## Why the 5-hour window breaks pure greed

A greedy rule fills the best account until it can't take more. On the weekly window that is the
exchange argument at work. On the 5-hour window it isn't: the best weekly account fills its 5-hour
window in a burst, every session on it is cut off at once, moved (one cache miss each), and the
account then sits out the rest of its window while its weekly budget keeps draining toward expiry.
So the short window needs its own check. But only a near one: a wall costs one move, while weekly
budget that expires is lost for good, so demoting an account for a wall hours away (the strict
version, "any wall before the window resets") kept work off the account whose week was running out,
and lost far more than it saved.

## The cost of a move, and the gain

Cost: `context tokens ÷ 1000 × MISS_POINTS_PER_KTOK` points. The figure is rough on purpose: a 100k
context costs about 0.05 points (1% of a week is about $10 of API-priced work, and a 100k miss about
$0.55).

Gain ahead of a wall: the wall would move the session anyway, with its turn cut off for Session
Guard's 2-minute grace and the same cache miss. Moving it now saves the cut-off and that later miss,
so total moves stay the same (a forced move becomes a chosen one) and fewer turns are cut off.

## How it was tested

The Accounts report's replay (`replay` in `shared/accounts-report.ts`) is **fluid**: each step's work
can split across accounts and move for free. That's fine for comparing account counts, but it can't
see a cache miss or a cut-off turn. So `replaySessions` replays the same demand as **sessions that
stay put**: each step's demand is so many sessions; new ones are placed by the rule, ended ones are
the newest, a session that its account can't serve is cut off and moved (a forced move), and the
move rule may move one session between steps under the guards above.

Both replays scored today's rule (`pace-5h-gate` with the 1.5× rebalance) against the new one and
its variants on 300 random fictional scenarios (`node --experimental-strip-types placement-bench.ts 7` and `99`) (two seeds of 150: two or three accounts, random reset
times, 5-hour ratios and bursty daily demand), and on the real logs of the machine it was built on
(numbers kept out of the repository).

| Part | Earns its keep? |
| --- | --- |
| 5-hour check, wall within the hour | Yes. A small gain in waiting on the fluid replay, and fewer forced moves. |
| Moving ahead of an imminent wall | Yes. The least waiting in the session replay, a third fewer cut-off turns, the same or fewer total moves. |
| 5-hour check against any wall before the reset | No. It kept work off expiring weekly budget; much more waiting in some scenarios. |
| Look-ahead (the pool forecast run forward; switch to EDF when budget expires while work later waits) | No. It rarely fires and wins nothing on average (on the real logs it never fired): the pace score already spends what expires first whenever the pool is tight. Kept as the scored variant `expiring-first:look-ahead`. |
| Pure EDF instead of the pace score | No. More waiting on the fluid replay in most scenarios. |
| Weekly moves by forecast gain instead of the 1.5× rebalance | No better than the rebalance, and more moves, so the rebalance stays. |

The gains are small: about 1% less waiting on average in the benchmark, and most of the
difference is fewer turns cut off at a 5-hour wall. Waiting is mostly set by how much work there
is against how many accounts, which no placement rule changes.

The report scores any rule in `POLICIES` on the same demand; `expiring-first` is the shipped one.

## Not yet

Nothing here places a real session. Running the rule beside ZeroSub (shadow mode: log what it
would do), and then through ZeroSub's own levers (create metadata, pins, `move_before_limit`), is
the next step, never a default flip or a reconcile.
