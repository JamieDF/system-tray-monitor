/*
 * Copyright (C) 2026 JamieDF
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Poller lifecycle.
 *
 * These run a real GLib main loop, which is possible precisely because the
 * poller imports GLib and nothing else. A leaked timeout source is the single
 * most common reason a shell extension is rejected on review, and it is
 * invisible from the outside: the extension still reports INACTIVE while its
 * timer keeps firing. Asserting it here is the only cheap way to know.
 */

import GLib from 'gi://GLib';

import {Poller} from '../src/poller.js';
import {assert, assertEqual, suite, test} from './harness.js';

suite('poller');

/*
 * Timing windows.
 *
 * The poller uses g_timeout_add_seconds, which aligns wakeups to whole second
 * boundaries so the kernel can coalesce them with other timers. That is the
 * power saving this design wants, but it means the first fire can land up to a
 * second later than the nominal interval. Windows here are generous enough to
 * survive that; tightening them produces a flaky suite rather than a faster one.
 */
const ENOUGH_FOR_A_TICK = 2500;
const ENOUGH_TO_SEE_A_LEAK = 2500;

/**
 * Runs the main loop for a fixed period, so a test can observe timer effects.
 *
 * @param {number} ms - milliseconds to run for
 */
function runLoop(ms) {
    const loop = GLib.MainLoop.new(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
}

/**
 * A provider that records how often it was sampled and reset.
 *
 * @param {string} id - provider id
 * @returns {object} stub provider with counters
 */
function stubProvider(id) {
    return {
        id,
        samples: 0,
        resets: 0,
        sample() {
            this.samples++;
            return {value: this.samples};
        },
        reset() {
            this.resets++;
        },
    };
}

test('starts stopped', () => {
    const poller = new Poller({intervalSeconds: 1});
    assertEqual(poller.isRunning, false);
    poller.destroy();
});

test('samples immediately on start, so the panel is not blank', () => {
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    poller.start();
    assertEqual(provider.samples, 1, 'start should take a reading straight away');

    poller.destroy();
});

test('keeps ticking while running', () => {
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    poller.start();
    runLoop(ENOUGH_FOR_A_TICK);

    assert(provider.samples >= 2, `expected repeated sampling, got ${provider.samples}`);
    poller.destroy();
});

test('stop actually removes the timer', () => {
    // The important one. If stop() only flipped a flag, the source would keep
    // firing and the count below would keep climbing.
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    poller.start();
    runLoop(ENOUGH_FOR_A_TICK);
    poller.stop();

    const afterStop = provider.samples;
    runLoop(ENOUGH_TO_SEE_A_LEAK);

    assertEqual(provider.samples, afterStop, 'sampling continued after stop, timer leaked');
    assertEqual(poller.isRunning, false);
    poller.destroy();
});

test('destroy removes the timer too', () => {
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    poller.start();
    poller.destroy();

    const afterDestroy = provider.samples;
    runLoop(ENOUGH_TO_SEE_A_LEAK);

    assertEqual(provider.samples, afterDestroy, 'sampling continued after destroy');
});

test('repeated start does not stack timers', () => {
    // enable() running twice, or a settings change racing a rebuild, must not
    // leave two sources firing. Two timers would double the sample rate.
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    poller.start();
    poller.start();
    poller.start();

    const afterStarts = provider.samples;
    assertEqual(afterStarts, 1, 'only the first start should sample immediately');

    runLoop(ENOUGH_FOR_A_TICK);
    const ticks = provider.samples - afterStarts;
    // One timer over this window fires at most three times. Two stacked timers
    // would roughly double that.
    assert(ticks <= 3, `expected at most 3 ticks from one timer, got ${ticks}`);

    poller.destroy();
});

test('stop clears provider baselines', () => {
    // Rate metrics hold a previous reading. Resuming after a lock with a stale
    // baseline would report the whole locked period as one enormous spike.
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    poller.start();
    poller.stop();

    assert(provider.resets > 0, 'stop should reset providers');
    poller.destroy();
});

test('changing providers resets the new set', () => {
    const first = stubProvider('a');
    const second = stubProvider('b');
    const poller = new Poller({intervalSeconds: 1});

    poller.setProviders([first]);
    poller.setProviders([second]);

    assert(second.resets > 0, 'the incoming set should start from a clean baseline');
    poller.destroy();
});

test('listeners receive readings keyed by provider id', () => {
    const provider = stubProvider('cpu');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    let received = null;
    poller.addListener(readings => {
        received = readings;
    });

    poller.start();

    assert(received !== null, 'listener should have been called');
    assertEqual(received.has('cpu'), true, 'readings should be keyed by id');
    poller.destroy();
});

test('removing a listener stops delivery', () => {
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    let calls = 0;
    const remove = poller.addListener(() => calls++);

    poller.start();
    const afterStart = calls;
    remove();

    poller.refresh();
    assertEqual(calls, afterStart, 'a removed listener should not be called');

    poller.destroy();
});

test('a throwing provider does not kill the timer', () => {
    // One broken provider must not freeze the whole panel.
    //
    // This test deliberately triggers the error path, so running the suite
    // prints a "provider broken failed to sample" stack trace to stderr. That
    // output is expected and is not a failure.
    const broken = {
        id: 'broken',
        sample() {
            throw new Error('deliberate failure');
        },
        reset() {},
    };
    const healthy = stubProvider('healthy');

    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([broken, healthy]);

    let received = null;
    poller.addListener(readings => {
        received = readings;
    });

    poller.start();

    assertEqual(healthy.samples, 1, 'the healthy provider should still be sampled');
    assertEqual(received.get('broken'), null, 'a failed provider should read null');

    runLoop(ENOUGH_FOR_A_TICK);
    assert(healthy.samples >= 2, 'the timer should survive a provider throwing');

    poller.destroy();
});

test('refresh re-sends the last readings without sampling', () => {
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    let calls = 0;
    poller.addListener(() => calls++);

    poller.start();
    const samplesAfterStart = provider.samples;
    const callsAfterStart = calls;

    poller.refresh();

    assertEqual(provider.samples, samplesAfterStart, 'refresh must not sample');
    assertEqual(calls, callsAfterStart + 1, 'refresh should notify listeners once');

    poller.destroy();
});

test('changing the interval while running does not leave the old timer behind', () => {
    const provider = stubProvider('a');
    const poller = new Poller({intervalSeconds: 1});
    poller.setProviders([provider]);

    poller.start();
    poller.setInterval(5);

    assertEqual(poller.intervalSeconds, 5);
    assertEqual(poller.isRunning, true, 'should still be running after a change');

    const afterChange = provider.samples;
    runLoop(ENOUGH_TO_SEE_A_LEAK);

    assertEqual(provider.samples, afterChange,
        'the old 1 second timer is still firing under the new 5 second interval');

    poller.destroy();
});

test('rejects a nonsensical interval rather than spinning', () => {
    const poller = new Poller({intervalSeconds: 2});

    poller.setInterval(0);
    assertEqual(poller.intervalSeconds, 2, 'zero should be ignored');

    poller.setInterval(-1);
    assertEqual(poller.intervalSeconds, 2, 'negative should be ignored');

    poller.setInterval(NaN);
    assertEqual(poller.intervalSeconds, 2, 'NaN should be ignored');

    poller.destroy();
});
