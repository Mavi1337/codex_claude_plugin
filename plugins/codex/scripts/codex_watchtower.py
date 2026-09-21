#!/usr/bin/env python3
"""One-command status for the Codex worker fleet — the coordinator's watch tower.

Why this exists: worker and review state lived only inside the adapter and its
on-disk state tree, so every incoming manager rediscovered it by listing
directories and dumping `worker list` (110 workers, each with kilobytes of
requirement blobs). That archaeology is what made onboarding expensive, and it
silently missed things a poll cannot see: a turn that failed while `lastOutput`
still shows a stale report, and a completed review nobody adjudicated.

Run it at the start of a session, after any handoff, and whenever you want to
know whether a worker is still thinking.

    python3 scripts/codex_watchtower.py                  # one-shot status
    python3 scripts/codex_watchtower.py --watch          # poll until something needs you
    python3 scripts/codex_watchtower.py --orchestration X --json

`--watch` is the watch tower proper. Run it in the BACKGROUND right after
dispatching a worker; it polls quietly and returns the moment a turn lands, a
turn fails, or a review completes. Backgrounding it means the harness re-invokes
you on exit, so you are told rather than having to remember to look.

Exit status is the point: 0 = nothing needs you, 1 = something does. So it is
safe to poll from a loop and act only on a non-zero exit.
"""
import argparse
import json
import os
import subprocess
import sys
import time

ADAPTER = ('/home/user01/Schreibtisch/agents/.worktrees/'
           'codex-worker-development/plugins/codex/scripts/codex-workers.mjs')
STATE = ('/home/user01/.claude/plugins/data/codex-openai-codex/worker-state/'
         'repo-b713db446ae0e164eeba/orchestrations')
DEFAULT_ORCH = 'stage3-plan-c'
DEFAULT_CWD = '/home/user01/Schreibtisch/gitea/bitcoin_psql-stage3c'


def adapter(args, cwd):
    """Call the adapter and return result, or None with the error printed."""
    try:
        out = subprocess.run(['node', ADAPTER] + args + ['--cwd', cwd, '--json'],
                             capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return None, 'adapter timed out'
    if out.returncode != 0:
        return None, (out.stderr or out.stdout).strip()[:200]
    try:
        return json.loads(out.stdout)['result'], None
    except (ValueError, KeyError) as exc:
        return None, 'unparseable adapter response: %s' % exc


def collect(orch, cwd):
    report = {'orchestration': orch, 'attention': [], 'coordinator': {},
              'workers': [], 'reviews': []}

    coord, err = adapter(['coordinator', 'status'], cwd)
    if err:
        report['attention'].append('coordinator unreachable: %s' % err)
        report['coordinator'] = {'status': 'UNREACHABLE'}
    else:
        report['coordinator'] = {
            'status': coord.get('status'),
            'activeTurns': coord.get('activeTurns'),
            'queuedTurns': coord.get('queuedTurns'),
            'workerCount': coord.get('workerCount'),
            'maxConcurrent': coord.get('maxConcurrent'),
            'active': [w.get('workerId') for w in coord.get('activeWorkers') or []],
        }
        if coord.get('status') != 'online':
            report['attention'].append(
                'coordinator is %s — `coordinator restart` before sending'
                % coord.get('status'))

    workers, err = adapter(['worker', 'list'], cwd)
    if err:
        report['attention'].append('worker list failed: %s' % err)
        workers = []
    for w in workers or []:
        if w.get('orchestrationId') != orch:
            continue
        # Two filters, both load-bearing. Without them this reported 44 items,
        # of which one was real -- and an alert list that is 98% noise is worse
        # than no alert list.
        #   supervisorStatus 'closed' == a retired worker from an older batch.
        #   Its turn has been 'completed' for days and nobody needs to read it
        #   again. Only a live supervisor can have work outstanding.
        #   reviewer workers are the review machinery's own sub-workers; they
        #   produce no diff for a coordinator to read. Reviews are tracked
        #   below, by report, not by their internal worker.
        if w.get('supervisorStatus') != 'online':
            continue
        # 'sol' is recognized only when reading pre-migration persisted state.
        if w.get('role') in ('reviewer', 'sol'):
            continue
        turn = w.get('turn') or {}
        row = {
            'id': w.get('id'),
            'supervisor': w.get('supervisorStatus'),
            'thread': (w.get('thread') or {}).get('status'),
            'turn': turn.get('status'),
            # The documented trap: a reaped supervisor reports the turn failed
            # while lastOutput still shows a stale, complete-looking report.
            'turnError': turn.get('error') or w.get('turnError'),
            'base': (w.get('baseCommit') or '')[:7],
        }
        report['workers'].append(row)
        if row['turnError']:
            report['attention'].append(
                '%s: turn error %r — check turn.error, NOT lastOutput; '
                '`worker resume --worker %s` then re-send'
                % (row['id'], str(row['turnError'])[:80], row['id']))
        elif row['turn'] == 'completed':
            report['attention'].append(
                '%s: turn completed, worker still open — if its batch is '
                'committed and adjudicated, retire it with `worker close '
                '--worker %s`; otherwise read its diff in the worker worktree '
                '(the branch itself has no commits)' % (row['id'], row['id']))

    rdir = os.path.join(STATE, orch, 'reviews')
    names = sorted(os.listdir(rdir), key=lambda n: os.path.getmtime(
        os.path.join(rdir, n))) if os.path.isdir(rdir) else []
    for name in names:
        path = os.path.join(rdir, name, 'report.json')
        if not os.path.exists(path):
            # A review with no report is either running now or was abandoned
            # months ago. Only the newest can be the former.
            row = {'id': name, 'status': 'no report',
                   'gate': None, 'findings': None, 'ruled': False}
            report['reviews'].append(row)
            if name == names[-1]:
                report['attention'].append(
                    '%s: newest review has no report — still running, or it '
                    'died; check `review status`' % name)
            continue
        try:
            with open(path) as fh:
                d = json.load(fh)
        except ValueError:
            continue
        row = {
            'id': name,
            'status': d.get('status'),
            'gate': (d.get('gate') or {}).get('status'),
            'findings': len(d.get('findings') or []),
            'ruled': bool(d.get('controllerRuling')),
        }
        report['reviews'].append(row)
    return report


def newest_unruled(reviews):
    """Only the most recent unruled review is actionable; older ones were
    adjudicated in the plan before `review rule` was used consistently."""
    done = [r for r in reviews if r.get('status') == 'completed']
    return done[-1] if done and not done[-1].get('ruled') else None


def _collect_with_reviews(orchestration, cwd):
    """Collect status including the unruled-review check.

    Both modes must apply the same attention rules, or --watch sleeps through
    the one thing it exists to catch.
    """
    r = collect(orchestration, cwd)
    stale = newest_unruled(r['reviews'])
    if stale:
        r['attention'].append(
            '%s: completed review with no adapter ruling — `review rule` it '
            'and record the adjudication in the plan' % stale['id'])
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--orchestration', default=DEFAULT_ORCH)
    ap.add_argument('--cwd', default=DEFAULT_CWD)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--watch', action='store_true',
                    help='poll until something needs attention, then report')
    ap.add_argument('--interval', type=int, default=60,
                    help='seconds between polls under --watch (default 60)')
    ap.add_argument('--max-minutes', type=int, default=180,
                    help='give up after this long under --watch (default 180)')
    args = ap.parse_args()

    if args.watch:
        waited = 0
        while waited < args.max_minutes:
            r = _collect_with_reviews(args.orchestration, args.cwd)
            if r['attention']:
                print('ATTENTION after %dm:\n' % waited)
                break
            time.sleep(args.interval)
            waited += max(1, args.interval // 60)
        else:
            print('no change in %dm — the fleet may be stuck; '
                  'check `worker status` directly\n' % args.max_minutes)
            r = _collect_with_reviews(args.orchestration, args.cwd)
        args.watch = False
        return render(r, args)

    return render(_collect_with_reviews(args.orchestration, args.cwd), args)


def render(r, args):
    if args.json:
        print(json.dumps(r, indent=2))
        return 1 if r['attention'] else 0

    c = r['coordinator']
    print('orchestration: %s' % r['orchestration'])
    print('coordinator  : %s | active turns %s | queued %s | workers %s/%s concurrent'
          % (c.get('status'), c.get('activeTurns'), c.get('queuedTurns'),
             c.get('workerCount'), c.get('maxConcurrent')))
    if c.get('active'):
        print('running now  : %s' % ', '.join(c['active']))

    print('\nlive workers (%d; retired and reviewer internals hidden):'
          % len(r['workers']))
    for w in r['workers'][-8:]:
        print('  %-14s base %-8s supervisor %-8s thread %-6s turn %s%s'
              % (w['id'], w['base'], w['supervisor'], w['thread'],
                 w['turn'], '  !! %s' % w['turnError'] if w['turnError'] else ''))

    print('\nreviews (last 5 of %d):' % len(r['reviews']))
    for v in r['reviews'][-5:]:
        print('  %-44s %-10s gate %-16s findings %-3s ruled %s'
              % (v['id'][:44], v.get('status'), v.get('gate'),
                 v.get('findings'), 'yes' if v.get('ruled') else 'NO'))

    if r['attention']:
        print('\nNEEDS YOU (%d):' % len(r['attention']))
        for a in r['attention']:
            print('  - %s' % a)
    else:
        print('\nNothing needs you.')
    return 1 if r['attention'] else 0


if __name__ == '__main__':
    sys.exit(main())
